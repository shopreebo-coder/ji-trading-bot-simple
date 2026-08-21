"use strict";

/**
 * Small cross-process runtime control channel.
 *
 * telemetry/server.js and the spawned index.js process do not share memory.
 * This file is therefore deliberately synchronous and dependency-free so the
 * shadow gate can read the latest controls from its synchronous hot path.
 * Writes are atomic (temporary file + rename) and always fail closed to the
 * supplied defaults when the control file is unavailable.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const CONTROL_PATH = process.env.RUNTIME_MODULES_FILE ||
  path.join(
    os.tmpdir(),
    `forex-engine-runtime-${process.env.REPL_ID || process.env.RAILWAY_PROJECT_ID || "default"}.json`,
  );

const DEFAULT_RUNTIME_MODULES = Object.freeze({
  "shadow-a":      true,
  "shadow-b":      true,
  "shadow-c":      true,
  "shadow-d":      true,
  "shadow-d-meta": true,   // Shadow D Meta Trade Manager (advisory only)
  "shadow-gate":   true,
});

function readRuntimeState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROL_PATH, "utf8"));
    return {
      schema: 1,
      modules: parsed && parsed.modules && typeof parsed.modules === "object"
        ? { ...parsed.modules }
        : {},
    };
  } catch (_) {
    return { schema: 1, modules: {} };
  }
}

function writeRuntimeState(state) {
  const dir = path.dirname(CONTROL_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${CONTROL_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    schema: 1,
    modules: { ...(state.modules || {}) },
  }, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, CONTROL_PATH);
}

function ensureRuntimeDefaults(defaults = DEFAULT_RUNTIME_MODULES) {
  const current = readRuntimeState();
  const modules = { ...current.modules };
  for (const [id, enabled] of Object.entries(defaults || {})) {
    modules[id] = !!enabled;
  }
  writeRuntimeState({ schema: 1, modules });
  return { schema: 1, modules };
}

function setRuntimeEnabled(id, enabled) {
  if (!id || typeof id !== "string") throw new Error("runtime module id is required");
  const current = readRuntimeState();
  current.modules[id] = !!enabled;
  writeRuntimeState(current);
  return !!enabled;
}

function getRuntimeEnabled(id, fallback = true) {
  const current = readRuntimeState();
  return Object.prototype.hasOwnProperty.call(current.modules, id)
    ? current.modules[id] !== false
    : !!fallback;
}

module.exports = {
  CONTROL_PATH,
  DEFAULT_RUNTIME_MODULES,
  readRuntimeState,
  writeRuntimeState,
  ensureRuntimeDefaults,
  setRuntimeEnabled,
  getRuntimeEnabled,
};