"use strict";

/**
 * CooperativeManager — deterministic bridge between Live Bot and advisors.
 * It does not learn, call APIs, persist data, or own a position.
 */
const ENTRY_ACTIONS = new Set(["TRADE", "NO_TRADE", "ABSTAIN"]);
const ADVISORY_ACTIONS = new Set(["HOLD", "MOVE_SL", "MOVE_BE", "TAKE_PARTIAL", "REQUEST_CLOSE"]);
const CAPITAL_GATE_DECISIONS = new Set(["ALLOW", "ABSTAIN", "BLOCK"]);
const KNOWLEDGE_BOOTSTRAP_ABSTAIN = "knowledge_evidence_unavailable";

function canCollectLiveBaseline({ decision = null, reason = null } = {}) {
  return decision === "ABSTAIN" && reason === KNOWLEDGE_BOOTSTRAP_ABSTAIN;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function confidenceScore(value) {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric;
  switch (String(value || "").toUpperCase()) {
    case "HIGH": return 1;
    case "MEDIUM": return 0.6;
    case "LOW": return 0.3;
    default: return null;
  }
}

function confidenceTier(value) {
  const score = confidenceScore(value);
  if (score === null) return null;
  if (score >= 0.8) return "HIGH";
  if (score >= 0.5) return "MEDIUM";
  return "LOW";
}

class CooperativeManager {
  entryPolicy(result = {}, options = {}) {
    const high = Number.isFinite(Number(options.highConfidence))
      ? Number(options.highConfidence) : 0.8;
    const score = finiteNumber(result.confidenceScore);
    const highConfidence = result.confidenceTier === "HIGH" ||
      (Number.isFinite(score) && score >= high);
    const decision = ENTRY_ACTIONS.has(result.decision) ? result.decision : "ABSTAIN";
    return {
      decision,
      highConfidence,
      // Selected Engine is an information source. Only the explicit
      // three-state capital gate below may produce an execution veto.
      action: "ADVISORY",
      suggestedAction: decision === "NO_TRADE" && highConfidence
        ? "BLOCK"
        : decision === "TRADE" && highConfidence
          ? "ALLOW"
          : "ABSTAIN",
      confidenceScore: score,
      confidenceTier: result.confidenceTier || null,
      authoritativeLayer: "live_bot",
    };
  }

  static aggregateShadowConfidence(outputs = {}) {
    const decided = Object.values(outputs || {})
      .filter((output) => output && (output.recommendation === "TRADE" || output.recommendation === "NO_TRADE"));
    if (!decided.length) return "NONE";
    const scores = decided.map((output) => confidenceScore(output.confidence));
    if (scores.some((score) => score === null)) return "NONE";
    return confidenceTier(Math.min(...scores));
  }

  /**
   * Emergency capital safety state.
   *
   * This is deliberately conservative and does not rank or weight engines:
   * it requires complete, same-signal, high-confidence agreement before ALLOW.
   * Missing, malformed, conflicting, or low-confidence evidence is ABSTAIN.
   */
  capitalGate({
    liveEvidence = {},
    shadowConsensus = null,
    shadowSignalId = null,
    shadowConfidence = null,
    selectedEngineDecision = null,
    selectedEngineConfidence = null,
    knowledgeEvidence = null,
  } = {}) {
    const signalId = liveEvidence.signalId || liveEvidence.signal_id;
    const symbol = liveEvidence.symbol;
    const side = String(liveEvidence.side || "").toLowerCase();
    const liveNumbers = [
      finiteNumber(liveEvidence.spread),
      finiteNumber(liveEvidence.atrPips),
    ];
    if (!signalId || !symbol || !["buy", "sell"].includes(side) || liveNumbers.some((n) => n === null)) {
      return {
        decision: "ABSTAIN",
        reason: "missing_or_malformed_live_evidence",
        evidenceComplete: false,
      };
    }
    if (!shadowSignalId || String(shadowSignalId) !== String(signalId)) {
      return {
        decision: "ABSTAIN",
        reason: "shadow_signal_identity_mismatch",
        evidenceComplete: false,
      };
    }

    const selectedDecision = ENTRY_ACTIONS.has(selectedEngineDecision)
      ? selectedEngineDecision
      : "ABSTAIN";
    const selectedScore = confidenceScore(selectedEngineConfidence);
    const selectedTier = confidenceTier(selectedEngineConfidence);
    const expectedShadowIds = ["A", "B", "C"];
    const shadowRecommendations = shadowConsensus?.recommendations || {};
    const validShadowConsensus = shadowConsensus &&
      ["TRADE", "NO_TRADE", "SPLIT", "ABSTAIN"].includes(shadowConsensus.consensus) &&
      Number.isInteger(Number(shadowConsensus.decided)) &&
      Number(shadowConsensus.decided) >= 0 &&
      Array.isArray(shadowConsensus.engineIds) &&
      shadowConsensus.engineIds.slice().sort().join(",") === expectedShadowIds.join(",") &&
      Object.keys(shadowRecommendations).sort().join(",") === expectedShadowIds.join(",") &&
      expectedShadowIds.every((id) => ["TRADE", "NO_TRADE", "ABSTAIN"].includes(shadowRecommendations[id])) &&
      ["votesFor", "votesAgainst", "abstain"].every((key) =>
        Number.isInteger(Number(shadowConsensus[key])) && Number(shadowConsensus[key]) >= 0
      ) &&
      Number(shadowConsensus.votesFor) +
        Number(shadowConsensus.votesAgainst) +
        Number(shadowConsensus.abstain) === Number(shadowConsensus.decided) +
        Number(shadowConsensus.abstain);
    const shadowTier = confidenceTier(shadowConfidence);
    const knowledgeAvailable = knowledgeEvidence &&
      knowledgeEvidence.available === true &&
      Number(knowledgeEvidence.matchCount) > 0;

    if (!validShadowConsensus) {
      return { decision: "ABSTAIN", reason: "shadow_consensus_missing_or_malformed", evidenceComplete: false };
    }
    if (!knowledgeAvailable) {
      return { decision: "ABSTAIN", reason: "knowledge_evidence_unavailable", evidenceComplete: false };
    }
    if (shadowConsensus.consensus === "SPLIT" || shadowConsensus.consensus === "ABSTAIN") {
      return { decision: "ABSTAIN", reason: "shadow_consensus_ambiguous", evidenceComplete: false };
    }
    if (shadowConsensus.recommendations?.A === "ABSTAIN" ||
        shadowConsensus.recommendations?.B === "ABSTAIN" ||
        shadowConsensus.recommendations?.C === "ABSTAIN") {
      return { decision: "ABSTAIN", reason: "shadow_abc_incomplete", evidenceComplete: false };
    }
    if (Number(shadowConsensus.votesFor) > 0 && Number(shadowConsensus.votesAgainst) > 0) {
      return { decision: "ABSTAIN", reason: "shadow_consensus_conflict", evidenceComplete: false };
    }
    if (selectedDecision === "ABSTAIN" || selectedScore === null || selectedTier === null) {
      return { decision: "ABSTAIN", reason: "selected_engine_evidence_incomplete", evidenceComplete: false };
    }
    if (shadowTier === null || shadowTier === "NONE") {
      return { decision: "ABSTAIN", reason: "shadow_confidence_unavailable", evidenceComplete: false };
    }
    if (selectedDecision !== shadowConsensus.consensus) {
      return { decision: "ABSTAIN", reason: "selected_shadow_conflict", evidenceComplete: false };
    }
    if (selectedTier !== "HIGH" || shadowTier !== "HIGH" || selectedScore < 0.8) {
      return { decision: "ABSTAIN", reason: "confidence_below_capital_threshold", evidenceComplete: false };
    }
    if (selectedDecision === "NO_TRADE") {
      return {
        decision: "BLOCK",
        reason: "high_confidence_shadow_selected_no_trade",
        evidenceComplete: true,
      };
    }
    return {
      decision: "ALLOW",
      reason: "complete_high_confidence_agreement_no_capital_problem",
      evidenceComplete: true,
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

module.exports = { CooperativeManager, canCollectLiveBaseline };