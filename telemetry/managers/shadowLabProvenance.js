"use strict";
/**
 * SHADOW OS v2 — Sprint 5: Shadow LAB Provenance
 *
 * Deterministic provenance for the research-only measurement layer.
 * Every research row (shadow_signals / shadow_engine_evals / shadow_outcomes /
 * shadow_expectancy_snapshots) MUST carry run_id + build_id + config_hash so
 * that every recorded measurement is reproducible from the exact code +
 * configuration that produced it.
 *
 * Provenance triple:
 *   run_id      — identifies ONE running instance (per-process UUID). Lets you
 *                 group all measurements produced by a single boot.
 *   build_id    — identifies the CODE that produced the measurement:
 *                 `<systemVersion>+<gitShaOrEnvOrUnknown>`. Covers hardcoded
 *                 engine constants (they change only when the code changes).
 *   config_hash — identifies the RUNTIME configuration affecting decisions:
 *                 SHA-256 over a canonical (sorted-key) JSON of the
 *                 decision-relevant environment surface + system version.
 *                 Deterministic: same config → same hash; any change → new hash.
 *
 * This module is pure/read-only. It NEVER touches live trading logic, the DB,
 * or the FROZEN entrypoint. `git rev-parse` is best-effort and fully guarded.
 */

const crypto = require("crypto");
const { execSync } = require("child_process");

// System version — mirrors the live meta domain (runtime_domains 'meta'.systemVersion)
// and telemetry/shadowlab.js (v40). Read-only constant; NOT a decision input.
const SYSTEM_VERSION = "v40.1";

// confidence_level tiers from sample size (binding contract).
//   LOW    : sampleCount < 30
//   MEDIUM : 30 <= sampleCount <= 100
//   HIGH   : sampleCount > 100
const CONFIDENCE_THRESHOLDS = Object.freeze({ MEDIUM_MIN: 30, HIGH_MIN: 101 });

/**
 * Canonical JSON — deterministic serialization with recursively sorted object
 * keys. Arrays preserve their order (order is meaningful for arrays). Used so
 * that config_hash is independent of key insertion order.
 * @param {*} value
 * @returns {string}
 */
function canonicalJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  return JSON.stringify(value);
}

/**
 * Build the decision-relevant configuration surface from the environment.
 * These are the runtime-tunable parameters that affect what the live bot does
 * (and therefore which signals the Shadow LAB observes). Hardcoded engine
 * constants are covered by build_id (they only change with the code).
 *
 * Extend this object (never reorder — canonicalJson sorts) as new tunables are
 * introduced, so config_hash keeps identifying "everything that can change a
 * decision without a code change".
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {object}
 */
function buildConfigSurface(env = process.env) {
  return {
    version:        SYSTEM_VERSION,
    oandaEnv:       env.OANDA_ENV       ?? null,
    symbols:        env.SYMBOLS         ?? null,
    disabledSymbols: env.DISABLED_SYMBOLS ?? null,
    timeframe:      env.TIMEFRAME       ?? "M5",
    riskPercent:    env.RISK_PERCENT    ?? "0.01",
    maxOpenTrades:  env.MAX_OPEN_TRADES ?? "2",
    maxDailyTrades: env.MAX_DAILY_TRADES ?? "50",
    minStrength:    env.MIN_STRENGTH    ?? "0.08",
    shadowMode:     (env.SHADOW_MODE    ?? "OBSERVE").toUpperCase(),
  };
}

/**
 * Deterministic SHA-256 config hash over the canonical config surface.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} 64-char lowercase hex
 */
function configHash(env = process.env) {
  return crypto.createHash("sha256").update(canonicalJson(buildConfigSurface(env))).digest("hex");
}

/**
 * Resolve the git commit SHA without throwing. Order:
 *   1. Common deploy-provided env vars (Railway / Heroku-style / generic).
 *   2. `git rev-parse HEAD` (dev / CI where a checkout exists).
 *   3. "unknown".
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveGitSha(env = process.env) {
  const fromEnv =
    env.RAILWAY_GIT_COMMIT_SHA ||
    env.GIT_COMMIT_SHA ||
    env.SOURCE_VERSION ||
    env.COMMIT_SHA ||
    "";
  if (fromEnv) return String(fromEnv);
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch (_) {
    return "unknown";
  }
}

/**
 * Build id = `<systemVersion>+<gitSha12|unknown>`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveBuildId(env = process.env) {
  const sha = resolveGitSha(env);
  const shortSha = sha === "unknown" ? "unknown" : sha.slice(0, 12);
  return `${SYSTEM_VERSION}+${shortSha}`;
}

/**
 * confidence_level from sample size. Auto-computed + tested (binding contract).
 * @param {number} sampleCount
 * @returns {"LOW"|"MEDIUM"|"HIGH"}
 */
function confidenceLevel(sampleCount) {
  const n = Number(sampleCount);
  if (!Number.isFinite(n) || n < CONFIDENCE_THRESHOLDS.MEDIUM_MIN) return "LOW";
  if (n >= CONFIDENCE_THRESHOLDS.HIGH_MIN) return "HIGH";
  return "MEDIUM";
}

/**
 * Create a provenance context. Computes the triple ONCE (run_id per process,
 * build_id + config_hash from the current code + env) and exposes a `stamp()`
 * helper that decorates any research row with the snake_case provenance columns.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]      env source (default process.env)
 * @param {string}            [opts.runId]    override (tests / recovery)
 * @param {string}            [opts.buildId]  override (tests)
 * @param {string}            [opts.configHash] override (tests)
 * @returns {{runId:string, buildId:string, configHash:string, stamp:(row?:object)=>object}}
 */
function createProvenance(opts = {}) {
  const env = opts.env || process.env;
  const runId = opts.runId || crypto.randomUUID();
  const buildId = opts.buildId || resolveBuildId(env);
  const cfgHash = opts.configHash || configHash(env);

  return {
    runId,
    buildId,
    configHash: cfgHash,
    /**
     * Decorate a row with provenance columns. Returns a NEW object.
     * @param {object} [row]
     */
    stamp(row = {}) {
      return { ...row, run_id: runId, build_id: buildId, config_hash: cfgHash };
    },
  };
}

module.exports = {
  SYSTEM_VERSION,
  CONFIDENCE_THRESHOLDS,
  canonicalJson,
  buildConfigSurface,
  configHash,
  resolveGitSha,
  resolveBuildId,
  confidenceLevel,
  createProvenance,
};
