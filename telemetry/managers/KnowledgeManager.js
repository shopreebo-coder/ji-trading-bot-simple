"use strict";
/**
 * SHADOW OS v2 — Sprint 6: KnowledgeManager (READ-ONLY Knowledge Layer)
 *
 * Turns the measured research produced by the Shadow LAB (Sprint 5) into
 * organized, versioned, immutable, provenance-stamped KNOWLEDGE. It is the
 * long-term learned-intelligence layer of SHADOW OS v2.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SACRED BOUNDARY — the Knowledge Layer NEVER influences live trading.
 *   • It READS ONLY the Shadow LAB research tables (shadow_signals,
 *     shadow_engine_evals, shadow_outcomes, shadow_expectancy_snapshots) plus
 *     the shared provenance/config surface.
 *   • It WRITES ONLY its own tables (knowledge_artifacts, knowledge_snapshots).
 *   • Nothing it produces is ever read back by a live or shadow decision. The
 *     FROZEN entrypoint (index.js) is never touched. This is a measurement /
 *     organization layer, exactly like the Shadow LAB — one level up.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Seven knowledge builders, each a pure SQL aggregation (never pulls raw rows
 * into JS) over the Shadow LAB tables:
 *   expectancy/history     — expectancy time series rolled up per scope
 *   engines/statistics     — per-engine agreement / abstention / measured winrate
 *   patterns/validated     — market patterns (bucket combos) with realized edge
 *   market/fingerprints    — fingerprint catalog (identity + occurrence + edge)
 *   config/history         — every config_hash observed + the current surface
 *   confidence/history     — confidence-tier progression per scope
 *   experiments/metadata   — one row per experiment run (run_id) + build/config
 *
 * Orchestration:
 *   snapshotAll() runs all builders sequentially (awaited, best-effort per
 *   builder), versions each artifact idempotently (content checksum), then
 *   records a knowledge_snapshots manifest of the active set. start() schedules
 *   snapshotAll() on an unref'd timer; the manager is a single writer guarded by
 *   `_building`. Every step is wrapped so a knowledge failure can NEVER surface
 *   into the trading process. No signal handlers are installed here.
 */

const { KnowledgeRepository } = require("./KnowledgeRepository");
const {
  createProvenance,
  buildConfigSurface,
  confidenceLevel,
  checksumValue,
  CONFIDENCE_THRESHOLDS,
  SYSTEM_VERSION,
} = require("./knowledgeProvenance");

// Default rebuild cadence — knowledge is a coarse, accumulated snapshot of
// learning, not a per-tick stream. 15 minutes bounds version growth while still
// capturing meaningful change quickly. Overridable for tests.
const DEFAULT_POLL_MS = 15 * 60 * 1000;

// A pattern is "validated" once it has at least a MEDIUM sample of resolved
// outcomes AND a positive realized expectancy.
const VALIDATION_MIN_SAMPLE = CONFIDENCE_THRESHOLDS.MEDIUM_MIN; // 30

// Cap list-shaped artifacts so a single artifact can never grow unbounded.
const MAX_ROWS = 500;

// The knowledge artifact catalog. Each entry maps a (domain, artifact) identity
// to the builder method that produces its content.
const ARTIFACTS = Object.freeze([
  { domain: "expectancy",  artifact: "history",      build: "_buildExpectancyHistory" },
  { domain: "engines",     artifact: "statistics",   build: "_buildEngineStatistics" },
  { domain: "patterns",    artifact: "validated",    build: "_buildValidatedPatterns" },
  { domain: "market",      artifact: "fingerprints", build: "_buildMarketFingerprints" },
  { domain: "config",      artifact: "history",      build: "_buildConfigHistory" },
  { domain: "confidence",  artifact: "history",      build: "_buildConfidenceHistory" },
  { domain: "experiments", artifact: "metadata",     build: "_buildExperimentMetadata" },
]);

