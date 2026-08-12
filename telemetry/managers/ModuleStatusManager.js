"use strict";
/**
 * ModuleStatusManager — SPRINT 9: DASHBOARD MODULE STATUS (presentation-only)
 *
 * PROJECT RULE (Sprint 9, mandatory): every existing and future module of the
 * system MUST have its own status section in the Dashboard. No module may stay
 * "hidden" in code without a visible status card.
 *
 * This manager is a READ-ONLY status registry:
 *   - reads ONLY: events (GROUP BY type), shadow_* research tables,
 *     knowledge_* tables, memory_events, runtime_domains, trade_intents,
 *     shadowm_trades + in-memory stats getters of already-running managers
 *   - writes NOTHING, starts NO timers, NEVER touches the trading path
 *   - every query and every manager-stats call is individually guarded:
 *     a missing table or a failing getter degrades to null/0, never throws
 *
 * Status vocabulary (fixed contract, Sprint 9 spec):
 *   NOT INSTALLED — planned module, no code present yet
 *   INSTALLED     — code present but not running (waiting for activation)
 *   ACTIVE        — running AND influences live trading decisions
 *   LEARNING      — running, building models/artifacts, no live influence
 *   OBSERVING     — running, collecting data, no live influence
 *   DISABLED      — explicitly switched off via its kill-switch flag
 */

const STATUS = Object.freeze({
  NOT_INSTALLED: "NOT INSTALLED",
  INSTALLED:     "INSTALLED",
  ACTIVE:        "ACTIVE",
  LEARNING:      "LEARNING",
  OBSERVING:     "OBSERVING",
  DISABLED:      "DISABLED",
});

