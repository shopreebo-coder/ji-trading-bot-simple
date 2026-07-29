"use strict";

/**
 * CooperativeManager — deterministic bridge between Live Bot and advisors.
 * It does not learn, call APIs, persist data, or own a position.
 */
const ENTRY_ACTIONS = new Set(["TRADE", "NO_TRADE", "ABSTAIN"]);
const ADVISORY_ACTIONS = new Set(["HOLD", "MOVE_SL", "MOVE_BE", "TAKE_PARTIAL", "REQUEST_CLOSE"]);

class CooperativeManager {
  entryPolicy(result = {}, options = {}) {
    const high = Number.isFinite(Number(options.highConfidence))
      ? Number(options.highConfidence) : 0.8;
    const score = Number(result.confidenceScore);
    const highConfidence = result.confidenceTier === "HIGH" ||
      (Number.isFinite(score) && score >= high);
    const decision = ENTRY_ACTIONS.has(result.decision) ? result.decision : "ABSTAIN";
    return {
      decision,
      highConfidence,
      action: decision === "NO_TRADE" && highConfidence
        ? "BLOCK"
        : decision === "TRADE" && highConfidence
          ? "ALLOW"
          : "ADVISORY",
      confidenceScore: Number.isFinite(score) ? score : null,
      confidenceTier: result.confidenceTier || null,
    };
  }

  managementPolicy(shadowResult = {}) {
    const allowed = ADVISORY_ACTIONS.has(shadowResult.action)
      ? shadowResult.action
      : "HOLD";
    return {
      action: allowed,
      advisoryOnly: true,
      evidence: shadowResult.evidence || {},
    };
  }

  decideEntry(selectedDecision) {
    return ENTRY_ACTIONS.has(selectedDecision) ? selectedDecision : "ABSTAIN";
  }

  decideManagement(liveAction, shadowAction) {
    const live = ADVISORY_ACTIONS.has(liveAction) ? liveAction : "HOLD";
    const shadow = ADVISORY_ACTIONS.has(shadowAction) ? shadowAction : "HOLD";
    if (shadow === "HOLD") return live;
    if (live === "REQUEST_CLOSE" || live === "TAKE_PARTIAL") return live;
    return shadow;
  }
}

module.exports = { CooperativeManager };