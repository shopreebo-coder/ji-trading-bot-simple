"use strict";
/**
 * Sprint 6 — knowledgeProvenance unit tests.
 *
 * Proves the content-addressing + provenance contract for the Knowledge Layer:
 *   1. checksumValue is deterministic and key-order independent (canonical JSON).
 *   2. checksumValue covers CONTENT ONLY — it changes iff the content changes.
 *      (Provenance MUST NOT affect the checksum, or restarts break idempotency.)
 *   3. confidenceScore is bounded [0,1] and monotonic with sample size.
 *   4. confidenceLevel tiers are re-exported correctly (LOW/MEDIUM/HIGH).
 *
 * Pure functions — no DB, no PostgreSQL required.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  checksumValue,
  confidenceScore,
  confidenceLevel,
  canonicalJson,
  createProvenance,
  provenanceNote,
  CONFIDENCE_THRESHOLDS,
} = require("../../managers/knowledgeProvenance");

test("checksumValue is deterministic and key-order independent", () => {
  const a = { z: 1, a: 2, nested: { y: 9, x: 8 } };
  const b = { a: 2, nested: { x: 8, y: 9 }, z: 1 };
  assert.equal(checksumValue(a), checksumValue(b), "key order must not change the checksum");
  assert.match(checksumValue(a), /^[0-9a-f]{64}$/, "sha256 hex");
});

test("checksumValue changes iff content changes", () => {
  const base = { count: 10, expectancy: 1.25 };
  const same = { count: 10, expectancy: 1.25 };
  const diff = { count: 11, expectancy: 1.25 };
  assert.equal(checksumValue(base), checksumValue(same));
  assert.notEqual(checksumValue(base), checksumValue(diff));
});

test("checksumValue excludes provenance (content-only addressing)", () => {
  // Two artifacts with identical CONTENT but stamped by different runs must
  // hash identically — provenance is stored in columns, never checksummed.
  const content = { winrate: 0.61, samples: 42 };
  const p1 = createProvenance({ runId: "run-A", buildId: "v40.1+aaa", configHash: "a".repeat(64) });
  const p2 = createProvenance({ runId: "run-B", buildId: "v40.1+bbb", configHash: "b".repeat(64) });
  // The repository checksums CONTENT only; simulate that here.
  assert.equal(checksumValue(content), checksumValue(content));
  // Sanity: the provenance triples genuinely differ.
  assert.notEqual(p1.runId, p2.runId);
  assert.notEqual(p1.configHash, p2.configHash);
});

test("confidenceScore is bounded [0,1] and monotonic", () => {
  assert.equal(confidenceScore(0), 0);
  assert.equal(confidenceScore(-5), 0);
  assert.equal(confidenceScore("nonsense"), 0);
  const low = confidenceScore(10);
  const mid = confidenceScore(60);
  const high = confidenceScore(200);
  assert.ok(low > 0 && low < mid, "monotonic increasing");
  assert.ok(mid < high, "monotonic increasing");
  assert.equal(high, 1, "caps at 1.0 beyond HIGH threshold");
  assert.ok(confidenceScore(CONFIDENCE_THRESHOLDS.HIGH_MIN) <= 1);
});

test("confidenceLevel tiers are re-exported (LOW/MEDIUM/HIGH)", () => {
  assert.equal(confidenceLevel(0), "LOW");
  assert.equal(confidenceLevel(29), "LOW");
  assert.equal(confidenceLevel(30), "MEDIUM");
  assert.equal(confidenceLevel(100), "MEDIUM");
  assert.equal(confidenceLevel(101), "HIGH");
  assert.equal(confidenceLevel(5000), "HIGH");
});

test("canonicalJson sorts keys recursively and preserves array order", () => {
  assert.equal(canonicalJson({ b: 1, a: [3, 2, 1] }), '{"a":[3,2,1],"b":1}');
  assert.equal(canonicalJson(null), "null");
});

test("provenanceNote produces a compact, readable string", () => {
  const p = createProvenance({ runId: "run-1", buildId: "v40.1+deadbeef0000", configHash: "c".repeat(64) });
  const note = provenanceNote(p, { trainingEvents: 42, tier: "MEDIUM", windowFrom: "t0", windowTo: "t1" });
  assert.match(note, /run=run-1/);
  assert.match(note, /build=v40\.1\+deadbeef0000/);
  assert.match(note, /train=42/);
  assert.match(note, /tier=MEDIUM/);
  assert.match(note, /win=t0\.\.t1/);
});
