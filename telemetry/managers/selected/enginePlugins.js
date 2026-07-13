"use strict";
/**
 * SHADOW OS v2 — Selected Engine: plugin registry + engine auto-discovery.
 *
 * Every engine the Selected Engine consumes implements the SAME duck-typed
 * interface (SOLID / dependency-inversion — Selected Engine depends on this
 * abstraction, never on concrete engine classes):
 *
 *     analyze(ctx)     → normalized opinion object for one signal
 *     score(opinion)   → numeric score for ranking (null = abstain/absent)
 *     explain(opinion) → human-readable reason string
 *     confidence(opinion) → engine-reported tier (LOW|MEDIUM|HIGH|null)
 *     metadata()       → { engineId, engineVersion, kind, source }
 *
 * ZERO hardcoded engine names. Engines are discovered two ways, both additive:
 *
 *   1. From the DATA: `SELECT DISTINCT engine_id FROM shadow_engine_evals`. Every
 *      engine that has ever recorded an evaluation is wrapped in a generic
 *      RecordedEvalAdapter. When a future Engine E/F/G starts recording evals
 *      (engine_id='E'), it is picked up automatically — no code change anywhere
 *      in the Selected Engine.
 *
 *   2. From an OPTIONAL plugin directory (telemetry/managers/selected/engines/).
 *      Any module there that exports a factory / object satisfying the 5-method
 *      interface is loaded and OVERRIDES (or adds to) the generic adapter for
 *      its engineId. Missing dir or a broken plugin file is a best-effort no-op.
 *
 * This layer is pure-READ: adapters operate on already-recorded eval rows handed
 * to them. They never touch the DB, the live engines, or the FROZEN entrypoint,
 * so no live/shadow/risk decision can ever be influenced from here.
 */

const fs = require("fs");
const path = require("path");
const { numOrNull, boolOrNull, confidenceToScore } = require("./ranking");

/** Parse a JSONB column value that may arrive as an object or a JSON string. */
function parseJson(v) {
  if (v === null || v === undefined) return {};
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (_) { return {}; }
  }
  return {};
}

/**
 * A generic engine plugin backed by recorded rows in shadow_engine_evals. One
 * instance per engine_id. It knows NOTHING engine-specific beyond its id — the
 * full engine output lives in the eval JSONB, promoted scalars in columns.
 */
class RecordedEvalAdapter {
  constructor({ engineId, engineVersion } = {}) {
    this.engineId = String(engineId);
    this.engineVersion = engineVersion || "recorded";
  }

  metadata() {
    return {
      engineId: this.engineId,
      engineVersion: this.engineVersion,
      kind: "recorded-eval",
      source: "shadow_engine_evals",
    };
  }

  /**
   * Build a normalized opinion for one signal from its recorded eval row.
   * @param {{evalRow:(object|null), signal:object, knowledge:object}} ctx
   */
  analyze(ctx = {}) {
    const row = ctx.evalRow || null;
    if (!row) {
      return {
        engineId: this.engineId,
        engineVersion: this.engineVersion,
        present: false,
        wouldTrade: null,
        score: null,
        confidence: null,
        confidenceScore: null,
        marketState: null,
        historicalWinrate: null,
        historicalExpectancy: null,
        reason: "no recorded evaluation for this signal",
        detail: {},
      };
    }
    const detail = parseJson(row.eval);
    const confidence = row.confidence || detail.confidence || null;
    return {
      engineId: this.engineId,
      engineVersion: row.engine_version || this.engineVersion,
      present: true,
      wouldTrade: boolOrNull(row.would_trade),
      score: numOrNull(row.score) ?? numOrNull(detail.score) ?? numOrNull(detail.metaVoteScore),
      confidence,
      confidenceScore: confidenceToScore(confidence),
      marketState: row.market_state || detail.marketState || null,
      historicalWinrate: numOrNull(row.historical_winrate) ?? numOrNull(detail.historicalWinrate),
      historicalExpectancy: numOrNull(detail.historicalExpectancy),
      reason: detail.reason || null,
      detail,
    };
  }

