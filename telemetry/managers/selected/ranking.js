"use strict";
/**
 * SHADOW OS v2 — Selected Engine: pure ranking + consensus math.
 *
 * This module is 100% pure (no DB, no I/O, no state). It provides the two
 * numerical primitives the Selected Engine uses to turn a bag of intelligence
 * signals into a ranked package + a tri-state consensus:
 *
 *   1. rankIntelligence(records) — orders intelligence by, IN THIS ORDER:
 *        confidence → statistical expectancy → training events →
 *        artifact version → snapshot freshness
 *      NEVER by win rate alone (win rate is not a ranking key here).
 *
 *   2. computeConsensus(opinions) — tri-state agreement over engine opinions.
 *      An abstaining engine (wouldTrade === null) is EXCLUDED from BOTH the
 *      numerator and the denominator, so abstention is never silently coerced
 *      into a "no" vote (replit.md "Number(null) === 0 coercion trap").
 *
 * Design rule: nothing here can influence a live/shadow/risk decision — it only
 * ranks and summarises already-measured research.
 */

/**
 * Numeric coercion that refuses to fabricate zeros. null / undefined / "" and
 * non-finite values all map to null (NOT 0). Guards the "Number(null) === 0"
 * trap so an absent measurement stays absent.
 * @param {*} x
 * @returns {number|null}
 */
function numOrNull(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Tri-state boolean coercion. Preserves abstention (null) — never collapses it
 * to false. Accepts real booleans and the common DB/string encodings.
 * @param {*} x
 * @returns {boolean|null}
 */
function boolOrNull(x) {
  if (x === true || x === false) return x;
  if (x === null || x === undefined || x === "") return null;
  if (x === 1 || x === "1" || x === "t" || x === "true" || x === "TRUE") return true;
  if (x === 0 || x === "0" || x === "f" || x === "false" || x === "FALSE") return false;
  return null;
}

/**
 * Map an engine-reported confidence tier to a numeric score in [0,1] for
 * ranking. Unknown / missing tiers return null (ranked last, not fabricated 0).
 * @param {string|null|undefined} tier  LOW | MEDIUM | HIGH (case-insensitive)
 * @returns {number|null}
 */
function confidenceToScore(tier) {
  if (tier === null || tier === undefined || tier === "") return null;
  switch (String(tier).toUpperCase()) {
    case "HIGH": return 1.0;
    case "MEDIUM": return 0.6;
    case "LOW": return 0.3;
    default: return null;
  }
}

/**
 * Inverse of confidenceToScore for presentation — a numeric [0,1] score back to
 * a tier label. null in ⇒ null out.
 * @param {number|null} score
 * @returns {string|null}
 */
function scoreToTier(score) {
  const n = numOrNull(score);
  if (n === null) return null;
  if (n >= 0.8) return "HIGH";
  if (n >= 0.5) return "MEDIUM";
  if (n > 0) return "LOW";
  return "LOW";
}

/** Descending comparison where null/undefined always sorts LAST. */
function cmpDescNullsLast(a, b) {
  const an = a === null || a === undefined;
  const bn = b === null || b === undefined;
  if (an && bn) return 0;
  if (an) return 1;   // a is null → after b
  if (bn) return -1;  // b is null → after a
  if (a > b) return -1;
  if (a < b) return 1;
  return 0;
}

/**
 * The Selected Engine ranking key order. Each record is normalised to:
 *   { source, kind, confidence, expectancy, trainingEvents, version, freshness, detail }
 * Sorted best-first by confidence → expectancy → trainingEvents → version →
 * freshness. Returns a NEW array; input is not mutated. Ties keep input order.
 * @param {Array<object>} records
 * @returns {Array<object>}
 */
function rankIntelligence(records) {
  const list = Array.isArray(records) ? records.slice() : [];
  return list
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      const a = x.r, b = y.r;
      return (
        cmpDescNullsLast(numOrNull(a.confidence), numOrNull(b.confidence)) ||
        cmpDescNullsLast(numOrNull(a.expectancy), numOrNull(b.expectancy)) ||
        cmpDescNullsLast(numOrNull(a.trainingEvents), numOrNull(b.trainingEvents)) ||
        cmpDescNullsLast(numOrNull(a.version), numOrNull(b.version)) ||
        cmpDescNullsLast(numOrNull(a.freshness), numOrNull(b.freshness)) ||
        (x.i - y.i)
      );
    })
    .map((w) => w.r);
}

/**
 * Tri-state consensus over a set of engine opinions. Each opinion is expected to
 * expose { engineId, wouldTrade } where wouldTrade is boolean|null.
 *
 * Abstentions (null) are counted separately and excluded from the agreement /
 * disagreement denominators. Scores are percentages (0–100) of the DECIDED
 * votes that side with the majority (agreement) vs. the minority (disagreement),
 * or null when nobody committed.
 *
 * @param {Array<{engineId:string, wouldTrade:(boolean|null)}>} opinions
 * @returns {{
 *   votesFor:number, votesAgainst:number, abstain:number, decided:number,
 *   agreementScore:(number|null), disagreementScore:(number|null),
 *   consensus:string, agreeing:string[], dissenting:string[], abstaining:string[]
 * }}
 */
function computeConsensus(opinions) {
  const list = Array.isArray(opinions) ? opinions : [];
  const forIds = [];
  const againstIds = [];
  const abstainIds = [];
  for (const o of list) {
    const id = (o && o.engineId != null) ? String(o.engineId) : "?";
    const wt = boolOrNull(o && o.wouldTrade);
    if (wt === true) forIds.push(id);
    else if (wt === false) againstIds.push(id);
    else abstainIds.push(id);
  }
  const votesFor = forIds.length;
  const votesAgainst = againstIds.length;
  const abstain = abstainIds.length;
  const decided = votesFor + votesAgainst;

  let consensus;
  let agreeing;
  let dissenting;
  if (decided === 0) {
    consensus = "ABSTAIN";
    agreeing = [];
    dissenting = [];
  } else if (votesFor > votesAgainst) {
    consensus = "TRADE";
    agreeing = forIds;
    dissenting = againstIds;
  } else if (votesAgainst > votesFor) {
    consensus = "NO_TRADE";
    agreeing = againstIds;
    dissenting = forIds;
  } else {
    consensus = "SPLIT";
    agreeing = forIds;
    dissenting = againstIds;
  }

  const majority = decided === 0 ? 0 : Math.max(votesFor, votesAgainst);
  const agreementScore = decided === 0 ? null : round1((majority / decided) * 100);
  const disagreementScore = decided === 0 ? null : round1(((decided - majority) / decided) * 100);

  return {
    votesFor, votesAgainst, abstain, decided,
    agreementScore, disagreementScore, consensus,
    agreeing, dissenting, abstaining: abstainIds,
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = {
  numOrNull,
  boolOrNull,
  confidenceToScore,
  scoreToTier,
  rankIntelligence,
  computeConsensus,
  cmpDescNullsLast,
};
