"use strict";
/**
 * SHADOW OS v2 — Sprint 6: Knowledge Provenance
 *
 * Deterministic provenance + content addressing for the read-only Knowledge
 * Layer. Every Knowledge Artifact (a row in `knowledge_artifacts`) and every
 * Knowledge Snapshot (a row in `knowledge_snapshots`) MUST carry:
 *
 *   run_id      — the running instance that BUILT the artifact (per-process UUID)
 *   build_id    — the CODE that built it (`<systemVersion>+<gitSha>`)
 *   config_hash — the RUNTIME configuration surface in effect
 *   checksum    — sha256 over the CONTENT (canonical JSON) of the artifact value
 *
 * CRITICAL — checksum covers CONTENT ONLY, never provenance:
 *   run_id changes on every boot. If the checksum covered provenance, every
 *   restart would mint a spurious new version of every artifact and destroy
 *   idempotency. `checksumValue()` therefore hashes ONLY the artifact content;
 *   provenance is stored in dedicated columns (migration 006), never inside the
 *   checksummed value. Same content ⇒ same checksum ⇒ no-op on rebuild.
 *
 * This module is pure / read-only. It reuses the Sprint 5 provenance triple
 * (shadowLabProvenance) so the Knowledge Layer and the Shadow LAB share one
 * canonical definition of run_id / build_id / config_hash. It NEVER touches
 * live trading, the DB, or the FROZEN entrypoint.
 */

const crypto = require("crypto");
const {
  createProvenance,
  canonicalJson,
  confidenceLevel,
  configHash,
  buildConfigSurface,
  resolveBuildId,
  SYSTEM_VERSION,
  CONFIDENCE_THRESHOLDS,
} = require("./shadowLabProvenance");

/**
 * Content checksum — sha256 over the canonical (sorted-key) JSON of the artifact
 * CONTENT. Deterministic and provenance-free: identical content ⇒ identical
 * checksum regardless of key order, build, run, or wall-clock.
 * @param {*} content  the pure artifact value (NO provenance mixed in)
 * @returns {string} 64-char lowercase hex
 */
function checksumValue(content) {
  return crypto.createHash("sha256").update(canonicalJson(content ?? null)).digest("hex");
}

/**
 * Numeric confidence in [0, 1] derived from sample size, monotonic with the
 * confidenceLevel tiers (LOW < 30, MEDIUM 30–100, HIGH > 100). Stored in the
 * `confidence` column for fast ranking; the tier string lives in the value.
 *   0 samples → 0.0 ; HIGH_MIN (101) samples → 1.0 (capped).
 * @param {number} sampleCount
 * @returns {number}
 */
function confidenceScore(sampleCount) {
  const n = Number(sampleCount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const cap = CONFIDENCE_THRESHOLDS.HIGH_MIN; // 101 → "HIGH" threshold
  const s = n / cap;
  return Math.min(1, Math.round(s * 1e6) / 1e6);
}

/**
 * Compact, human-readable provenance note for the `notes` column.
 * @param {{runId:string, buildId:string, configHash:string}} prov
 * @param {{trainingEvents?:number, windowFrom?:string, windowTo?:string, tier?:string}} [extra]
 * @returns {string}
 */
function provenanceNote(prov, extra = {}) {
  const parts = [
    `run=${prov.runId}`,
    `build=${prov.buildId}`,
    `cfg=${prov.configHash.slice(0, 12)}`,
  ];
  if (extra.trainingEvents != null) parts.push(`train=${extra.trainingEvents}`);
  if (extra.tier) parts.push(`tier=${extra.tier}`);
  if (extra.windowFrom || extra.windowTo) {
    parts.push(`win=${extra.windowFrom || "-"}..${extra.windowTo || "-"}`);
  }
  return parts.join(" ");
}

module.exports = {
  // Knowledge-specific
  checksumValue,
  confidenceScore,
  provenanceNote,
  // Re-exported Sprint 5 provenance (single canonical definition)
  createProvenance,
  canonicalJson,
  confidenceLevel,
  configHash,
  buildConfigSurface,
  resolveBuildId,
  SYSTEM_VERSION,
  CONFIDENCE_THRESHOLDS,
};