  score(opinion) {
    return opinion ? numOrNull(opinion.score) : null;
  }

  explain(opinion) {
    if (!opinion) return "";
    if (opinion.reason) return opinion.reason;
    if (!opinion.present) return "abstain (no recorded evaluation)";
    const wt = opinion.wouldTrade;
    return `${this.engineId}: ${wt === true ? "would-trade" : wt === false ? "would-not-trade" : "abstain"}`;
  }

  confidence(opinion) {
    return opinion ? (opinion.confidence || null) : null;
  }
}

/** Duck-type check: a valid plugin exposes all five interface methods. */
function isValidPlugin(obj) {
  return !!obj &&
    typeof obj.analyze === "function" &&
    typeof obj.score === "function" &&
    typeof obj.explain === "function" &&
    typeof obj.confidence === "function" &&
    typeof obj.metadata === "function";
}

/**
 * Best-effort load of custom engine plugins from a directory. Each module may
 * export the plugin object directly, a { plugin } / { default } wrapper, or a
 * factory function returning one. Broken files are skipped, never thrown.
 * @returns {Array<object>} valid plugin instances (keyed later by metadata().engineId)
 */
function loadCustomPlugins(pluginDir) {
  const out = [];
  let files = [];
  try {
    if (!pluginDir || !fs.existsSync(pluginDir)) return out;
    files = fs.readdirSync(pluginDir).filter((f) => f.endsWith(".js") && !f.startsWith("_"));
  } catch (_) {
    return out;
  }
  for (const f of files) {
    try {
      let mod = require(path.join(pluginDir, f));
      if (typeof mod === "function") mod = mod();
      const candidate = (mod && (mod.plugin || mod.default)) || mod;
      const inst = typeof candidate === "function" ? candidate() : candidate;
      if (isValidPlugin(inst) && inst.metadata() && inst.metadata().engineId != null) {
        out.push(inst);
      }
    } catch (_) {
      // A broken custom plugin must never break discovery.
    }
  }
  return out;
}

/**
 * Discover every available engine plugin. Generic RecordedEvalAdapters are
 * created for each engine_id present in shadow_engine_evals; custom plugins from
 * the plugin dir override/add by engineId. Returns descriptors sorted by id.
 *
 * @param {object} db  db-adapter (read-only use)
 * @param {{pluginDir?:string, customPlugins?:Array<object>}} [opts]
 * @returns {Promise<Array<{engineId:string, plugin:object, custom:boolean}>>}
 */
async function discoverEngines(db, opts = {}) {
  const byId = new Map();

  // 1. Data-driven discovery — one generic adapter per recorded engine_id.
  let rows = [];
  try {
    rows = await db.all(
      "SELECT engine_id, MAX(engine_version) AS engine_version FROM shadow_engine_evals GROUP BY engine_id ORDER BY engine_id ASC"
    );
  } catch (_) {
    rows = [];
  }
  for (const r of rows) {
    if (r && r.engine_id != null) {
      const engineId = String(r.engine_id);
      byId.set(engineId, {
        engineId,
        plugin: new RecordedEvalAdapter({ engineId, engineVersion: r.engine_version || "recorded" }),
        custom: false,
      });
    }
  }

  // 2. Custom plugins override/extend by engineId (best-effort).
  const custom = Array.isArray(opts.customPlugins)
    ? opts.customPlugins
    : loadCustomPlugins(opts.pluginDir);
  for (const inst of custom) {
    try {
      const engineId = String(inst.metadata().engineId);
      byId.set(engineId, { engineId, plugin: inst, custom: true });
    } catch (_) { /* skip bad plugin */ }
  }

  return Array.from(byId.values()).sort((a, b) => (a.engineId < b.engineId ? -1 : a.engineId > b.engineId ? 1 : 0));
}

module.exports = {
  RecordedEvalAdapter,
  isValidPlugin,
  loadCustomPlugins,
  discoverEngines,
  parseJson,
};
