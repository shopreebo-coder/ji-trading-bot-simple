"use strict";
/**
 * SHADOW OS v2 — Selected Engine (READ-ONLY intelligence orchestration).
 *
 * The Selected Engine is a pure AGGREGATION + ORCHESTRATION layer. For a given
 * Live signal it collects the opinions of every Shadow Engine (from the recorded
 * research tables) plus the Knowledge Layer, builds ONE normalized
 * DecisionContext, ranks the available intelligence, and exposes telemetry.
 *
 * WHAT IT NEVER DOES (sacred constraints):
 *   • It NEVER executes, sizes, gates, or influences a trade.
 *   • It NEVER modifies or overrides a Live Bot / Shadow / Risk decision.
 *   • It NEVER writes to any live/shadow/knowledge table (no migration, no DDL).
 *   • It NEVER blocks trading — every DB call is best-effort try/catch.
 *
 * HOW IT STAYS READ-ONLY & SAFE:
 *   • It reads ALREADY-RECORDED engine evaluations from shadow_engine_evals
 *     (populated by ShadowLabManager) rather than re-invoking the live engines,
 *     which hold internal caches — re-invocation would duplicate stateful work.
 *   • It uses ONLY db.get/db.all — never pool.connect() — so the CAS pool
 *     deadlock (replit.md) is impossible by construction.
 *   • Engines are auto-discovered (SELECT DISTINCT engine_id + optional plugin
 *     dir); Knowledge domains are auto-discovered by grouping listActive().
 *     Adding Engine E/F/G or a new Knowledge domain requires ZERO changes here.
 *
 * DecisionContexts are DERIVED, fully reproducible views — kept in an in-memory
 * ring buffer with a DETERMINISTIC id (checksum of signal + eval ids + artifact
 * versions + snapshot checksum). No persistence, so nothing accumulated can be
 * destroyed. The background poll (start()) is flag-gated by the caller and uses
 * an unref'd timer, so flag-OFF is a complete no-op.
 */

const path = require("path");
const { KnowledgeRepository } = require("./KnowledgeRepository");
const {
  createProvenance,
  checksumValue,
  SYSTEM_VERSION,
} = require("./knowledgeProvenance");
const {
  numOrNull,
  boolOrNull,
  confidenceToScore,
  scoreToTier,
  rankIntelligence,
  RANKING_CRITERIA,
  computeConsensus,
} = require("./selected/ranking");
const { discoverEngines, loadCustomPlugins, parseJson } = require("./selected/enginePlugins");

const DEFAULT_RING = 200;
const DEFAULT_POLL_MS = 15 * 60 * 1000; // 15 min, matches the Knowledge Layer cadence

/**
 * DecisionContext contract version. DecisionContext is the canonical event object
 * of the platform; downstream consumers (Decision Intelligence, Confidence
 * Engine, Adaptive Risk Engine, Meta Learning) branch on this. Bump ONLY on a
 * breaking shape change — additive fields do not require a bump.
 */
const SCHEMA_VERSION = 1;

/** Recursively freeze an object graph (used to make the EvidenceTrace immutable). */
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/** Milliseconds since epoch for a timestamp-ish value, or null. */
function tsMs(t) {
  if (t === null || t === undefined || t === "") return null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** First non-nullish value among the given keys of obj. */
function pick(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    if (obj[k] !== null && obj[k] !== undefined) return obj[k];
  }
  return null;
}

