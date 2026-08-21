"use strict";

// Pure contract helpers for passing D Meta advice across process boundaries.
// These helpers never decide, gate, execute, or mutate the source suggestion.

function copy(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function buildDMetaHandoff({
  suggestion = null,
  handoffType = "entry",
  signal = {},
  position = null,
  knowledgeEvidence = null,
} = {}) {
  if (!suggestion || typeof suggestion !== "object") return null;

  const result = copy(suggestion);
  const timestamp = result.generatedAt || new Date().toISOString();
  const signalId = signal.signalId || signal.signal_id || null;
  const symbol = signal.symbol || null;

  return {
    ...result,
    handoffType,
    suggestionId: result.suggestionId || `${signalId || symbol || "unknown"}:${handoffType}:${timestamp}`,
    signalId,
    symbol,
    direction: signal.side || signal.direction || null,
    recommendation: result.action || null,
    strength: result.confidence || null,
    timestamp,
    entryContext: handoffType === "entry" ? copy(signal) : null,
    positionContext: handoffType === "position" ? copy(position || {}) : null,
    knowledgeEvidence: copy(knowledgeEvidence),
    advisoryOnly: true,
    authoritativeLayer: "live_bot",
  };
}

function classifyDMetaReaction(suggestion, liveAction) {
  if (!suggestion || !suggestion.action) return "IGNORE";
  const action = String(suggestion.action).toUpperCase();
  const live = String(liveAction || "").toUpperCase();
  const matches = {
    ENTER: ["TRADE", "ENTER", "ALLOW"],
    WAIT: ["ABSTAIN", "WAIT", "HOLD"],
    REJECT: ["NO_TRADE", "REJECT", "ABSTAIN"],
    HOLD: ["HOLD"],
    HOLD_WITH_CAUTION: ["HOLD"],
    PROTECT: ["MOVE_BE", "MOVE_SL", "PROTECT"],
    REDUCE: ["REDUCE", "REQUEST_CLOSE", "CLOSE"],
    EXIT: ["EXIT", "REQUEST_CLOSE", "CLOSE"],
  };
  return (matches[action] || []).includes(live) ? "ACCEPT" : "REJECT";
}

module.exports = { buildDMetaHandoff, classifyDMetaReaction };