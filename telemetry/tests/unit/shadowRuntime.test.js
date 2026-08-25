"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { db } = require("../../db-adapter");

const controlPath = path.join(os.tmpdir(), `shadow-runtime-${process.pid}-${Date.now()}.json`);
process.env.RUNTIME_MODULES_FILE = controlPath;

const runtime = require("../../runtime-control");
const { shadowGate, ShadowQualityEngine, ShadowContextEngine } = require("../../shadowlab");

const signal = {
  signalId: "runtime-toggle-test",
  symbol: "EUR_USD",
  side: "buy",
  session: "LONDON",
};

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test("Shadow A/B abstain instead of inventing confidence from missing evidence", () => {
  const a = ShadowQualityEngine.evaluate(signal);
  const b = ShadowContextEngine.evaluate(signal);

  assert.equal(a.wouldTrade, null);
  assert.equal(a.confidence, "NONE");
  assert.match(a.reason, /insufficient_evidence/);
  assert.equal(b.wouldTrade, null);
  assert.equal(b.confidence, "NONE");
  assert.equal(b.marketState, "UNKNOWN");
  assert.match(b.reason, /insufficient_evidence/);
});

async function lifecycleRows(signalId, letter, stage) {
  return db.all(
    `SELECT type, data FROM events WHERE type=? AND data LIKE ?`,
    `shadow_${letter}_advisory_${stage}`,
    `%${signalId}%`,
  );
}

async function waitForLifecycleRows(signalId, letter, stage, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  do {
    rows = await lifecycleRows(signalId, letter, stage);
    if (rows.length > 0) return rows;
    await wait(50);
  } while (Date.now() < deadline);
  return rows;
}

test.after(() => {
  try { fs.unlinkSync(controlPath); } catch (_) {}
});

test("Shadow A/B/C runtime OFF removes only that engine from advisory pipeline", () => {
  runtime.ensureRuntimeDefaults({
    "shadow-a": true,
    "shadow-b": true,
    "shadow-c": true,
    "shadow-d": true,
    "shadow-gate": true,
  });

  const baseline = shadowGate(signal);
  assert.equal(baseline.blocked, false, "OBSERVE remains fail-open");
  assert.equal(baseline.advisoryOnly, true);
  assert.equal(baseline.authoritativeLayer, "live_bot");
  assert.deepEqual(baseline.runtime, { A: true, B: true, C: true, D: true, gate: true });

  for (const letter of ["a", "b", "c", "d"]) {
    runtime.setRuntimeEnabled(`shadow-${letter}`, false);
    const result = shadowGate({ ...signal, signalId: `runtime-off-${letter}` });
    const engine = result.advisory.engines[letter.toUpperCase()];
    assert.equal(result.blocked, false, `${letter} OFF never blocks Live Bot`);
    assert.equal(engine.disabled, true, `${letter} is marked disabled`);
    assert.equal(engine.reason, `shadow_${letter}_runtime_off`);
    assert.equal(result.authoritativeLayer, "live_bot");
    runtime.setRuntimeEnabled(`shadow-${letter}`, true);
  }
});

test("Shadow Gate OFF is an explicit fail-open no-op", () => {
  runtime.ensureRuntimeDefaults({
    "shadow-a": true,
    "shadow-b": true,
    "shadow-c": true,
    "shadow-d": true,
    "shadow-gate": false,
  });
  const result = shadowGate(signal);
  assert.deepEqual(result.runtime, { A: true, B: true, C: true, D: true, gate: false });
  assert.equal(result.mode, "DISABLED");
  assert.equal(result.reason, "shadow_gate_runtime_off");
  assert.equal(result.blocked, false);
  assert.equal(result.advisoryOnly, true);
});

test("A/B/C/D ON generate independent outputs before the Selected hand-off", async () => {
  runtime.ensureRuntimeDefaults({
    "shadow-a": true,
    "shadow-b": true,
    "shadow-c": true,
    "shadow-d": true,
    "shadow-gate": true,
  });
  const signalId = `advisory-on-${process.pid}-${Date.now()}`;
  const result = shadowGate({ ...signal, signalId });

  assert.deepEqual(Object.keys(result.advisory.outputs).sort(), ["A", "B", "C", "D"]);
  assert.equal(result.advisory.outputs.D.engineId, "ENGINE_D_META");
  assert.equal(result.advisory.outputs.D.evaluation.advisoryOnly, true);
  assert.equal(result.advisory.outputs.D.evaluation.authoritativeLayer, "live_bot");
  assert.equal(result.advisory.advisoryOnly, true);
  assert.equal(result.advisory.authoritativeLayer, "live_bot");
  assert.equal(result.advisory.channel, "live_entry_decision_context");
  assert.deepEqual(result.advisory.delivery, {
    target: "selected_advisor",
    channel: "live_entry_decision_context",
    generated: true,
    delivered: false,
    read: false,
    usedForDecision: false,
  });

  for (const letter of ["a", "b", "c"]) {
    const generated = await waitForLifecycleRows(signalId, letter, "generated");
    const delivered = await waitForLifecycleRows(signalId, letter, "delivered");
    const read = await waitForLifecycleRows(signalId, letter, "read");
    assert.equal(generated.length, 1, `${letter.toUpperCase()} advisory generated`);
    assert.equal(delivered.length, 0, `${letter.toUpperCase()} is not falsely marked delivered by Shadow Gate`);
    assert.equal(read.length, 0, `${letter.toUpperCase()} is not falsely marked read by Shadow Gate`);
  }
});

test("A/B/C OFF generate no advisory and cannot influence Live", async () => {
  runtime.ensureRuntimeDefaults({
    "shadow-a": true,
    "shadow-b": true,
    "shadow-c": true,
    "shadow-d": true,
    "shadow-gate": true,
  });
  const signalId = `advisory-off-${process.pid}-${Date.now()}`;
  for (const letter of ["a", "b", "c"]) {
    runtime.setRuntimeEnabled(`shadow-${letter}`, false);
    try {
      const result = shadowGate({ ...signal, signalId: `${signalId}-${letter}` });
      assert.equal(result.blocked, false, `${letter.toUpperCase()} OFF is fail-open`);
      assert.equal(result.advisory.outputs[letter.toUpperCase()], undefined);
      assert.equal(result.advisory.delivery.usedForDecision, false);
    } finally {
      runtime.setRuntimeEnabled(`shadow-${letter}`, true);
    }
  }
  await wait(100);
  for (const letter of ["a", "b", "c"]) {
    for (const stage of ["generated", "delivered", "read"]) {
      assert.equal(
        (await lifecycleRows(`${signalId}-${letter}`, letter, stage)).length,
        0,
        `${letter.toUpperCase()} OFF has no ${stage} advisory`,
      );
    }
  }
});