/** Most frequent non-null value in an array, or null. */
function modeOf(arr) {
  const counts = new Map();
  let best = null, bestN = 0;
  for (const v of arr) {
    if (v === null || v === undefined) continue;
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

class SelectedEngineManager {
  constructor(opts = {}) {
    if (!opts.db) throw new Error("SelectedEngineManager requires a db adapter");
    this.db = opts.db;
    // Dependency inversion: depend on read-only abstractions. Default to a
    // freshly constructed (cheap, read-only) KnowledgeRepository if none given.
    this.knowledge = opts.knowledge || new KnowledgeRepository({ db: opts.db });
    this.shadowLab = opts.shadowLab || null; // optional expectancy provider
    this.provenance = opts.provenance || createProvenance();
    this.log = opts.logger || { info() {}, error() {} };
    this.ringSize = Number(opts.ringSize) > 0 ? Number(opts.ringSize) : DEFAULT_RING;
    this.pollIntervalMs = Number(opts.pollIntervalMs) > 0 ? Number(opts.pollIntervalMs) : DEFAULT_POLL_MS;
    this.pluginDir = opts.pluginDir || path.join(__dirname, "selected", "engines");

    this._ring = [];
    this._byId = new Map();
    this._customPlugins = null; // cached fs-scan of the plugin dir
    this._timer = null;
    this._running = false;
    this._lastResult = null;
    this._stats = { builds: 0, lastBuildAt: null, lastError: null };
  }

  _info(m) { try { this.log.info(m); } catch (_) {} }
  _error(m) { try { this.log.error(m); } catch (_) {} }

  // ── Discovery ──────────────────────────────────────────────────────────────

  _customPluginList() {
    if (this._customPlugins === null) {
      try { this._customPlugins = loadCustomPlugins(this.pluginDir); }
      catch (_) { this._customPlugins = []; }
    }
    return this._customPlugins;
  }

  async _loadEngines() {
    try {
      return await discoverEngines(this.db, {
        pluginDir: this.pluginDir,
        customPlugins: this._customPluginList(),
      });
    } catch (e) {
      this._error(`[SELECTED] engine discovery failed: ${e.message}`);
      return [];
    }
  }

  /** Auto-discover the active Knowledge set, grouped dynamically by domain. */
  async loadKnowledge() {
    let active = [];
    try {
      active = typeof this.knowledge.listActive === "function"
        ? await this.knowledge.listActive()
        : (typeof this.knowledge.listArtifacts === "function" ? await this.knowledge.listArtifacts() : []);
    } catch (e) {
      this._error(`[SELECTED] knowledge listActive failed: ${e.message}`);
      active = [];
    }
    const domains = {};
    let maxVersion = null;
    for (const r of (active || [])) {
      const domain = r.domain;
      const version = numOrNull(r.version);
      (domains[domain] = domains[domain] || []).push({
        id: r.id,
        artifact: r.artifact,
        version,
        checksum: r.checksum,
        trainingEvents: numOrNull(r.training_events),
        confidence: numOrNull(r.confidence),
        createdAt: r.created_at || null,
      });
      if (version !== null && (maxVersion === null || version > maxVersion)) maxVersion = version;
    }
    let snapshot = null;
    try {
      const snaps = typeof this.knowledge.listSnapshots === "function" ? await this.knowledge.listSnapshots(1) : [];
      snapshot = (snaps && snaps[0]) || null;
    } catch (_) { snapshot = null; }
    return { domains, count: (active || []).length, maxVersion, snapshot };
  }

  // ── Raw research reads (all best-effort) ─────────────────────────────────────

  async _getSignal(signalId) {
    try {
      if (signalId) {
        return await this.db.get(
          "SELECT * FROM shadow_signals WHERE signal_id = ? ORDER BY id DESC LIMIT 1", signalId
        );
      }
      return await this.db.get("SELECT * FROM shadow_signals ORDER BY id DESC LIMIT 1");
    } catch (e) {
      this._error(`[SELECTED] _getSignal failed: ${e.message}`);
      return null;
    }
  }

  async _getEvals(signalId) {
    try {
      return await this.db.all(
        "SELECT * FROM shadow_engine_evals WHERE signal_id = ? ORDER BY engine_id ASC", signalId
      );
    } catch (e) {
      this._error(`[SELECTED] _getEvals failed: ${e.message}`);
      return [];
    }
  }

  async _getOutcome(signalId) {
    try {
      return await this.db.get(
        "SELECT * FROM shadow_outcomes WHERE signal_id = ? ORDER BY id DESC LIMIT 1", signalId
      );
    } catch (_) { return null; }
  }

  async _loadExpectancy(symbol) {
    const out = { all: null, symbol: null };
    if (!this.shadowLab || typeof this.shadowLab.getExpectancy !== "function") return out;
    try { out.all = await this.shadowLab.getExpectancy("ALL"); } catch (_) {}
    if (symbol) { try { out.symbol = await this.shadowLab.getExpectancy(symbol); } catch (_) {} }
    return out;
  }

  // ── Core: build one DecisionContext ──────────────────────────────────────────

  /**
   * Build a normalized DecisionContext for a signal (defaults to the latest
   * recorded signal). Pure aggregation — reads only, never writes any DB table.
   * @param {{signalId?:string}} [args]
   * @returns {Promise<object>} the DecisionContext (also stored in the ring)
   */
  async buildDecisionContext(args = {}) {
    const generated = new Date().toISOString();
    const signal = await this._getSignal(args.signalId);
    if (!signal) return this._emptyContext(generated, args.signalId);

    const sid = signal.signal_id;
    const symbol = signal.symbol || null;

    const [evals, outcome, engines, knowledge] = await Promise.all([
      this._getEvals(sid),
      this._getOutcome(sid),
      this._loadEngines(),
      this.loadKnowledge(),
    ]);
    const expectancy = await this._loadExpectancy(symbol);

    // Index recorded evals by engine for this signal.
    const evalById = {};
    const evalIds = [];
    for (const ev of evals) {
      evalById[String(ev.engine_id)] = ev;
      const n = numOrNull(ev.id);
      if (n !== null) evalIds.push(n);
    }
    evalIds.sort((a, b) => a - b);

    // Per-engine opinions via the auto-discovered plugins (dynamic).
    const engineOpinions = {};
    const rankingRecords = [];
    for (const desc of engines) {
      const { engineId, plugin } = desc;
      let opinion;
      try {
        opinion = plugin.analyze({ evalRow: evalById[engineId] || null, signal, knowledge });
      } catch (e) {
        opinion = { engineId, present: false, wouldTrade: null, error: e.message, confidence: null, confidenceScore: null };
      }
      engineOpinions[engineId] = opinion;
      rankingRecords.push({
        source: `engine:${engineId}`,
        kind: "engine",
        confidence: numOrNull(opinion.confidenceScore),
        expectancy: numOrNull(opinion.historicalExpectancy),
        trainingEvents: 0,
        version: null,
        freshness: evalById[engineId] ? tsMs(evalById[engineId].created_at) : null,
        detail: opinion,
      });
    }

    // Knowledge artifacts as ranking records (dynamic across all domains).
    for (const [domain, arts] of Object.entries(knowledge.domains)) {
      for (const a of arts) {
        rankingRecords.push({
          source: `knowledge:${domain}/${a.artifact}`,
          kind: "knowledge",
          confidence: numOrNull(a.confidence),
          expectancy: null,
          trainingEvents: numOrNull(a.trainingEvents) ?? 0,
          version: numOrNull(a.version),
          freshness: tsMs(a.createdAt),
          detail: { domain, artifact: a.artifact, version: a.version, checksum: a.checksum },
        });
      }
    }

    // Expectancy (Shadow LAB) as a ranking record.
    if (expectancy.all) {
      rankingRecords.push({
        source: "expectancy:ALL",
        kind: "expectancy",
        confidence: confidenceToScore(pick(expectancy.all, "confidenceLevel", "confidence_level")),
        expectancy: numOrNull(pick(expectancy.all, "expectancyPips", "expectancy_pips")),
        trainingEvents: numOrNull(pick(expectancy.all, "resolvedTrades", "resolved_trades")) ?? 0,
        version: null,
        freshness: null, // DETERMINISM: never feed wall-clock (`generated`) into a ranking key
        detail: expectancy.all,
      });
    }

    const ranked = rankIntelligence(rankingRecords);

    // Tri-state consensus over the engine opinions (abstain excluded).
    const consensus = computeConsensus(
      Object.values(engineOpinions).map((o) => ({ engineId: o.engineId, wouldTrade: o.wouldTrade }))
    );

    // Aggregate confidence across engines that expressed one.
    const confScores = Object.values(engineOpinions)
      .map((o) => numOrNull(o.confidenceScore))
      .filter((x) => x !== null);
    const avgConf = confScores.length
      ? Math.round((confScores.reduce((a, b) => a + b, 0) / confScores.length) * 1e6) / 1e6
      : null;
    const confidence = {
      average: avgConf,
      tier: scoreToTier(avgConf),
      perEngine: Object.fromEntries(Object.values(engineOpinions).map((o) => [o.engineId, o.confidence || null])),
    };

    // Market / patterns (dynamic knowledge domains + engine market states).
    const marketStates = Object.values(engineOpinions).map((o) => o.marketState).filter(Boolean);
    const market = {
      states: marketStates,
      dominant: modeOf(marketStates),
      knowledge: knowledge.domains.market || [],
    };
    const patterns = knowledge.domains.patterns || [];

    // Deterministic, reproducible context id.
    const artifactVersions = {};
    for (const [domain, arts] of Object.entries(knowledge.domains)) {
      for (const a of arts) artifactVersions[`${domain}/${a.artifact}`] = a.version;
    }
    const snapshotChecksum = knowledge.snapshot
      ? (knowledge.snapshot.manifest_checksum || knowledge.snapshot.checksum || null)
      : null;
    const id = checksumValue({ signalId: sid, evalIds, artifactVersions, snapshotChecksum });

    const selectedSources = ranked.map((r) => ({
      source: r.source, kind: r.kind, confidence: r.confidence, expectancy: r.expectancy,
    }));

    const knowledgeVersion = knowledge.maxVersion;
    const snapshotVersion = knowledge.snapshot
      ? { id: knowledge.snapshot.id, checksum: snapshotChecksum, createdAt: knowledge.snapshot.created_at || null }
      : null;

    const selectedReason = this._buildReason(consensus, ranked, confidence);

    // ── EvidenceTrace ──────────────────────────────────────────────────────────
    // An IMMUTABLE, REPRODUCIBLE record of exactly why the intelligence was ranked
    // in this order. Its checksum is deterministic: it deliberately EXCLUDES all
    // wall-clock (`generated`) and freshness-ms values, so identical inputs ⇒
    // identical trace ⇒ identical traceChecksum across rebuilds and processes.
    const marketFingerprint = {
      setupId: signal.fingerprint || null,
      trendBucket: signal.trend_bucket || null,
      volatilityBucket: signal.volatility_bucket || null,
      spreadBucket: signal.spread_bucket || null,
    };
    const traceRecords = ranked.map((r, idx) => ({
      rank: idx + 1,
      source: r.source,
      kind: r.kind,
      confidence: numOrNull(r.confidence),
      expectancy: numOrNull(r.expectancy),
      trainingEvents: numOrNull(r.trainingEvents),
      version: numOrNull(r.version),
    }));
    const traceArtifacts = [];
    for (const [domain, arts] of Object.entries(knowledge.domains)) {
      for (const a of arts) {
        traceArtifacts.push({
          source: `knowledge:${domain}/${a.artifact}`,
          id: a.id ?? null,
          version: numOrNull(a.version),
          checksum: a.checksum || null,
          confidence: numOrNull(a.confidence),
          trainingEvents: numOrNull(a.trainingEvents),
        });
      }
    }
    // NOTE: deepFreeze below is recursive, so every structure placed in the trace
    // basis becomes immutable. COPY anything shared with the rest of the context
    // (consensus arrays are also exposed as ctx.consensusDetail; marketFingerprint
    // and artifactVersions are reused in explainability) so freezing the trace can
    // never freeze — and thus never make strict-mode-throw — those live references.
    const traceBasis = {
      signalId: sid,
      evalIds: [...evalIds],
      engineIds: engines.map((d) => d.engineId),
      consensus: {
        consensus: consensus.consensus,
        agreeing: [...consensus.agreeing],
        dissenting: [...consensus.dissenting],
        abstaining: [...consensus.abstaining],
        decided: consensus.decided,
      },
      marketFingerprint: { ...marketFingerprint },
      rankingCriteria: RANKING_CRITERIA, // already deep-frozen module constant; embedded verbatim
      records: traceRecords,
      artifacts: traceArtifacts,
      artifactVersions: { ...artifactVersions },
      snapshotChecksum,
    };
    const traceChecksum = checksumValue(traceBasis);
    const evidenceTrace = deepFreeze({ ...traceBasis, contextId: id, checksum: traceChecksum });

    // ── Explainability ─────────────────────────────────────────────────────────
    // One stable, read-only surface exposing everything a downstream consumer
    // needs to explain a decision: selected sources, the selection reason, the
    // confidence chain, the knowledge versions in play, and an evidence summary
    // (pointer to the reproducible EvidenceTrace above).
    const explainability = {
      selectedSources,
      selectionReason: selectedReason,
      confidenceChain: {
        average: confidence.average,
        tier: confidence.tier,
        perEngine: confidence.perEngine,
      },
      knowledgeVersions: {
        max: knowledgeVersion,
        snapshot: snapshotVersion,
        artifacts: artifactVersions,
      },
      evidenceSummary: {
        traceChecksum,
        topSources: ranked.slice(0, 3).map((r) => r.source),
        engineIds: engines.map((d) => d.engineId),
        consensus: consensus.consensus,
        marketFingerprint,
      },
    };

    const liveSignal = {
      signalId: sid,
      symbol,
      side: signal.side || null,
      session: signal.session || null,
      fingerprint: signal.fingerprint || null,
      entryGate: signal.entry_gate || null,
      passCount: numOrNull(signal.pass_count),
      spread: numOrNull(signal.spread),
      atrPips: numOrNull(signal.atr_pips),
      emaDistance: numOrNull(signal.ema_distance),
      candleStrength: numOrNull(signal.candle_strength),
      trendBucket: signal.trend_bucket || null,
      volatilityBucket: signal.volatility_bucket || null,
      spreadBucket: signal.spread_bucket || null,
      liveWouldTrade: boolOrNull(signal.live_would_trade),
      sourceTs: signal.source_ts || null,
      createdAt: signal.created_at || null,
      features: parseJson(signal.features),
    };

    const metadata = {
      generated,
      contextId: id,
      engineCount: engines.length,
      engineIds: engines.map((d) => d.engineId),
      knowledgeDomains: Object.keys(knowledge.domains),
      knowledgeCount: knowledge.count,
      knowledgeVersion,
      snapshotVersion,
      resolved: !!outcome,
      outcome: outcome ? {
        profitPips: numOrNull(outcome.profit_pips),
        mfe: numOrNull(outcome.mfe),
        mae: numOrNull(outcome.mae),
        durationMin: numOrNull(outcome.duration_min),
      } : null,
      selectedSources,
      provenance: {
        runId: this.provenance.runId,
        buildId: this.provenance.buildId,
        configHash: this.provenance.configHash,
      },
      systemVersion: SYSTEM_VERSION,
    };

    const ctx = {
      schemaVersion: SCHEMA_VERSION,
      id,
      timestamp: signal.created_at || generated,
      symbol,
      setupId: signal.fingerprint || sid,
      liveSignal,
      engines: engineOpinions,
      ...this._engineAliases(engineOpinions),
      knowledge: knowledge.domains,
      confidence,
      expectancy: { all: expectancy.all, symbol: expectancy.symbol, knowledge: knowledge.domains.expectancy || [] },
      market,
      patterns,
      agreementScore: consensus.agreementScore,
      disagreementScore: consensus.disagreementScore,
      consensus: consensus.consensus,
      consensusDetail: consensus,
      selectedReason,
      explainability,
      ranking: ranked,
      evidenceTrace,
      metadata,
    };

    this._store(ctx);
    this._stats.builds += 1;
    this._stats.lastBuildAt = generated;
    this._lastResult = {
      id, consensus: consensus.consensus, agreementScore: consensus.agreementScore, builtAt: generated,
    };
    return ctx;
  }

  /** Named shadowA/shadowB/... aliases generated dynamically from engine ids. */
  _engineAliases(engineOpinions) {
    const out = {};
    for (const [engineId, opinion] of Object.entries(engineOpinions)) {
      out[`shadow${engineId}`] = opinion;
    }
    return out;
  }

  _buildReason(consensus, ranked, confidence) {
    const parts = [];
    if (consensus.decided === 0) {
      parts.push("no engine committed (all abstained)");
    } else {
      const pct = consensus.agreementScore == null ? "?" : `${consensus.agreementScore}%`;
      parts.push(`consensus=${consensus.consensus} (${consensus.agreeing.length}/${consensus.decided} decided agree, ${pct})`);
    }
    if (consensus.abstaining.length) parts.push(`abstain=[${consensus.abstaining.join(",")}]`);
    if (confidence && confidence.tier) parts.push(`confidence=${confidence.tier}`);
    const top = ranked.slice(0, 3).map((r) => r.source);
    if (top.length) parts.push(`top=[${top.join(", ")}]`);
    return parts.join("; ");
  }

  _emptyContext(generated, signalId) {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: null,
      timestamp: generated,
      symbol: null,
      setupId: null,
      liveSignal: null,
      engines: {},
      knowledge: {},
      confidence: null,
      expectancy: null,
      market: null,
      patterns: [],
      agreementScore: null,
      disagreementScore: null,
      consensus: "NO_DATA",
      consensusDetail: { votesFor: 0, votesAgainst: 0, abstain: 0, decided: 0, agreeing: [], dissenting: [], abstaining: [] },
      selectedReason: signalId ? `no signal recorded for id ${signalId}` : "no signals recorded yet",
      explainability: null,
      ranking: [],
      evidenceTrace: null,
      metadata: { generated, note: "no signal" },
    };
  }

  // ── Ring buffer ──────────────────────────────────────────────────────────────

  _store(ctx) {
    if (!ctx || ctx.id == null) return;
    const existingIdx = this._ring.findIndex((c) => c.id === ctx.id);
    if (existingIdx >= 0) {
      this._ring[existingIdx] = ctx;
    } else {
      this._ring.push(ctx);
      while (this._ring.length > this.ringSize) {
        const old = this._ring.shift();
        if (old && !this._ring.some((c) => c.id === old.id)) this._byId.delete(old.id);
      }
    }
    this._byId.set(ctx.id, ctx);
  }

  getLatest() { return this._ring.length ? this._ring[this._ring.length - 1] : null; }

  getContext(id) { return (id != null && this._byId.get(id)) || null; }

  listContexts(limit = 50) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), this.ringSize);
    return this._ring.slice(-n).reverse().map((c) => ({
      id: c.id,
      timestamp: c.timestamp,
      symbol: c.symbol,
      setupId: c.setupId,
      consensus: c.consensus,
      agreementScore: c.agreementScore,
      disagreementScore: c.disagreementScore,
      confidence: c.confidence ? c.confidence.tier : null,
    }));
  }

  // ── Telemetry / status (read-only) ───────────────────────────────────────────

  _telemetry(ctx) {
    if (!ctx) return null;
    return {
      decisionContextId: ctx.id,
      timestamp: ctx.timestamp,
      symbol: ctx.symbol,
      consensus: ctx.consensus,
      agreementScore: ctx.agreementScore,
      disagreementScore: ctx.disagreementScore,
      confidence: ctx.confidence ? ctx.confidence.tier : null,
      confidenceScore: ctx.confidence ? ctx.confidence.average : null,
      knowledgeVersion: ctx.metadata ? ctx.metadata.knowledgeVersion : null,
      snapshotVersion: ctx.metadata ? ctx.metadata.snapshotVersion : null,
      selectedSources: ctx.metadata ? ctx.metadata.selectedSources : [],
      engineCount: ctx.metadata ? ctx.metadata.engineCount : 0,
    };
  }

  async getStatus() {
    const [engines, knowledge] = await Promise.all([this._loadEngines(), this.loadKnowledge()]);
    const latest = this.getLatest();
    return {
      running: this._running,
      ring: { size: this._ring.length, capacity: this.ringSize },
      engineCount: engines.length,
      engines: engines.map((d) => ({ ...d.plugin.metadata(), custom: d.custom })),
      knowledgeDomains: Object.keys(knowledge.domains),
      knowledgeCount: knowledge.count,
      knowledgeVersion: knowledge.maxVersion,
      snapshot: knowledge.snapshot
        ? { id: knowledge.snapshot.id, checksum: knowledge.snapshot.manifest_checksum || knowledge.snapshot.checksum || null, createdAt: knowledge.snapshot.created_at || null }
        : null,
      stats: this._stats,
      telemetry: this._telemetry(latest),
      systemVersion: SYSTEM_VERSION,
      provenance: {
        runId: this.provenance.runId,
        buildId: this.provenance.buildId,
        configHash: this.provenance.configHash,
      },
    };
  }

  async listEngines() {
    const engines = await this._loadEngines();
    return engines.map((d) => ({ ...d.plugin.metadata(), custom: d.custom }));
  }

  // ── Lifecycle (flag-gated by the caller) ─────────────────────────────────────

  /** Start the read-only background refresh (unref'd timer). Idempotent. */
  async start() {
    if (this._running) return this;
    this._running = true;
    this._info("[SELECTED] selected engine starting (read-only) — building now");
    await this.buildDecisionContext({}).catch((e) => this._error(`[SELECTED] initial build failed: ${e.message}`));
    this._timer = setInterval(() => {
      this.buildDecisionContext({}).catch((e) => this._error(`[SELECTED] scheduled build failed: ${e.message}`));
    }, this.pollIntervalMs);
    if (this._timer.unref) this._timer.unref(); // never keep the process alive
    return this;
  }

  /** Stop the background refresh. Idempotent. Does not close the shared pool. */
  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

module.exports = { SelectedEngineManager };