// ── null-safe coercion helpers (respect the "Number(null) === 0" trap) ────────
function numOrNull(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function intOr0(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}
function rate(wins, total) {
  const t = intOr0(total);
  return t > 0 ? intOr0(wins) / t : null;
}
// Stable timestamp representation so checksums don't drift on driver quirks.
function toIso(x) {
  if (x === null || x === undefined) return null;
  if (x instanceof Date) return x.toISOString();
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? String(x) : d.toISOString();
}

class KnowledgeManager {
  /**
   * @param {object} opts
   * @param {object}  [opts.db]              db-adapter (required unless repository given)
   * @param {object}  [opts.repository]      KnowledgeRepository (mainly for tests)
   * @param {object}  [opts.provenance]      provenance context (default createProvenance())
   * @param {number}  [opts.pollIntervalMs]  rebuild cadence (default 15m)
   * @param {string}  [opts.domainPrefix]    isolate artifact identities (tests only; default "")
   * @param {{info?:Function, error?:Function}} [opts.logger]
   */
  constructor(opts = {}) {
    const { db, repository, provenance, pollIntervalMs, domainPrefix, logger } = opts;
    if (!db && !repository) throw new Error("KnowledgeManager requires a db adapter or a repository");
    this.db = db;
    this.repo = repository || new KnowledgeRepository({ db });
    this.provenance = provenance || createProvenance();
    this.pollIntervalMs = pollIntervalMs || DEFAULT_POLL_MS;
    this.domainPrefix = domainPrefix || "";
    this.log = {
      info: (logger && logger.info) || ((m) => console.log(m)),
      error: (logger && logger.error) || ((m) => console.error(m)),
    };
    this._timer = null;
    this._running = false;
    this._building = false; // single-writer guard
    this._lastResult = null;
  }

  // ── Orchestration ──────────────────────────────────────────────────────────

  /**
   * Build/refresh every knowledge artifact, then record a manifest snapshot.
   * Idempotent: unchanged content is a no-op; changed content mints a new
   * immutable version. Best-effort per builder — one failure never aborts the run.
   */
  async snapshotAll() {
    if (this._building) return { skipped: true, reason: "already-building" };
    this._building = true;
    const startedAt = Date.now();
    const results = [];
    try {
      for (const spec of ARTIFACTS) {
        const domain = this.domainPrefix + spec.domain;
        try {
          const built = await this[spec.build]();
          if (!built || built.content == null) {
            results.push({ domain, artifact: spec.artifact, skipped: true, reason: "no-data" });
            continue;
          }
          const res = await this.repo.upsertVersion(
            domain, spec.artifact, built.content, this.provenance, built.meta || {}
          );
          if (res.reason === "reverted-to-prior" || res.reason === "cas-miss" || res.reason === "conflict") {
            this.log.info(`[KNOWLEDGE] ${domain}/${spec.artifact}: ${res.reason} (no-op)`);
          }
          results.push({ domain, artifact: spec.artifact, ...res });
        } catch (e) {
          this.log.error(`[KNOWLEDGE] builder ${domain}/${spec.artifact} failed: ${e.message}`);
          results.push({ domain, artifact: spec.artifact, error: e.message });
        }
      }

      let snapshot = null;
      try {
        const active = await this.repo.listActive();
        snapshot = await this.repo.insertSnapshot(active, this.provenance);
      } catch (e) {
        this.log.error(`[KNOWLEDGE] snapshot manifest failed: ${e.message}`);
        snapshot = { error: e.message };
      }

      const changed = results.filter((r) => r.changed).length;
      const summary = { ok: true, durationMs: Date.now() - startedAt, changed, results, snapshot };
      this._lastResult = { at: new Date().toISOString(), ...summary };
      return summary;
    } finally {
      this._building = false;
    }
  }

  /** Start the background builder (read-only). No-op if already running. */
  async start() {
    if (this._running) return;
    this._running = true;
    this.log.info("[KNOWLEDGE] knowledge layer starting (read-only) — building now");
    await this.snapshotAll().catch((e) => this.log.error(`[KNOWLEDGE] initial build failed: ${e.message}`));
    this._timer = setInterval(() => {
      this.snapshotAll().catch((e) => this.log.error(`[KNOWLEDGE] scheduled build failed: ${e.message}`));
    }, this.pollIntervalMs);
    if (this._timer.unref) this._timer.unref(); // never keep the process alive
  }

  /** Stop the background builder. */
  stop() {
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // ── Read API (all read-only) ─────────────────────────────────────────────

  async getStatistics() {
    const stats = await this.repo.statistics();
    return {
      ...stats,
      lastBuild: this._lastResult,
      systemVersion: SYSTEM_VERSION,
      provenance: {
        runId: this.provenance.runId,
        buildId: this.provenance.buildId,
        configHash: this.provenance.configHash,
      },
    };
  }

  async listArtifacts() {
    return this.repo.listActive();
  }

  async getArtifact(domain, artifact, opts = {}) {
    if (opts.history) {
      return { domain, artifact, history: await this.repo.getHistory(domain, artifact) };
    }
    if (opts.version != null) {
      return this.repo.getVersion(domain, artifact, opts.version);
    }
    return this.repo.getActive(domain, artifact);
  }

  async listSnapshots(limit) {
    return this.repo.listSnapshots(limit);
  }

  /** Full read-only export bundle of the active knowledge set. */
  async exportAll() {
    const rows = await this.repo.exportActive();
    const artifacts = rows.map((r) => ({
      domain: r.domain,
      artifact: r.artifact,
      version: Number(r.version),
      checksum: r.checksum,
      byteSize: Number(r.byte_size),
      trainingEvents: Number(r.training_events),
      confidence: numOrNull(r.confidence),
      provenance: {
        runId: r.run_id,
        buildId: r.build_id,
        configHash: r.config_hash,
        windowFrom: r.source_window_from,
        windowTo: r.source_window_to,
      },
      createdAt: toIso(r.created_at),
      value: typeof r.value === "string" ? JSON.parse(r.value) : r.value,
    }));
    const bundleContent = artifacts.map((a) => ({
      domain: a.domain, artifact: a.artifact, version: a.version, checksum: a.checksum,
    }));
    return {
      generatedAt: new Date().toISOString(),
      systemVersion: SYSTEM_VERSION,
      provenance: {
        runId: this.provenance.runId,
        buildId: this.provenance.buildId,
        configHash: this.provenance.configHash,
      },
      artifactCount: artifacts.length,
      bundleChecksum: checksumValue(bundleContent),
      artifacts,
    };
  }

  // ── Builders (pure SQL aggregation over Shadow LAB tables) ────────────────

  async _buildExpectancyHistory() {
    const perScope = await this.db.all(
      `SELECT scope, COUNT(*) AS points, MAX(resolved_trades) AS max_resolved,
              MIN(created_at) AS first_at, MAX(created_at) AS last_at
         FROM shadow_expectancy_snapshots
        GROUP BY scope`
    );
    if (!perScope.length) return null;
    const latest = await this.db.all(
      `SELECT DISTINCT ON (scope) scope, resolved_trades, wins, losses, total_profit_pips,
              expectancy_pips, profit_factor, confidence_level, window_from, window_to, created_at
         FROM shadow_expectancy_snapshots
        ORDER BY scope, created_at DESC, id DESC`
    );
    const latestByScope = new Map(latest.map((r) => [r.scope, r]));
    const scopes = perScope
      .map((p) => {
        const l = latestByScope.get(p.scope) || {};
        return {
          scope: p.scope,
          points: intOr0(p.points),
          maxResolved: intOr0(p.max_resolved),
          firstAt: toIso(p.first_at),
          lastAt: toIso(p.last_at),
          latest: {
            resolvedTrades: intOr0(l.resolved_trades),
            wins: intOr0(l.wins),
            losses: intOr0(l.losses),
            totalProfitPips: numOrNull(l.total_profit_pips),
            expectancyPips: numOrNull(l.expectancy_pips),
            profitFactor: numOrNull(l.profit_factor),
            confidenceLevel: l.confidence_level ?? null,
            windowFrom: l.window_from ?? null,
            windowTo: l.window_to ?? null,
            at: toIso(l.created_at),
          },
        };
      })
      .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));

    const all = scopes.find((s) => s.scope === "ALL");
    const resolvedRow = await this.db.get(
      `SELECT COUNT(DISTINCT signal_id) AS n
         FROM shadow_outcomes
        WHERE COALESCE(outcome->>'testSimulation', 'false') <> 'true'`
    );
    const currentResolvedOutcomes = intOr0(resolvedRow?.n);
    const currentConfidenceLevel = confidenceLevel(currentResolvedOutcomes);
    return {
      content: {
        source: "shadow_expectancy_snapshots",
        scopeCount: scopes.length,
        scopes,
        currentResolvedOutcomes,
        currentConfidenceLevel,
      },
      meta: {
        trainingEvents: currentResolvedOutcomes,
        tier: currentConfidenceLevel,
        windowFrom: all?.latest.windowFrom ?? null,
        windowTo: all?.latest.windowTo ?? null,
      },
    };
  }

  async _buildEngineStatistics() {
    const rows = await this.db.all(
      `SELECT e.engine_id,
              COUNT(*)                                                   AS evals,
              COUNT(*) FILTER (WHERE e.would_trade IS TRUE)              AS would_trade,
              COUNT(*) FILTER (WHERE e.would_trade IS FALSE)            AS would_not,
              COUNT(*) FILTER (WHERE e.would_trade IS NULL)             AS abstain,
              AVG(e.score)                                              AS avg_score,
              COUNT(o.id) FILTER (WHERE e.would_trade IS TRUE)         AS resolved_wanted,
              COUNT(o.id) FILTER (WHERE e.would_trade IS TRUE AND o.profit_pips > 0) AS wins_wanted,
              AVG(o.profit_pips) FILTER (WHERE e.would_trade IS TRUE)  AS avg_pips_wanted
         FROM shadow_engine_evals e
         LEFT JOIN shadow_outcomes o ON o.signal_id = e.signal_id
        GROUP BY e.engine_id
        ORDER BY e.engine_id`
    );
    if (!rows.length) return null;
    let totalEvals = 0;
    const engines = rows.map((r) => {
      const evals = intOr0(r.evals);
      totalEvals += evals;
      const resolvedWanted = intOr0(r.resolved_wanted);
      return {
        engineId: r.engine_id,
        evals,
        wouldTrade: intOr0(r.would_trade),
        wouldNot: intOr0(r.would_not),
        abstain: intOr0(r.abstain),
        avgScore: numOrNull(r.avg_score),
        resolvedWanted,
        measuredWinrate: rate(r.wins_wanted, resolvedWanted),
        avgProfitPips: numOrNull(r.avg_pips_wanted),
      };
    });
    return {
      content: { source: "shadow_engine_evals+shadow_outcomes", engineCount: engines.length, engines },
      meta: { trainingEvents: totalEvals, tier: confidenceLevel(totalEvals) },
    };
  }

  async _buildValidatedPatterns() {
    const rows = await this.db.all(
      `SELECT s.symbol, s.trend_bucket, s.volatility_bucket, s.spread_bucket, s.side,
              COUNT(*)                                    AS signals,
              COUNT(o.id)                                 AS resolved,
              COUNT(o.id) FILTER (WHERE o.profit_pips > 0) AS wins,
              SUM(o.profit_pips)                          AS total_pips,
              AVG(o.profit_pips)                          AS avg_pips
         FROM shadow_signals s
         LEFT JOIN shadow_outcomes o ON o.signal_id = s.signal_id
        GROUP BY s.symbol, s.trend_bucket, s.volatility_bucket, s.spread_bucket, s.side
       HAVING COUNT(o.id) > 0
        ORDER BY resolved DESC, s.symbol, s.trend_bucket, s.volatility_bucket, s.spread_bucket, s.side
        LIMIT ?`,
      MAX_ROWS
    );
    if (!rows.length) return null;
    let totalResolved = 0;
    let validatedCount = 0;
    const patterns = rows.map((r) => {
      const resolved = intOr0(r.resolved);
      totalResolved += resolved;
      const avgPips = numOrNull(r.avg_pips);
      const validated = resolved >= VALIDATION_MIN_SAMPLE && avgPips !== null && avgPips > 0;
      if (validated) validatedCount++;
      return {
        symbol: r.symbol ?? null,
        trendBucket: r.trend_bucket ?? null,
        volatilityBucket: r.volatility_bucket ?? null,
        spreadBucket: r.spread_bucket ?? null,
        side: r.side ?? null,
        signals: intOr0(r.signals),
        resolved,
        wins: intOr0(r.wins),
        winrate: rate(r.wins, resolved),
        expectancyPips: avgPips,
        totalPips: numOrNull(r.total_pips),
        confidence: confidenceLevel(resolved),
        validated,
      };
    });
    return {
      content: {
        source: "shadow_signals+shadow_outcomes",
        validationMinSample: VALIDATION_MIN_SAMPLE,
        patternCount: patterns.length,
        validatedCount,
        patterns,
      },
      meta: { trainingEvents: totalResolved, tier: confidenceLevel(totalResolved) },
    };
  }

  async _buildMarketFingerprints() {
    const rows = await this.db.all(
      `SELECT s.fingerprint,
              COUNT(*)                 AS signals,
              COUNT(DISTINCT s.symbol) AS symbols,
              MIN(s.created_at)        AS first_seen,
              MAX(s.created_at)        AS last_seen,
              COUNT(o.id)              AS resolved,
              AVG(o.profit_pips)       AS avg_pips
         FROM shadow_signals s
         LEFT JOIN shadow_outcomes o ON o.signal_id = s.signal_id
        WHERE s.fingerprint IS NOT NULL
        GROUP BY s.fingerprint
        ORDER BY signals DESC, s.fingerprint
        LIMIT ?`,
      MAX_ROWS
    );
    if (!rows.length) return null;
    let totalSignals = 0;
    const fingerprints = rows.map((r) => {
      const signals = intOr0(r.signals);
      totalSignals += signals;
      return {
        fingerprint: r.fingerprint,
        signals,
        symbols: intOr0(r.symbols),
        resolved: intOr0(r.resolved),
        avgProfitPips: numOrNull(r.avg_pips),
        firstSeen: toIso(r.first_seen),
        lastSeen: toIso(r.last_seen),
      };
    });
    return {
      content: { source: "shadow_signals+shadow_outcomes", fingerprintCount: fingerprints.length, fingerprints },
      meta: { trainingEvents: totalSignals, tier: confidenceLevel(totalSignals) },
    };
  }

  async _buildConfigHistory() {
    const rows = await this.db.all(
      `SELECT config_hash, COUNT(*) AS obs, MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
         FROM (
           SELECT config_hash, created_at FROM shadow_signals
           UNION ALL SELECT config_hash, created_at FROM shadow_engine_evals
           UNION ALL SELECT config_hash, created_at FROM shadow_outcomes
           UNION ALL SELECT config_hash, created_at FROM shadow_expectancy_snapshots
         ) u
        GROUP BY config_hash
        ORDER BY last_seen DESC, config_hash
        LIMIT ?`,
      MAX_ROWS
    );
    if (!rows.length) return null;
    let totalObs = 0;
    const configs = rows.map((r) => {
      const obs = intOr0(r.obs);
      totalObs += obs;
      return {
        configHash: r.config_hash,
        observations: obs,
        firstSeen: toIso(r.first_seen),
        lastSeen: toIso(r.last_seen),
      };
    });
    return {
      // Content is provenance-INDEPENDENT: the current config is captured via the
      // env-derived surface (which changes only on a real config change), never
      // via the manager's injected provenance.configHash — otherwise a restart
      // with a different provenance would churn versions.
      content: {
        source: "shadow_* (config_hash)",
        currentSurface: buildConfigSurface(),
        configCount: configs.length,
        configs,
      },
      meta: { trainingEvents: totalObs, tier: confidenceLevel(totalObs) },
    };
  }

  async _buildConfidenceHistory() {
    const rows = await this.db.all(
      `SELECT scope, confidence_level,
              COUNT(*)             AS points,
              MIN(resolved_trades) AS min_resolved,
              MAX(resolved_trades) AS max_resolved,
              MIN(created_at)      AS first_at,
              MAX(created_at)      AS last_at
         FROM shadow_expectancy_snapshots
        GROUP BY scope, confidence_level
        ORDER BY scope, MIN(created_at)`
    );
    if (!rows.length) return null;
    const resolvedRow = await this.db.get(
      `SELECT COUNT(DISTINCT signal_id) AS n
         FROM shadow_outcomes
        WHERE COALESCE(outcome->>'testSimulation', 'false') <> 'true'`
    );
    const currentResolvedOutcomes = intOr0(resolvedRow?.n);
    const currentConfidenceLevel = confidenceLevel(currentResolvedOutcomes);
    const byScope = {};
    for (const r of rows) {
      const points = intOr0(r.points);
      (byScope[r.scope] ||= []).push({
        confidenceLevel: r.confidence_level,
        points,
        minResolved: intOr0(r.min_resolved),
        maxResolved: intOr0(r.max_resolved),
        firstAt: toIso(r.first_at),
        lastAt: toIso(r.last_at),
      });
    }
    return {
      content: {
        source: "shadow_expectancy_snapshots",
        scopeCount: Object.keys(byScope).length,
        byScope,
        currentResolvedOutcomes,
        currentConfidenceLevel,
      },
      meta: { trainingEvents: currentResolvedOutcomes, tier: currentConfidenceLevel },
    };
  }

  async _buildExperimentMetadata() {
    const rows = await this.db.all(
      `SELECT run_id, build_id, config_hash,
              COUNT(*) FILTER (WHERE src = 'sig')  AS signals,
              COUNT(*) FILTER (WHERE src = 'eval') AS evals,
              COUNT(*) FILTER (WHERE src = 'out')  AS outcomes,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at
         FROM (
           SELECT run_id, build_id, config_hash, created_at, 'sig'  AS src FROM shadow_signals
           UNION ALL SELECT run_id, build_id, config_hash, created_at, 'eval' AS src FROM shadow_engine_evals
           UNION ALL SELECT run_id, build_id, config_hash, created_at, 'out'  AS src FROM shadow_outcomes
         ) u
        GROUP BY run_id, build_id, config_hash
        ORDER BY last_at DESC, run_id, build_id, config_hash
        LIMIT ?`,
      MAX_ROWS
    );
    if (!rows.length) return null;
    const experiments = rows.map((r) => ({
      runId: r.run_id,
      buildId: r.build_id,
      configHash: r.config_hash,
      signals: intOr0(r.signals),
      evals: intOr0(r.evals),
      outcomes: intOr0(r.outcomes),
      firstAt: toIso(r.first_at),
      lastAt: toIso(r.last_at),
    }));
    return {
      content: { source: "shadow_* (run_id)", experimentCount: experiments.length, experiments },
      meta: { trainingEvents: experiments.length, tier: confidenceLevel(experiments.length) },
    };
  }
}

module.exports = {
  KnowledgeManager,
  KnowledgeRepository,
  ARTIFACTS,
  VALIDATION_MIN_SAMPLE,
  MAX_ROWS,
  DEFAULT_POLL_MS,
};
