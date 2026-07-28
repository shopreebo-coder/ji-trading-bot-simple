"use strict";

/**
 * CooperativeManager — deterministic bridge between Live Bot and advisors.
 * It does not learn, call APIs, persist data, or own a position.
 */
const ENTRY_ACTIONS = new Set(["TRADE", "NO_TRADE", "ABSTAIN"]);
const ADVISORY_ACTIONS = new Set(["HOLD", "MOVE_SL", "MOVE_BE", "TAKE_PARTIAL", "REQUEST_CLOSE"]);

class CooperativeManager {
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