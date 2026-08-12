"use strict";
/**
 * SPRINT 9 — ModuleStatusManager integration tests
 *
 * Verifies the read-only module status registry that feeds the dashboard
 * MODUŁY tab (project rule: no hidden modules — every module gets a card).
 *
 * Run:  node --test --test-reporter=spec telemetry/tests/integration/moduleStatus.test.js
 * Needs DATABASE_URL (uses the shared db-adapter; all queries are read-only).
 * NEVER spawns server.js.
 */

const { test } = require("node:test");
const assert = require("node:assert");
const { db } = require("../../db-adapter");
const { ModuleStatusManager, MODULE_STATUS } = require("../../managers");

const VALID_STATUSES = Object.values(MODULE_STATUS);

function makeManager(overrides = {}) {
  return new ModuleStatusManager({
    db,
    flags: {
      memory:          { enabled: true,  raw: undefined },
      research:        { enabled: false, raw: undefined },
      knowledge:       { enabled: false, raw: undefined },
      selectedEngine:  { enabled: false, raw: undefined },
      selectedAdvisor: { enabled: true,  raw: undefined },
      reconciler:      { enabled: true,  raw: undefined },
      ...(overrides.flags || {}),
    },
    getShadowMode: overrides.getShadowMode || (() => "OBSERVE"),
    getShadowMStats: overrides.getShadowMStats || (async () => null),
    selectedAdvisor: overrides.selectedAdvisor || {
      getStatus: () => ({ enabled: true, pending: 0, ring: { size: 0, capacity: 100 }, counters: {} }),
      getAdvisories: () => [],
    },
    selectedEngine: overrides.selectedEngine || {
      getStatus: async () => ({ running: false, ring: { size: 0, capacity: 50 }, engineCount: 0, knowledgeDomains: [] }),
    },
    telemetryReconciler: overrides.telemetryReconciler || {
      getStats: () => ({ credsPresent: false, pollCount: 0, syntheticWritten: 0, pendingWithinGrace: 0, pendingRetry: 0 }),
    },
    memoryIntegration: overrides.memoryIntegration || { getStatus: () => ({ enabled: true }) },
    runtimeStartedAt: overrides.runtimeStartedAt,
    getLiveState: overrides.getLiveState || (() => ({ botStatus: "running", openTrades: {}, dailyTrades: 0 })),
  });
}

test("registry covers all modules with valid statuses and full card contract", async () => {
  const out = await makeManager().build();

  assert.ok(Array.isArray(out.modules), "modules array");
  assert.ok(out.modules.length >= 22, `expected >=22 modules, got ${out.modules.length}`);
  assert.ok(out.generated, "generated timestamp");
  assert.ok(out.rule && out.rule.includes("no hidden modules"), "project rule string");

  const requiredIds = [
    "live-engine", "exit-engine", "exit-engine-x", "shadow-gate",
    "shadow-a", "shadow-b", "shadow-c", "shadow-d", "shadow-m",
    "shadowlab-research", "knowledge-layer",
    "selected-engine", "selected-advisor", "ai-analysis",
    "memory", "runtime-domain-manager", "trade-intent-manager",
    "telemetry-core", "telemetry-reconciler", "health-monitor",
    "recovery-manager", "validation-manager",
  ];
  const ids = new Set(out.modules.map((m) => m.id));
  for (const id of requiredIds) assert.ok(ids.has(id), `module present: ${id}`);
  assert.strictEqual(ids.size, out.modules.length, "no duplicate module ids");

  for (const m of out.modules) {
    assert.ok(VALID_STATUSES.includes(m.status), `${m.id}: valid status (${m.status})`);
    assert.strictEqual(typeof m.name, "string");
    assert.strictEqual(typeof m.tier, "string");
    assert.strictEqual(typeof m.connected, "boolean", `${m.id}: connected boolean`);
    assert.strictEqual(typeof m.collectsData, "boolean", `${m.id}: collectsData boolean`);
    assert.strictEqual(typeof m.influencesLive, "boolean", `${m.id}: influencesLive boolean`);
    assert.ok(m.observations === null || typeof m.observations === "number",
      `${m.id}: observations number|null`);
    assert.ok(m.stats && typeof m.stats === "object", `${m.id}: stats object`);
  }

  // summary counts match modules
  const counted = Object.values(out.summary).reduce((a, b) => a + b, 0);
  assert.strictEqual(counted, out.modules.length, "summary sums to module count");
});

