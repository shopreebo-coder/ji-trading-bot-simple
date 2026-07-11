"use strict";
/**
 * Sprint 5 — Shadow LAB Provenance unit tests.
 *
 * Proves the provenance contract that every research row depends on:
 *   1. canonicalJson is deterministic and key-order-independent.
 *   2. config_hash is deterministic (same config → same hash), sensitive
 *      (any change → new hash), and order-independent.
 *   3. build_id has the reproducible `<version>+<sha|unknown>` shape.
 *   4. confidence_level tiers: LOW <30, MEDIUM 30–100, HIGH >100.
 *   5. createProvenance().stamp() adds run_id/build_id/config_hash; run_id is
 *      unique per context.
 *
 * Pure module — no DB, no network, no live-engine coupling.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const P = require("../../managers/shadowLabProvenance");

test("canonicalJson is deterministic and key-order-independent", () => {
  const a = { b: 1, a: 2, c: { z: 9, y: 8 } };
  const b = { c: { y: 8, z: 9 }, a: 2, b: 1 };
  assert.equal(P.canonicalJson(a), P.canonicalJson(b));
  // arrays preserve order (order is meaningful for arrays)
  assert.notEqual(P.canonicalJson([1, 2]), P.canonicalJson([2, 1]));
  // null / undefined normalize to "null"
  assert.equal(P.canonicalJson(undefined), "null");
  assert.equal(P.canonicalJson(null), "null");
});

test("config_hash is a 64-char hex and deterministic for the same env", () => {
  const env = { OANDA_ENV: "live", SYMBOLS: "EUR_USD,GBP_USD", RISK_PERCENT: "0.01" };
  const h1 = P.configHash(env);
  const h2 = P.configHash({ ...env });
  assert.match(h1, /^[0-9a-f]{64}$/);
  assert.equal(h1, h2, "same config must yield same hash");
});

test("config_hash changes when a decision-relevant value changes", () => {
  const base = { OANDA_ENV: "live", RISK_PERCENT: "0.01", MAX_OPEN_TRADES: "2" };
  const changed = { OANDA_ENV: "live", RISK_PERCENT: "0.02", MAX_OPEN_TRADES: "2" };
  assert.notEqual(P.configHash(base), P.configHash(changed));
});

test("config_hash is independent of env key insertion order", () => {
  const env1 = { OANDA_ENV: "practice", SYMBOLS: "EUR_USD", TIMEFRAME: "M5" };
  const env2 = { TIMEFRAME: "M5", SYMBOLS: "EUR_USD", OANDA_ENV: "practice" };
  assert.equal(P.configHash(env1), P.configHash(env2));
});

test("buildConfigSurface applies documented defaults", () => {
  const s = P.buildConfigSurface({});
  assert.equal(s.version, P.SYSTEM_VERSION);
  assert.equal(s.timeframe, "M5");
  assert.equal(s.riskPercent, "0.01");
  assert.equal(s.maxOpenTrades, "2");
  assert.equal(s.maxDailyTrades, "50");
  assert.equal(s.minStrength, "0.08");
  assert.equal(s.shadowMode, "OBSERVE");
});

test("build_id has the reproducible <version>+<sha|unknown> shape", () => {
  const withEnv = P.resolveBuildId({ RAILWAY_GIT_COMMIT_SHA: "abcdef1234567890" });
  assert.equal(withEnv, `${P.SYSTEM_VERSION}+abcdef123456`);

  const generic = P.resolveBuildId({});
  assert.ok(generic.startsWith(`${P.SYSTEM_VERSION}+`), "must start with version");
  const sha = generic.split("+")[1];
  assert.ok(sha === "unknown" || /^[0-9a-f]{12}$/.test(sha), `unexpected sha segment: ${sha}`);
});

test("confidence_level tiers: LOW <30, MEDIUM 30–100, HIGH >100", () => {
  assert.equal(P.confidenceLevel(0), "LOW");
  assert.equal(P.confidenceLevel(29), "LOW");
  assert.equal(P.confidenceLevel(30), "MEDIUM");
  assert.equal(P.confidenceLevel(100), "MEDIUM");
  assert.equal(P.confidenceLevel(101), "HIGH");
  assert.equal(P.confidenceLevel(5000), "HIGH");
  // defensive: non-numeric → LOW
  assert.equal(P.confidenceLevel(undefined), "LOW");
  assert.equal(P.confidenceLevel(NaN), "LOW");
});

test("createProvenance().stamp() adds the provenance triple", () => {
  const prov = P.createProvenance({
    env: { OANDA_ENV: "live" },
    runId: "run-fixed",
    buildId: "v40.1+deadbeef1234",
    configHash: "f".repeat(64),
  });
  const row = prov.stamp({ signal_id: "S1", engine_id: "A" });
  assert.equal(row.signal_id, "S1");
  assert.equal(row.engine_id, "A");
  assert.equal(row.run_id, "run-fixed");
  assert.equal(row.build_id, "v40.1+deadbeef1234");
  assert.equal(row.config_hash, "f".repeat(64));
  // stamp returns a new object (does not mutate input)
  const input = { x: 1 };
  const stamped = prov.stamp(input);
  assert.notEqual(stamped, input);
  assert.equal(input.run_id, undefined);
});

test("run_id is unique per provenance context", () => {
  const a = P.createProvenance({ env: {} });
  const b = P.createProvenance({ env: {} });
  assert.notEqual(a.runId, b.runId);
  assert.match(a.runId, /^[0-9a-f-]{36}$/);
});
