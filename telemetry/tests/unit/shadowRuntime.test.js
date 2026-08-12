"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const controlPath = path.join(os.tmpdir(), `shadow-runtime-${process.pid}-${Date.now()}.json`);
process.env.RUNTIME_MODULES_FILE = controlPath;

const runtime = require("../../runtime-control");
const { shadowGate } = require("../../shadowlab");

const signal = {
  signalId: "runtime-toggle-test",
  symbol: "EUR_USD",
  side: "buy",
  session: "LONDON",
};

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

  for (const letter of ["a", "b", "c"]) {
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