test("ACTIVE influence is reserved for live paths and completed advisory hand-offs", async () => {
  const out = await makeManager().build();
  const influencers = out.modules.filter((m) => m.influencesLive).map((m) => m.id).sort();
  const expected = ["exit-engine", "live-engine", "shadow-m"];
  for (const letter of ["a", "b", "c"]) {
    const module = out.modules.find((m) => m.id === `shadow-${letter}`);
    const complete = module.stats.generated > 0 && module.stats.delivered > 0 && module.stats.read > 0;
    assert.equal(module.influencesLive, complete,
      `Shadow ${letter.toUpperCase()} influence follows generated/delivered/read telemetry`);
    if (complete) expected.push(`shadow-${letter}`);
  }
  const selectedAdvisor = out.modules.find((m) => m.id === "selected-advisor");
  const advisorHandshake = selectedAdvisor.stats.entryHandshake || {};
  if (advisorHandshake.generated > 0 &&
      advisorHandshake.delivered > 0 &&
      advisorHandshake.read > 0) {
    expected.push("selected-advisor");
  }
  assert.deepStrictEqual(influencers, expected.sort());
  const gate = out.modules.find((m) => m.id === "shadow-gate");
  assert.strictEqual(gate.status, MODULE_STATUS.OBSERVING);
});

test("historical lifecycle rows do not activate the current runtime", async () => {
  const futureRuntime = new Date(Date.now() + 60_000).toISOString();
  const out = await makeManager({ runtimeStartedAt: futureRuntime }).build();

  for (const letter of ["a", "b", "c"]) {
    const module = out.modules.find((m) => m.id === `shadow-${letter}`);
    assert.deepStrictEqual(
      { generated: module.stats.generated, delivered: module.stats.delivered, read: module.stats.read },
      { generated: 0, delivered: 0, read: 0 },
      `Shadow ${letter.toUpperCase()} ignores pre-runtime lifecycle rows`,
    );
    assert.strictEqual(module.influencesLive, false);
  }

  const advisor = out.modules.find((m) => m.id === "selected-advisor");
  assert.deepStrictEqual(advisor.stats.entryHandshake, { generated: 0, delivered: 0, read: 0 });
  assert.strictEqual(advisor.influencesLive, false);
});

test("GATE mode promotes shadow-gate and shadow-d to ACTIVE with influence", async () => {
  const out = await makeManager({ getShadowMode: () => "GATE" }).build();
  const gate = out.modules.find((m) => m.id === "shadow-gate");
  const d    = out.modules.find((m) => m.id === "shadow-d");
  assert.strictEqual(gate.status, MODULE_STATUS.ACTIVE);
  assert.strictEqual(gate.influencesLive, true);
  assert.strictEqual(d.status, MODULE_STATUS.ACTIVE);
  assert.strictEqual(d.influencesLive, true);
});

test("kill-switch semantics: explicit off → DISABLED, default-off → INSTALLED, on → LEARNING", async () => {
  const explicitOff = await makeManager({
    flags: { knowledge: { enabled: false, raw: "off" } },
  }).build();
  assert.strictEqual(explicitOff.modules.find((m) => m.id === "knowledge-layer").status,
    MODULE_STATUS.DISABLED);

  const defaultOff = await makeManager().build();
  const kDefault = defaultOff.modules.find((m) => m.id === "knowledge-layer");
  assert.strictEqual(kDefault.status, MODULE_STATUS.INSTALLED);
  assert.ok(/Waiting for activation/.test(kDefault.reason), "default-off reason mentions activation");

  const on = await makeManager({
    flags: { knowledge: { enabled: true, raw: "on" }, research: { enabled: true, raw: "on" } },
  }).build();
  assert.strictEqual(on.modules.find((m) => m.id === "knowledge-layer").status, MODULE_STATUS.LEARNING);
  assert.strictEqual(on.modules.find((m) => m.id === "shadowlab-research").status, MODULE_STATUS.LEARNING);
});

test("reconciler without OANDA creds reports INSTALLED / waiting for credentials", async () => {
  const out = await makeManager().build();
  const rec = out.modules.find((m) => m.id === "telemetry-reconciler");
  assert.strictEqual(rec.status, MODULE_STATUS.INSTALLED);
  assert.ok(/OANDA credentials/.test(rec.reason));
  assert.strictEqual(rec.influencesLive, false);
});

test("planned Sprint 7 managers are NOT INSTALLED (visible, never hidden)", async () => {
  const out = await makeManager().build();
  for (const id of ["recovery-manager", "validation-manager"]) {
    const m = out.modules.find((x) => x.id === id);
    assert.strictEqual(m.status, MODULE_STATUS.NOT_INSTALLED);
    assert.ok(/Sprint 7/.test(m.reason));
  }
});

test("registry never throws even when every manager getter fails", async () => {
  const out = await makeManager({
    getShadowMode: () => { throw new Error("boom"); },
    getShadowMStats: async () => { throw new Error("boom"); },
    selectedAdvisor: { getStatus: () => { throw new Error("boom"); }, getAdvisories: () => { throw new Error("boom"); } },
    selectedEngine: { getStatus: async () => { throw new Error("boom"); } },
    telemetryReconciler: { getStats: () => { throw new Error("boom"); } },
    memoryIntegration: { getStatus: () => { throw new Error("boom"); } },
    getLiveState: () => { throw new Error("boom"); },
  }).build();
  assert.ok(out.modules.length >= 21, "still returns full registry");
  for (const m of out.modules) {
    assert.ok(VALID_STATUSES.includes(m.status), `${m.id}: valid status under failure`);
  }
});
