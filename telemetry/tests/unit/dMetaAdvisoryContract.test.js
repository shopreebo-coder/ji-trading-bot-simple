"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { ShadowDMetaManager } = require("../../managers/ShadowDMetaManager");
const {
  buildDMetaHandoff,
  classifyDMetaReaction,
} = require("../../managers/DMetaAdvisoryContract");

const signal = {
  signalId: "contract-signal-1",
  symbol: "EUR_USD",
  side: "buy",
  session: "LONDON",
  spread: 0.8,
};

test("D generates an advisory-only entry suggestion with full handoff context", () => {
  const suggestion = ShadowDMetaManager.analyzeEntry({ signal });
  const handoff = buildDMetaHandoff({ suggestion, signal, handoffType: "entry" });

  assert.ok(handoff);
  assert.equal(handoff.advisoryOnly, true);
  assert.equal(handoff.authoritativeLayer, "live_bot");
  assert.equal(handoff.handoffType, "entry");
  assert.equal(handoff.signalId, signal.signalId);
  assert.equal(handoff.symbol, signal.symbol);
  assert.equal(handoff.direction, signal.side);
  assert.equal(handoff.recommendation, suggestion.action);
  assert.ok(handoff.timestamp);
  assert.deepEqual(handoff.entryContext, signal);
});

test("position suggestions are delivered without changing the Live Bot action", () => {
  const suggestion = { action: "EXIT", confidence: "HIGH", advisoryOnly: true };
  const handoff = buildDMetaHandoff({
    suggestion,
    handoffType: "position",
    signal,
    position: { tradeId: "trade-1", pips: 3.2, liveAction: "HOLD" },
  });

  assert.equal(handoff.handoffType, "position");
  assert.equal(handoff.positionContext.tradeId, "trade-1");
  assert.equal(handoff.authoritativeLayer, "live_bot");
  assert.equal(classifyDMetaReaction(handoff, "HOLD"), "REJECT");
  assert.equal(classifyDMetaReaction(handoff, "REQUEST_CLOSE"), "ACCEPT");
});

test("missing D suggestion is fail-open and does not block the existing Live Bot path", () => {
  assert.equal(buildDMetaHandoff({ suggestion: null, signal }), null);
  assert.equal(classifyDMetaReaction(null, "TRADE"), "IGNORE");
});

test("D handoff contract contains no execution authority", () => {
  const source = fs.readFileSync("telemetry/managers/DMetaAdvisoryContract.js", "utf8");
  for (const forbidden of ["placeTrade", "closePosition", "modifyOrder", "OANDA"]) {
    assert.equal(source.includes(forbidden), false, `contract must not contain ${forbidden}`);
  }
});

test("entry handoff and position handoff are wired in both Live Bot and telemetry server", () => {
  const bot = fs.readFileSync("index.js", "utf8");
  const server = fs.readFileSync("telemetry/server.js", "utf8");
  assert.match(bot, /dMetaEntry/);
  assert.match(bot, /dMetaPosition/);
  assert.match(bot, /d_meta_outcome/);
  assert.match(bot, /return finalAction/);
  assert.match(server, /dMetaEntry/);
  assert.match(server, /dMetaPositionHandoff/);
  assert.match(server, /const finalAction = cooperativeManager\.decideManagement/);
  assert.match(server, /knowledgeEvidence/);
});