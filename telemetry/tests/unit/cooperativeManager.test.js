"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CooperativeManager } = require("../../managers/CooperativeManager");

test("entry policy blocks only high-confidence NO_TRADE", () => {
  const manager = new CooperativeManager();
  assert.equal(manager.entryPolicy({ decision: "NO_TRADE", confidenceScore: 0.8 }).action, "BLOCK");
  assert.equal(manager.entryPolicy({ decision: "NO_TRADE", confidenceTier: "MEDIUM", confidenceScore: 0.6 }).action, "ADVISORY");
  assert.equal(manager.entryPolicy({ decision: "TRADE", confidenceScore: 0.9 }).action, "ALLOW");
  assert.equal(manager.entryPolicy({ decision: "ABSTAIN" }).action, "ADVISORY");
});

test("management policy preserves advisory-only evidence", () => {
  const manager = new CooperativeManager();
  const result = manager.managementPolicy({ action: "MOVE_SL", evidence: { mfe: 4 } });
  assert.equal(result.action, "MOVE_SL");
  assert.equal(result.advisoryOnly, true);
  assert.deepEqual(result.evidence, { mfe: 4 });
});