/** Coerce a COUNT(*) result (pg returns bigint as string) to a number, null-safe. */
function toCount(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

class ModuleStatusManager {
  /**
   * @param {object} opts
   * @param {object} opts.db                  db-adapter instance (db.get / db.all)
   * @param {object} opts.flags               per-flag { enabled:boolean, raw:string|undefined }
   * @param {function} opts.getShadowMode     () => "OBSERVE" | "GATE"
   * @param {function} opts.getShadowMStats   async () => shadowM stats
   * @param {object} opts.selectedAdvisor     SelectedAdvisor instance
   * @param {object} opts.selectedEngine      SelectedEngineManager instance
   * @param {object} opts.telemetryReconciler TelemetryReconciler instance
   * @param {object} opts.memoryIntegration   LiveMemoryIntegration instance
   * @param {object} opts.runtimeRegistry     RuntimeModuleRegistry instance
   * @param {function} opts.getLiveState      () => live state object of server.js
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this.db                  = opts.db;
    this.flags               = opts.flags || {};
    this.getShadowMode       = opts.getShadowMode       || (() => "OBSERVE");
    this.getShadowMStats     = opts.getShadowMStats     || (async () => null);
    this.selectedAdvisor     = opts.selectedAdvisor     || null;
    this.selectedEngine      = opts.selectedEngine      || null;
    this.telemetryReconciler = opts.telemetryReconciler || null;
    this.memoryIntegration   = opts.memoryIntegration   || null;
    this.runtimeRegistry     = opts.runtimeRegistry     || null;
    this.getLiveState        = opts.getLiveState        || (() => ({}));
    this.logger              = opts.logger || { info: () => {}, error: () => {} };
  }

  // ── guarded primitives ────────────────────────────────────────────────────
  async _count(sql, params = []) {
    try {
      const row = await this.db.get(sql, ...params);
      return row ? toCount(row.n) : 0;
    } catch (_e) {
      return null; // table absent / query failed — honest null, never fabricated 0
    }
  }

  async _safe(fn, fallback = null) {
    try {
      const v = await fn();
      return v === undefined ? fallback : v;
    } catch (_e) {
      return fallback;
    }
  }

  async _eventTypeCounts() {
    try {
      const rows = await this.db.all("SELECT type, COUNT(*) AS n FROM events GROUP BY type");
      const map = {};
      for (const r of rows || []) map[r.type] = toCount(r.n);
      return map;
    } catch (_e) {
      return {};
    }
  }

  async _engineEvalCounts() {
    try {
      const rows = await this.db.all(
        "SELECT engine_id, COUNT(*) AS n FROM shadow_engine_evals GROUP BY engine_id");
      const map = {};
      for (const r of rows || []) map[String(r.engine_id)] = toCount(r.n);
      return map;
    } catch (_e) {
      return {};
    }
  }

  /** Research-eval count for a shadow engine letter, tolerant of engine_id naming. */
  _evalsForLetter(evalCounts, letter) {
    const keys = Object.keys(evalCounts);
    const want = letter.toLowerCase();
    let total = 0, found = false;
    for (const k of keys) {
      const kl = k.toLowerCase();
      if (kl === want || kl === `shadow_${want}` || kl === `shadow${want}` ||
          kl === `engine_${want}` || kl.endsWith(`_${want}`)) {
        total += evalCounts[k]; found = true;
      }
    }
    return found ? total : 0;
  }

  /** Flag → { status, reason } for a default-OFF research-style module. */
  _flagStatus(flag, activeStatus, activateHint) {
    if (!flag) return { status: STATUS.INSTALLED, reason: "Flag not wired" };
    if (flag.enabled) return { status: activeStatus, reason: null };
    const raw = (flag.raw || "").toLowerCase();
    if (raw === "off") return { status: STATUS.DISABLED, reason: "Explicitly disabled (kill switch)" };
    return { status: STATUS.INSTALLED, reason: `Waiting for activation (${activateHint})` };
  }

  // ── the registry ──────────────────────────────────────────────────────────
  async build() {
    const [ev, evals] = await Promise.all([this._eventTypeCounts(), this._engineEvalCounts()]);

    const [
      shadowSignals, shadowOutcomes, expectancySnapshots,
      knowledgeArtifacts, knowledgeSnapshots,
      memoryEvents, runtimeDomains, tradeIntents, shadowMTrades,
      totalEvents,
    ] = await Promise.all([
      this._count("SELECT COUNT(*) AS n FROM shadow_signals"),
      this._count("SELECT COUNT(*) AS n FROM shadow_outcomes"),
      this._count("SELECT COUNT(*) AS n FROM shadow_expectancy_snapshots"),
      this._count("SELECT COUNT(*) AS n FROM knowledge_artifacts"),
      this._count("SELECT COUNT(*) AS n FROM knowledge_snapshots"),
      this._count("SELECT COUNT(*) AS n FROM memory_events"),
      this._count("SELECT COUNT(*) AS n FROM runtime_domains"),
      this._count("SELECT COUNT(*) AS n FROM trade_intents"),
      this._count("SELECT COUNT(*) AS n FROM shadowm_trades"),
      this._count("SELECT COUNT(*) AS n FROM events"),
    ]);

    const live       = this._safeLive();
    const botRunning = live.botStatus === "running";
    const mode       = this._safe0(() => this.getShadowMode(), "OBSERVE");
    const gateMode   = mode === "GATE";

    const shadowMStats  = await this._safe(() => this.getShadowMStats());
    const advisorStatus = await this._safe(() => this.selectedAdvisor && this.selectedAdvisor.getStatus());
    const advisories    = await this._safe(() => this.selectedAdvisor && this.selectedAdvisor.getAdvisories(1000), []);
    const engineStatus  = await this._safe(() => this.selectedEngine && this.selectedEngine.getStatus());
    const reconStats    = await this._safe(() => this.telemetryReconciler && this.telemetryReconciler.getStats());
    const memoryStatus  = await this._safe(() => this.memoryIntegration && this.memoryIntegration.getStatus());

    const F = this.flags;
    const modules = [];

    // ── TIER: LIVE TRADING ───────────────────────────────────────────────────
    modules.push({
      id: "live-engine", name: "Live Engine (bot index.js)", tier: "LIVE TRADING",
      status: botRunning ? STATUS.ACTIVE : STATUS.INSTALLED,
      connected: true, collectsData: true, influencesLive: true,
      observations: ev.trade_open || 0,
      stats: {
        botStatus: live.botStatus || "unknown",
        openTradesNow: Array.isArray(live.openTrades) ? live.openTrades.length : Object.keys(live.openTrades || {}).length,
        dailyTrades: live.dailyTrades || 0,
        tradeOpens: ev.trade_open || 0,
        tradeCloses: ev.trade_close || 0,
      },
      reason: botRunning ? null : "Bot process not running",
      alsoVisibleIn: "LIVE",
    });

    modules.push({
      id: "exit-engine", name: "Exit Engine (manageTrades)", tier: "LIVE TRADING",
      status: botRunning ? STATUS.ACTIVE : STATUS.INSTALLED,
      connected: true, collectsData: true, influencesLive: true,
      observations: ev.trade_close || 0,
      stats: {
        breakEvenEvents: ev.break_even || 0,
        mfeFloorSets: ev.mfe_floor_set || 0,
        calibration: "Sprint 8: BE ≥2p, PP ≥2.5p, MFE floor 50%, TIME 6min (<+2p), EARLY −4p",
      },
      reason: botRunning ? null : "Bot process not running",
      alsoVisibleIn: "ANALIZA",
    });

    {
      const evals = ev.exit_engine_x_evaluation || 0;
      const votes = ev.exit_engine_x_vote || 0;
      const decisions = ev.exit_engine_x_decision || 0;
      const closes = ev.exit_engine_x_close || 0;
      modules.push({
        id: "exit-engine-x", name: "Exit Engine X (Shadow Intelligence)", tier: "INTELLIGENCE",
        status: evals > 0 ? STATUS.OBSERVING : STATUS.INSTALLED,
        connected: true, collectsData: true, influencesLive: false,
        observations: evals,
        stats: {
          evaluations: evals,
          votes,
          decisions,
          closedTrades: closes,
          mode: "SHADOW",
          advisoryOnly: true,
        },
        reason: evals > 0
          ? "Shadow-only — recommendations are recorded; Live Exit remains authoritative"
          : "Waiting for first evaluated live trade",
        alsoVisibleIn: "ANALIZA",
      });
    }

    modules.push({
      id: "shadow-gate", name: "Shadow Gate", tier: "LIVE TRADING",
      status: gateMode ? STATUS.ACTIVE : STATUS.OBSERVING,
      connected: true, collectsData: true, influencesLive: gateMode,
      observations: ev.shadow_gate_eval || 0,
      stats: {
        mode,
        gateBlocks: ev.shadow_gate_block || 0,
        advisoryEvents: ev.shadow_advisory || 0,
        modeChanges: ev.shadow_mode_change || 0,
      },
      reason: gateMode ? "GATE mode — blocks HIGH-confidence SKIP signals" : "OBSERVE mode — data collection, never blocks",
      alsoVisibleIn: "LAB",
    });

    // ── TIER: SHADOW RESEARCH ────────────────────────────────────────────────
    const shadowDefs = [
      { letter: "a", name: "Shadow A — Quality Engine",    learning: false },
      { letter: "b", name: "Shadow B — Context Engine",    learning: false },
      { letter: "c", name: "Shadow C — KNN Memory Engine", learning: true  },
      { letter: "d", name: "Shadow D — Meta Engine",       learning: false },
    ];
    for (const s of shadowDefs) {
      const obs = ev[`lab_shadow_${s.letter}`] || 0;
      const isD = s.letter === "d";
      const dInfluences = isD && gateMode;
      const advisory = isD ? null : {
        generated: ev[`shadow_${s.letter}_advisory_generated`] || 0,
        delivered: ev[`shadow_${s.letter}_advisory_delivered`] || 0,
        read: ev[`shadow_${s.letter}_advisory_read`] || 0,
      };
      const advisoryInfluences = !isD &&
        advisory.generated > 0 &&
        advisory.delivered > 0 &&
        advisory.read > 0;
      let status, reason = null;
      if (dInfluences)      { status = STATUS.ACTIVE; reason = "GATE mode — HIGH-confidence SKIP blocks entries"; }
      else if (advisoryInfluences) {
        status = STATUS.ACTIVE;
        reason = "Active — advisory cooperation: entry recommendations delivered and read by Live Bot";
      }
      else if (obs > 0)     { status = s.learning ? STATUS.LEARNING : STATUS.OBSERVING; }
      else                  { status = STATUS.INSTALLED; reason = "Waiting for first evaluated signal"; }
      modules.push({
        id: `shadow-${s.letter}`, name: s.name, tier: "SHADOW RESEARCH",
        status,
        connected: true, collectsData: true, influencesLive: dInfluences || advisoryInfluences,
        observations: obs,
        stats: {
          pipelineEvals: obs,
          researchEvals: this._evalsForLetter(evals, s.letter),
          ...(advisory || {}),
        },
        reason,
        alsoVisibleIn: "LAB",
      });
    }

    {
      // Shadow M is ACTIVE and influences live when the bot is running.
      // cooperativeAdvisory() is called on every open-trade management tick;
      // its result (MOVE_BE / MOVE_SL / etc.) feeds directly into the exit conditions.
      const shadowMInfluences = botRunning;
      const shadowMStatus = botRunning
        ? STATUS.ACTIVE
        : (shadowMTrades || 0) > 0 ? STATUS.OBSERVING : STATUS.INSTALLED;
      modules.push({
        id: "shadow-m", name: "Shadow M — Exit Lab (trade tracker)", tier: "SHADOW RESEARCH",
        status: shadowMStatus,
        connected: true, collectsData: true, influencesLive: shadowMInfluences,
        observations: shadowMTrades ?? 0,
        stats: shadowMStats && typeof shadowMStats === "object"
          ? { trackedTrades: shadowMTrades ?? 0, ...this._pick(shadowMStats, ["strategies", "bestStrategy", "open", "closed"]) }
          : { trackedTrades: shadowMTrades ?? 0 },
        reason: botRunning
          ? "Active — advisory cooperation: recommendations (MOVE_BE/MOVE_SL/HOLD) passed to Live Exit Engine every tick"
          : ((shadowMTrades || 0) > 0 ? null : "Waiting for bot to start and first tracked trade"),
        alsoVisibleIn: "LAB",
      });
    }

    {
      const f = this._flagStatus(F.research, STATUS.LEARNING, "SHADOW_LAB_RESEARCH=on");
      modules.push({
        id: "shadowlab-research", name: "Shadow LAB Research (reconciler)", tier: "SHADOW RESEARCH",
        status: f.status,
        connected: !!(F.research && F.research.enabled),
        collectsData: !!(F.research && F.research.enabled),
        influencesLive: false,
        observations: shadowSignals ?? 0,
        stats: {
          shadowSignals: shadowSignals ?? 0,
          shadowOutcomes: shadowOutcomes ?? 0,
          engineEvals: Object.values(evals).reduce((a, b) => a + b, 0),
          expectancySnapshots: expectancySnapshots ?? 0,
        },
        reason: f.reason,
        alsoVisibleIn: "LAB",
      });
    }

    // ── TIER: INTELLIGENCE ───────────────────────────────────────────────────
    {
      const f = this._flagStatus(F.knowledge, STATUS.LEARNING, "KNOWLEDGE_LAYER=on");
      modules.push({
        id: "knowledge-layer", name: "Knowledge Layer", tier: "INTELLIGENCE",
        status: f.status,
        connected: !!(F.knowledge && F.knowledge.enabled),
        collectsData: !!(F.knowledge && F.knowledge.enabled),
        influencesLive: false,
        observations: knowledgeArtifacts ?? 0,
        stats: { artifacts: knowledgeArtifacts ?? 0, snapshots: knowledgeSnapshots ?? 0 },
        reason: f.reason,
        alsoVisibleIn: "KNOWLEDGE",
      });
    }

    {
      const seEnabled = !!(F.selectedEngine && F.selectedEngine.enabled);
      const ceEnabled = !!(F.coopEntry && F.coopEntry.enabled);
      // coopEntryActive = true when the entry cooperation hook can block or advise entries.
      const coopEntryActive = seEnabled && ceEnabled;
      const f = this._flagStatus(F.selectedEngine, coopEntryActive ? STATUS.ACTIVE : STATUS.OBSERVING, "SELECTED_ENGINE=on");
      const es = engineStatus && typeof engineStatus === "object" ? engineStatus : null;
      modules.push({
        id: "selected-engine", name: "Selected Engine", tier: "INTELLIGENCE",
        // ACTIVE when cooperation hook is live (can block HIGH-confidence NO_TRADE entries).
        // OBSERVING when Selected Engine is on but entry cooperation is disabled.
        status: coopEntryActive ? STATUS.ACTIVE : f.status,
        connected: seEnabled,
        collectsData: seEnabled,
        influencesLive: coopEntryActive,  // accurate: HIGH NO_TRADE blocks placeTrade()
        observations: es && es.ring ? toCount(es.ring.size) : 0,
        stats: es ? {
          running: !!es.running,
          enginesDiscovered: toCount(es.engineCount),
          contextsInRing: es.ring ? toCount(es.ring.size) : 0,
          knowledgeDomains: Array.isArray(es.knowledgeDomains) ? es.knowledgeDomains.length : 0,
          knowledgeVersion: es.knowledgeVersion ?? null,
          coopEntryEnabled: ceEnabled,
        } : { coopEntryEnabled: ceEnabled },
        reason: coopEntryActive
          ? "Active — entry cooperation: HIGH NO_TRADE blocks entry; HIGH TRADE allows; MEDIUM advisory only; fail-open on error"
          : (f.reason || "SELECTED_ENGINE or COOP_ENTRY_ENABLED is off — cooperation hook inactive"),
        alsoVisibleIn: "SELECTED",
      });
    }

    {
      const enabled = !!(F.selectedAdvisor && F.selectedAdvisor.enabled);
      const raw = ((F.selectedAdvisor && F.selectedAdvisor.raw) || "").toLowerCase();
      const advisoryCount = Array.isArray(advisories) ? advisories.length : 0;
      modules.push({
        id: "selected-advisor", name: "Selected Advisor / Advice Engine", tier: "INTELLIGENCE",
        status: enabled ? STATUS.OBSERVING : (raw === "off" ? STATUS.DISABLED : STATUS.INSTALLED),
        connected: enabled, collectsData: enabled, influencesLive: false,
        observations: advisoryCount,
        stats: advisorStatus && typeof advisorStatus === "object"
          ? {
              advisories: advisoryCount,
              ringCapacity: advisorStatus.ring ? toCount(advisorStatus.ring.capacity) : null,
              pendingRecoveries: toCount(advisorStatus.pending),
              ...(advisorStatus.counters && typeof advisorStatus.counters === "object" ? { counters: advisorStatus.counters } : {}),
            }
          : { advisories: advisoryCount },
        reason: enabled
          ? "Advisory ring in memory — attaches Selected opinion to every live trade open"
          : (raw === "off" ? "Explicitly disabled (kill switch)" : "Waiting for activation"),
        alsoVisibleIn: "SELECTED",
      });
    }

    modules.push({
      id: "ai-analysis", name: "AI Analysis (Report v2 + Snapshot)", tier: "INTELLIGENCE",
      status: STATUS.INSTALLED,
      connected: false, collectsData: false, influencesLive: false,
      observations: 0,
      stats: { type: "client-side, on-demand", sources: "33 read-only GET endpoints" },
      reason: "On-demand — generated from the EXPORT tab",
      alsoVisibleIn: "EXPORT",
    });

    // ── TIER: MEMORY & STATE ────────────────────────────────────────────────
    {
      const enabled = !!(F.memory && F.memory.enabled);
      const raw = ((F.memory && F.memory.raw) || "").toLowerCase();
      modules.push({
        id: "memory", name: "Memory Layer (MemoryManager + LMI)", tier: "MEMORY & STATE",
        status: enabled ? STATUS.OBSERVING : (raw === "off" ? STATUS.DISABLED : STATUS.INSTALLED),
        connected: enabled, collectsData: enabled, influencesLive: false,
        observations: memoryEvents ?? 0,
        stats: memoryStatus && typeof memoryStatus === "object"
          ? { memoryEvents: memoryEvents ?? 0, ...this._pick(memoryStatus, ["enabled", "recovered", "drift", "lastError"]) }
          : { memoryEvents: memoryEvents ?? 0 },
        reason: enabled ? "Append-first memory over live hooks — failures can never block trading" : "Kill switch SHADOW_OS_MEMORY=off",
        alsoVisibleIn: null,
      });
    }

    modules.push({
      id: "runtime-domain-manager", name: "RuntimeDomainManager", tier: "MEMORY & STATE",
      status: (runtimeDomains || 0) > 0 ? STATUS.OBSERVING : STATUS.INSTALLED,
      connected: !!(F.memory && F.memory.enabled), collectsData: (runtimeDomains || 0) > 0, influencesLive: false,
      observations: runtimeDomains ?? 0,
      stats: { domains: runtimeDomains ?? 0 },
      reason: (runtimeDomains || 0) > 0 ? null : "Waiting for activation",
      alsoVisibleIn: null,
    });

    modules.push({
      id: "trade-intent-manager", name: "TradeIntentManager", tier: "MEMORY & STATE",
      status: (tradeIntents || 0) > 0 ? STATUS.OBSERVING : STATUS.INSTALLED,
      connected: !!(F.memory && F.memory.enabled), collectsData: (tradeIntents || 0) > 0, influencesLive: false,
      observations: tradeIntents ?? 0,
      stats: { intents: tradeIntents ?? 0 },
      reason: (tradeIntents || 0) > 0 ? null : "Waiting for activation",
      alsoVisibleIn: null,
    });

    // ── TIER: TELEMETRY ─────────────────────────────────────────────────────
    modules.push({
      id: "telemetry-core", name: "Telemetry Core (logEvent + events + SSE)", tier: "TELEMETRY",
      status: STATUS.OBSERVING,
      connected: true, collectsData: true, influencesLive: false,
      observations: totalEvents ?? 0,
      stats: { totalEvents: totalEvents ?? 0, distinctEventTypes: Object.keys(ev).length },
      reason: null,
      alsoVisibleIn: "DECYZJE",
    });

    {
      const enabled = !!(F.reconciler && F.reconciler.enabled);
      const raw = ((F.reconciler && F.reconciler.raw) || "").toLowerCase();
      const creds = !!(reconStats && reconStats.credsPresent);
      let status, reason;
      if (!enabled) { status = raw === "off" ? STATUS.DISABLED : STATUS.INSTALLED; reason = raw === "off" ? "Kill switch TELEMETRY_RECONCILER=off" : "Waiting for activation"; }
      else if (!creds) { status = STATUS.INSTALLED; reason = "Waiting for OANDA credentials (dormant — health shows UNKNOWN)"; }
      else { status = STATUS.OBSERVING; reason = "Captures OANDA-side closes as synthetic trade_close"; }
      modules.push({
        id: "telemetry-reconciler", name: "Telemetry Reconciler (OANDA closes)", tier: "TELEMETRY",
        status,
        connected: enabled && creds, collectsData: enabled && creds, influencesLive: false,
        observations: reconStats ? toCount(reconStats.syntheticWritten) : 0,
        stats: reconStats && typeof reconStats === "object"
          ? this._pick(reconStats, ["credsPresent", "pollCount", "oandaClosesSeen", "nativeMatched", "syntheticWritten", "pendingWithinGrace", "pendingRetry"])
          : {},
        reason,
        alsoVisibleIn: "PIPELINE",
      });
    }

    modules.push({
      id: "health-monitor", name: "Health Monitor (health endpoints)", tier: "TELEMETRY",
      status: STATUS.OBSERVING,
      connected: true, collectsData: false, influencesLive: false,
      observations: null,
      stats: { endpoints: "/api/telemetry/health, /api/healthz/persistence, /api/memory-integration/status" },
      reason: "Derives health from existing data — stores nothing itself",
      alsoVisibleIn: "PIPELINE",
    });

    // ── TIER: PLANNED (Sprint 7 — not started) ──────────────────────────────
    for (const p of [
      { id: "recovery-manager",   name: "RecoveryManager (Sprint 7)" },
      { id: "validation-manager", name: "ValidationManager (Sprint 7)" },
    ]) {
      modules.push({
        id: p.id, name: p.name, tier: "PLANNED",
        status: STATUS.NOT_INSTALLED,
        connected: false, collectsData: false, influencesLive: false,
        observations: 0,
        stats: {},
        reason: "Planned — Sprint 7 not started yet",
        alsoVisibleIn: null,
      });
    }

    // Add runtime controls to every card. Toggleable modules are forced to a
    // truthful DISABLED card when their lifecycle/control channel is off.
    for (const module of modules) {
      const runtime = this.runtimeRegistry && this.runtimeRegistry.getStatus(module.id);
      module.runtimeEnabled = runtime ? runtime.runtimeEnabled : !(
        module.status === STATUS.NOT_INSTALLED
      );
      module.toggleable = runtime ? runtime.toggleable : false;
      module.toggleReason = runtime ? runtime.toggleReason : (
        module.status === STATUS.NOT_INSTALLED ? "Module is not installed" : "Protected or on-demand module"
      );
      module.transition = runtime ? runtime.transition : null;
      module.lastChangedAt = runtime ? runtime.lastChangedAt : null;
      if (runtime && !runtime.runtimeEnabled && runtime.toggleable) {
        module.status = STATUS.DISABLED;
        module.connected = false;
        module.collectsData = false;
        module.influencesLive = false;
        module.reason = "Explicitly disabled at runtime";
      }
    }

    const summary = {};
    for (const m of modules) summary[m.status] = (summary[m.status] || 0) + 1;

    return {
      generated: new Date().toISOString(),
      rule: "Sprint 9 project rule: every module must have its own visible status section — no hidden modules.",
      shadowMode: mode,
      summary,
      modules,
    };
  }

  // ── small helpers ────────────────────────────────────────────────────────
  _safeLive() {
    try { return this.getLiveState() || {}; } catch (_e) { return {}; }
  }

  _safe0(fn, fallback) {
    try { const v = fn(); return v === undefined || v === null ? fallback : v; } catch (_e) { return fallback; }
  }

  _pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
  }
}

module.exports = { ModuleStatusManager, MODULE_STATUS: STATUS };
