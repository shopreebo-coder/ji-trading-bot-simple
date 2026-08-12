"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const controlPath = path.join(
  os.tmpdir(),
  `telemetry-runtime-${process.pid}-${Date.now()}.json`,
);
process.env.RUNTIME_MODULES_FILE = controlPath;

const { RuntimeModuleRegistry } = require("../../managers/RuntimeModuleRegistry");
const { getRuntimeEnabled, readRuntimeState } = require("../../runtime-control");

test.after(() => {
  try { fs.unlinkSync(controlPath); } catch (_) {}
});

test("runtime registry starts, stops, and restarts lifecycle modules", async () => {
  const calls = [];
  const lifecycle = {
    async start() { calls.push("start"); },
    async stop() { calls.push("stop"); },
  };
  const registry = new RuntimeModuleRegistry({ logger: { error() {} } });
  registry.register({ id: "shadow-a", enabled: true, control: true, lifecycle });

  await registry.startInitial();
  assert.deepEqual(calls, ["start"]);
  assert.equal(getRuntimeEnabled("shadow-a"), true);

  const off = await registry.setEnabled("shadow-a", false);
  assert.equal(off.runtimeEnabled, false);
  assert.deepEqual(calls, ["start", "stop"]);
  assert.equal(getRuntimeEnabled("shadow-a"), false);

  const on = await registry.setEnabled("shadow-a", true);
  assert.equal(on.runtimeEnabled, true);
  assert.deepEqual(calls, ["start", "stop", "start"]);
  assert.equal(readRuntimeState().modules["shadow-a"], true);
});

test("protected modules reject runtime changes", async () => {
  const registry = new RuntimeModuleRegistry();
  registry.register({
    id: "live-engine",
    enabled: true,
    toggleable: false,
    reason: "Live Bot is authoritative",
  });
  await assert.rejects(
    registry.setEnabled("live-engine", false),
    (error) => error.code === "PROTECTED_MODULE" && /authoritative/.test(error.message),
  );
});
