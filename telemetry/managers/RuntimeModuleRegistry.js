"use strict";

const {
  ensureRuntimeDefaults,
  setRuntimeEnabled,
} = require("../runtime-control");

/**
 * Runtime lifecycle registry.
 *
 * A definition with a lifecycle adapter is started/stopped in this process.
 * A definition without one is still represented in the registry, but its
 * runtime state is controlled by the cross-process runtime-control channel
 * (used by shadowlab.js). Protected modules are intentionally non-toggleable.
 */
class RuntimeModuleRegistry {
  constructor({ logger = console } = {}) {
    this.log = logger;
    this._definitions = new Map();
    this._started = false;
  }

  register({
    id,
    enabled = true,
    toggleable = true,
    lifecycle = null,
    control = false,
    reason = null,
  }) {
    if (!id) throw new Error("RuntimeModuleRegistry: module id is required");
    this._definitions.set(id, {
      id,
      initialEnabled: !!enabled,
      runtimeEnabled: !!enabled,
      toggleable: !!toggleable,
      lifecycle,
      control: !!control,
      protectedReason: reason,
      lastChangedAt: null,
      transition: null,
    });
    return this;
  }

  async startInitial() {
    const defaults = {};
    for (const def of this._definitions.values()) {
      if (def.control) defaults[def.id] = def.initialEnabled;
    }
    if (Object.keys(defaults).length) ensureRuntimeDefaults(defaults);

    for (const def of this._definitions.values()) {
      def.runtimeEnabled = def.initialEnabled;
      if (def.runtimeEnabled && def.lifecycle && typeof def.lifecycle.start === "function") {
        try {
          await def.lifecycle.start();
        } catch (error) {
          def.runtimeEnabled = false;
          this.log.error?.(`[RUNTIME] ${def.id} start failed: ${error.message}`);
          throw error;
        }
      }
    }
    this._started = true;
    return this;
  }

  async setEnabled(id, enabled) {
    const def = this._definitions.get(id);
    if (!def) {
      const error = new Error(`Unknown runtime module: ${id}`);
      error.code = "UNKNOWN_MODULE";
      throw error;
    }
    if (!def.toggleable) {
      const error = new Error(def.protectedReason || `${id} is protected and cannot be toggled at runtime`);
      error.code = "PROTECTED_MODULE";
      throw error;
    }

    const next = !!enabled;
    if (next === def.runtimeEnabled) return this.getStatus(id);
    def.transition = next ? "starting" : "stopping";
    let result;
    try {
      if (def.lifecycle) {
        const method = next ? def.lifecycle.start : def.lifecycle.stop;
        if (typeof method !== "function") throw new Error(`${id} has no ${next ? "start" : "stop"} lifecycle`);
        await method.call(def.lifecycle);
      }
      if (def.control) setRuntimeEnabled(def.id, next);
      def.runtimeEnabled = next;
      def.lastChangedAt = new Date().toISOString();
      result = this.getStatus(id);
    } finally {
      def.transition = null;
    }
    return { ...result, transition: null };
  }

  getStatus(id) {
    const def = this._definitions.get(id);
    if (!def) return null;
    return {
      id: def.id,
      runtimeEnabled: def.runtimeEnabled,
      toggleable: def.toggleable,
      transition: def.transition,
      lastChangedAt: def.lastChangedAt,
      toggleReason: def.toggleable ? null : (def.protectedReason || "Protected module"),
    };
  }

  getAll() {
    return [...this._definitions.keys()].map((id) => this.getStatus(id));
  }

  async stopAll() {
    for (const def of [...this._definitions.values()].reverse()) {
      if (!def.runtimeEnabled || !def.lifecycle || typeof def.lifecycle.stop !== "function") continue;
      try {
        await def.lifecycle.stop();
      } catch (error) {
        this.log.error?.(`[RUNTIME] ${def.id} stop failed: ${error.message}`);
      }
      def.runtimeEnabled = false;
    }
    this._started = false;
  }
}

module.exports = { RuntimeModuleRegistry };