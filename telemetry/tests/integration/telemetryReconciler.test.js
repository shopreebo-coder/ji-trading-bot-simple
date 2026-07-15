"use strict";
/**
 * Sprint 7.2 — TelemetryReconciler integration tests (mock OANDA client, real PG).
 *
 * Proves EVERY close type is captured exactly once:
 *   1. TP fill missed by the bot        → synthetic trade_close, reason TAKE PROFIT (OANDA)
 *   2. SL fill (short direction)        → synthetic, correct pip sign, STOP LOSS (OANDA)
 *   3. Manual/broker close              → synthetic, MANUAL/BROKER CLOSE (OANDA)
 *   4. Margin closeout                  → synthetic, MARGIN CLOSEOUT (OANDA)
 *   5. JPY pip multiplier (0.01)
 *   6. Native close (signalId match)    → NO duplicate synthetic
 *   7. Native close, null signalId      → time-window fallback, NO duplicate
 *   8. GRACE window: late native logEvent write → NO double-emit
 *   9. FIRST-RUN baseline = NOW         → no historical backfill flood
 *  10. Restart dedupe rebuild           → no second synthetic after restart
 *  11. OANDA API error                  → poll never throws, no writes
 *  12. Partial close (aggregate CLOSED trade) → exactly ONE synthetic event
 *  13. Honest nulls: bot-only fields are null, never 0
 *  14. Cross-poll re-consumption: a native close time-window-matched in poll N
 *      can NEVER absorb another trade in poll N+1 or after restart
 *
 * No timers are started (poll driven manually via _poll()); no network
 * (injected mock client); injectable clock. Requires PostgreSQL; skips cleanly.
 * NEVER spawns telemetry/server.js.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { ensureSchema } = require("../../migrations/autoMigrate");
const { db, USE_PG } = require("../../db-adapter");
const { TelemetryReconciler, CURSOR_TYPE, REASON_MAP } = require("../../managers/TelemetryReconciler");

const IS_PG = USE_PG;
const NS = `TREC-${crypto.randomUUID().slice(0, 8)}`;

// ── fake clock (fixed epoch, far from wall-clock so no cross-suite collisions) ─
const T0 = Date.parse("2026-07-01T12:00:00.000Z");
let fakeNow = T0;
const MIN = 60_000;

// ── test logEvent — mirrors telemetry/index.js logEvent, but awaitable ─────────
const pendingWrites = [];
function testLogEvent(event) {
  const ts = event.timestamp || new Date(fakeNow).toISOString();
  const data = JSON.stringify({ ...event, ts, botId: "test", _ns: NS });
  const p = db.run(
    "INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)",
    ts, "test", event.type, event.symbol || null, data
  ).catch((e) => { throw e; });
  pendingWrites.push(p);
  return p;
}
async function flushWrites() { await Promise.all(pendingWrites.splice(0)); }

// ── direct event seeder (native bot events with explicit ts) ──────────────────
async function seedEvent(type, payload, symbol, tsMs) {
  const ts = new Date(tsMs).toISOString();
  const data = JSON.stringify({ ...payload, type, ts, botId: "test", _ns: NS });
  await db.run(
    "INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)",
    ts, "test", type, symbol, data
  );
}

async function syntheticClosesFor(oandaTradeId) {
  const rows = await db.all(
    "SELECT id, ts, data FROM events WHERE type='trade_close' AND data LIKE ? ORDER BY id ASC",
    `%"oandaTradeId":"${oandaTradeId}"%`
  );
  return (rows || []).map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

// ── mock OANDA client ──────────────────────────────────────────────────────────
const mock = {
  closed: [],
  txns: {},
  failClosedTrades: false,
  async getClosedTrades() {
    if (this.failClosedTrades) throw new Error("OANDA 503 (mock outage)");
    return this.closed;
  },
  async getTransaction(id) { return this.txns[id] || null; },
};

function oandaTrade({ id, instrument, price, closePrice, units, openMs, closeMs, txnIds, realizedPL }) {
  return {
    id,
    instrument,
    price: String(price),
    averageClosePrice: String(closePrice),
    initialUnits: String(units),
    realizedPL: realizedPL !== undefined ? String(realizedPL) : "0.00",
    openTime: new Date(openMs).toISOString(),
    closeTime: new Date(closeMs).toISOString(),
    closingTransactionIDs: txnIds,
    state: "CLOSED",
  };
}

function newReconciler(overrides = {}) {
  return new TelemetryReconciler({
    db,
    logEvent: testLogEvent,
    oanda: mock,
    logger: { info: () => {}, error: () => {} },
    now: () => fakeNow,
    graceMs: 3 * MIN,
    ...overrides,
  });
}

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });
  // Cursor rows are read globally (latest wins) — clear leftovers for isolation
  await db._pool.query("DELETE FROM events WHERE type = $1", [CURSOR_TYPE]);
});

after(async () => {
  if (!IS_PG) return;
  try {
    await db._pool.query("DELETE FROM events WHERE data LIKE $1", [`%${NS}%`]);
    await db._pool.query("DELETE FROM events WHERE type = $1", [CURSOR_TYPE]);
  } catch (_) {}
  await db._pool.end();
});

test("TelemetryReconciler — every close type captured exactly once", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  // Shared manager: baseline pinned 1h before T0 via first _restore at T0-1h
  fakeNow = T0 - 60 * MIN;
  const mgr = newReconciler();
  await mgr._restore();
  await flushWrites();
  assert.equal(mgr.stats.baseline, new Date(T0 - 60 * MIN).toISOString(), "first-run baseline = NOW at restore time");

  await t.test("1. missed TP fill → synthetic trade_close with recovered signalId", async () => {
    const openMs = T0 - 30 * MIN, closeMs = T0 - 10 * MIN;
    await seedEvent("trade_open", { signalId: `${NS}-S1`, symbol: "EUR_USD", side: "buy" }, "EUR_USD", openMs);
    mock.closed = [oandaTrade({ id: `${NS}-T1`, instrument: "EUR_USD", price: 1.10000, closePrice: 1.10150, units: 1000, openMs, closeMs, txnIds: ["9001"], realizedPL: "1.23" })];
    mock.txns["9001"] = { reason: "TAKE_PROFIT_ORDER" };

    fakeNow = T0;
    await mgr._poll();
    await flushWrites();

    const syn = await syntheticClosesFor(`${NS}-T1`);
    assert.equal(syn.length, 1, "exactly one synthetic close");
    const d = syn[0].data;
    assert.equal(d.synthetic, true);
    assert.equal(d.captureMethod, "oanda_reconciler");
    assert.equal(d.reason, REASON_MAP.TAKE_PROFIT_ORDER);
    assert.equal(d.signalId, `${NS}-S1`, "signalId recovered from trade_open");
    assert.equal(d.profitPips, 15, "long: (1.10150-1.10000)/0.0001 = +15 pips");
    assert.equal(d.outcome, "WIN");
    assert.equal(d.duration, 20, "openTime→closeTime = 20 min");
    assert.equal(d.realizedPL, 1.23);
    assert.equal(syn[0].ts, new Date(closeMs).toISOString(), "event ts = actual OANDA close time");
    assert.equal(mgr.stats.syntheticWritten, 1);
  });

  await t.test("13. honest nulls — bot-only fields are null, never 0", async () => {
    const [syn] = await syntheticClosesFor(`${NS}-T1`);
    for (const f of ["peak", "mfe", "mae", "exitEfficiency", "retainedProfitPercent", "entryEfficiencyPips", "timeToProfitMin"]) {
      assert.equal(syn.data[f], null, `${f} must be null (Number(null)===0 fabrication guard)`);
      assert.notEqual(syn.data[f], 0, `${f} must never be fabricated as 0`);
    }
  });

  await t.test("2. missed SL fill on a SHORT → correct pip sign", async () => {
    const openMs = T0 - 25 * MIN, closeMs = T0 - 9 * MIN;
    mock.closed = [oandaTrade({ id: `${NS}-T2`, instrument: "GBP_USD", price: 1.20000, closePrice: 1.20200, units: -1000, openMs, closeMs, txnIds: ["9002"] })];
    mock.txns["9002"] = { reason: "STOP_LOSS_ORDER" };

    await mgr._poll();
    await flushWrites();

    const [syn] = await syntheticClosesFor(`${NS}-T2`);
    assert.ok(syn, "synthetic close written");
    assert.equal(syn.data.reason, REASON_MAP.STOP_LOSS_ORDER);
    assert.equal(syn.data.profitPips, -20, "short losing: price rose 20 pips against");
    assert.equal(syn.data.outcome, "LOSS");
    assert.equal(syn.data.signalId, null, "no trade_open nearby → honest null signalId");
  });

  await t.test("3. manual/broker close → MANUAL/BROKER CLOSE (OANDA)", async () => {
    const openMs = T0 - 20 * MIN, closeMs = T0 - 8 * MIN;
    mock.closed = [oandaTrade({ id: `${NS}-T3`, instrument: "AUD_USD", price: 0.66000, closePrice: 0.66005, units: 500, openMs, closeMs, txnIds: ["9003"] })];
    mock.txns["9003"] = { reason: "MARKET_ORDER_TRADE_CLOSE" };
    await mgr._poll();
    await flushWrites();
    const [syn] = await syntheticClosesFor(`${NS}-T3`);
    assert.equal(syn.data.reason, REASON_MAP.MARKET_ORDER_TRADE_CLOSE);
    assert.equal(syn.data.outcome, "BREAKEVEN", "0.5 pips ≤ 1.0 → BREAKEVEN");
  });

  await t.test("4. margin closeout → MARGIN CLOSEOUT (OANDA)", async () => {
    const openMs = T0 - 18 * MIN, closeMs = T0 - 7 * MIN;
    mock.closed = [oandaTrade({ id: `${NS}-T4`, instrument: "EUR_GBP", price: 0.85000, closePrice: 0.84800, units: 2000, openMs, closeMs, txnIds: ["9004"] })];
    mock.txns["9004"] = { reason: "MARGIN_CLOSEOUT" };
    await mgr._poll();
    await flushWrites();
    const [syn] = await syntheticClosesFor(`${NS}-T4`);
    assert.equal(syn.data.reason, REASON_MAP.MARGIN_CLOSEOUT);
    assert.equal(syn.data.profitPips, -20);
  });

  await t.test("5. JPY pair uses 0.01 pip multiplier", async () => {
    const openMs = T0 - 16 * MIN, closeMs = T0 - 6 * MIN;
    mock.closed = [oandaTrade({ id: `${NS}-T5`, instrument: "USD_JPY", price: 155.000, closePrice: 155.300, units: 1000, openMs, closeMs, txnIds: ["9005"] })];
    mock.txns["9005"] = { reason: "TAKE_PROFIT_ORDER" };
    await mgr._poll();
    await flushWrites();
    const [syn] = await syntheticClosesFor(`${NS}-T5`);
    assert.equal(syn.data.profitPips, 30, "(155.300-155.000)/0.01 = 30 pips");
  });

  await t.test("6. native close with signalId → NO duplicate synthetic", async () => {
    const openMs = T0 - 14 * MIN, closeMs = T0 - 5 * MIN;
    await seedEvent("trade_open",  { signalId: `${NS}-S6`, symbol: "EUR_USD", side: "buy" }, "EUR_USD", openMs);
    await seedEvent("trade_close", { signalId: `${NS}-S6`, symbol: "EUR_USD", profitPips: 4.2, reason: "PROFIT PROTECTION", outcome: "WIN" }, "EUR_USD", closeMs + 2000);
    mock.closed = [oandaTrade({ id: `${NS}-T6`, instrument: "EUR_USD", price: 1.10000, closePrice: 1.10042, units: 1000, openMs, closeMs, txnIds: ["9006"] })];
    mock.txns["9006"] = { reason: "MARKET_ORDER_TRADE_CLOSE" };

    const beforeNative = mgr.stats.nativeMatched;
    await mgr._poll();
    await flushWrites();

    const syn = await syntheticClosesFor(`${NS}-T6`);
    assert.equal(syn.length, 0, "no synthetic — bot captured this close natively");
    assert.equal(mgr.stats.nativeMatched, beforeNative + 1, "counted as native match");
  });

  await t.test("7. native close with NULL signalId → time-window fallback, no duplicate", async () => {
    const openMs = T0 - 13 * MIN, closeMs = T0 - 4 * MIN;
    // post-restart native close: signalId null (no trade_open seeded either)
    await seedEvent("trade_close", { signalId: null, symbol: "NZD_USD", profitPips: -3.1, reason: "TIME EXIT", outcome: "LOSS" }, "NZD_USD", closeMs + 10_000);
    mock.closed = [oandaTrade({ id: `${NS}-T7`, instrument: "NZD_USD", price: 0.61000, closePrice: 0.60969, units: 1000, openMs, closeMs, txnIds: ["9007"] })];
    mock.txns["9007"] = { reason: "MARKET_ORDER_TRADE_CLOSE" };

    const beforeNative = mgr.stats.nativeMatched;
    await mgr._poll();
    await flushWrites();

    const syn = await syntheticClosesFor(`${NS}-T7`);
    assert.equal(syn.length, 0, "no synthetic — matched by symbol+closeTime window");
    assert.equal(mgr.stats.nativeMatched, beforeNative + 1);
  });

  await t.test("8. grace window: late native logEvent write → NO double-emit", async () => {
    const openMs = fakeNow - 10 * MIN;
    const closeMs = fakeNow - 1 * MIN; // inside 3-min grace
    await seedEvent("trade_open", { signalId: `${NS}-S8`, symbol: "USD_CAD", side: "buy" }, "USD_CAD", openMs);
    mock.closed = [oandaTrade({ id: `${NS}-T8`, instrument: "USD_CAD", price: 1.36000, closePrice: 1.36080, units: 1000, openMs, closeMs, txnIds: ["9008"] })];
    mock.txns["9008"] = { reason: "MARKET_ORDER_TRADE_CLOSE" };

    await mgr._poll();
    await flushWrites();
    assert.equal(mgr.stats.pendingWithinGrace, 1, "close inside grace window is pending, not missing");
    assert.equal((await syntheticClosesFor(`${NS}-T8`)).length, 0, "nothing emitted during grace");

    // The bot's fire-and-forget logEvent lands LATE (after the poll already saw CLOSED)
    await seedEvent("trade_close", { signalId: `${NS}-S8`, symbol: "USD_CAD", profitPips: 8.0, reason: "MOMENTUM LOST", outcome: "WIN" }, "USD_CAD", closeMs + 15_000);

    fakeNow += 5 * MIN; // grace expired
    const beforeNative = mgr.stats.nativeMatched;
    await mgr._poll();
    await flushWrites();

    assert.equal((await syntheticClosesFor(`${NS}-T8`)).length, 0, "still no synthetic — native close matched after grace");
    assert.equal(mgr.stats.nativeMatched, beforeNative + 1);
    assert.equal(mgr.stats.pendingWithinGrace, 0);
  });

  await t.test("12. partial closes: one aggregate CLOSED trade → exactly ONE synthetic", async () => {
    const openMs = fakeNow - 40 * MIN, closeMs = fakeNow - 5 * MIN;
    // OANDA reports the trade once, in state=CLOSED, with the FINAL aggregate —
    // two closing transactions (the partial + the final). Reason from the LAST.
    mock.closed = [oandaTrade({ id: `${NS}-T12`, instrument: "EUR_JPY", price: 170.000, closePrice: 170.220, units: 2000, openMs, closeMs, txnIds: ["9012a", "9012b"], realizedPL: "4.40" })];
    mock.txns["9012a"] = { reason: "MARKET_ORDER_TRADE_CLOSE" };
    mock.txns["9012b"] = { reason: "TAKE_PROFIT_ORDER" };

    await mgr._poll();
    await mgr._poll(); // second poll must not add another
    await flushWrites();

    const syn = await syntheticClosesFor(`${NS}-T12`);
    assert.equal(syn.length, 1, "exactly one synthetic for the whole (partially closed) trade");
    assert.equal(syn[0].data.reason, REASON_MAP.TAKE_PROFIT_ORDER, "reason from FINAL closing transaction");
    assert.equal(syn[0].data.profitPips, 22, "JPY quote: (170.220-170.000)/0.01 = 22");
  });

  await t.test("10. restart: dedupe set rebuilt from DB → no second synthetic", async () => {
    mock.closed = [oandaTrade({ id: `${NS}-T1`, instrument: "EUR_USD", price: 1.10000, closePrice: 1.10150, units: 1000, openMs: T0 - 30 * MIN, closeMs: T0 - 10 * MIN, txnIds: ["9001"] })];
    const mgr2 = newReconciler();
    await mgr2._restore();
    await flushWrites();
    assert.ok(mgr2._reconciled.has(`${NS}-T1`), "dedupe set restored from synthetic closes in DB");
    await mgr2._poll();
    await flushWrites();
    assert.equal((await syntheticClosesFor(`${NS}-T1`)).length, 1, "still exactly one synthetic after restart");
    assert.equal(mgr2.stats.syntheticWritten, 0, "restarted instance wrote nothing");
  });

  await t.test("11. OANDA API outage → poll never throws, no writes, lastError set", async () => {
    mock.failClosedTrades = true;
    const beforeCount = (await db.get("SELECT COUNT(*) AS n FROM events WHERE data LIKE ?", `%${NS}%`)).n;
    await assert.doesNotReject(() => mgr._poll(), "poll must never throw (supervisor process)");
    await flushWrites();
    assert.match(String(mgr.stats.lastError), /mock outage/);
    const afterCount = (await db.get("SELECT COUNT(*) AS n FROM events WHERE data LIKE ?", `%${NS}%`)).n;
    assert.equal(Number(afterCount), Number(beforeCount), "no events written during outage");
    mock.failClosedTrades = false;
  });

  await t.test("9. FIRST-RUN baseline = NOW → historical closes NOT backfilled", async () => {
    await db._pool.query("DELETE FROM events WHERE type = $1", [CURSOR_TYPE]);
    const T9 = fakeNow;
    // account history: a trade closed 2 days BEFORE first deployment
    mock.closed = [oandaTrade({ id: `${NS}-T9`, instrument: "EUR_USD", price: 1.09000, closePrice: 1.09500, units: 1000, openMs: T9 - 48 * 60 * MIN, closeMs: T9 - 47 * 60 * MIN, txnIds: ["9009"] })];
    mock.txns["9009"] = { reason: "TAKE_PROFIT_ORDER" };

    const fresh = newReconciler();
    await fresh._restore();
    await flushWrites();
    assert.equal(fresh.stats.baseline, new Date(T9).toISOString(), "no cursor → baseline pinned to NOW");

    await fresh._poll();
    await flushWrites();
    assert.equal((await syntheticClosesFor(`${NS}-T9`)).length, 0, "historical close before baseline is NEVER backfilled");
    assert.equal(fresh.stats.syntheticWritten, 0);
  });

  await t.test("lifecycle: construction is a no-op; getStats surfaces config", async () => {
    const idle = newReconciler();
    assert.equal(idle._timer, null, "no timer on construction");
    assert.equal(idle._started, false);
    const s = idle.getStats();
    assert.equal(s.enabled, false);
    assert.equal(s.credsPresent, true, "mock client injected");
    assert.equal(s.config.graceMs, 3 * MIN);
    assert.equal(s.pollCount, 0);
  });

  await t.test("cursor marker persisted with progress counters", async () => {
    const rows = await db.all(`SELECT data FROM events WHERE type='${CURSOR_TYPE}' ORDER BY id DESC LIMIT 1`);
    assert.ok(rows.length >= 1, "cursor marker exists");
    const d = JSON.parse(rows[0].data);
    assert.ok(d.baseline, "cursor carries baseline");
  });

  await t.test("14. cross-poll re-consumption: native close matched in poll N never absorbs trade in poll N+1 (+ restart)", async () => {
    // Fresh manager; baseline comes from the latest cursor row (written earlier)
    fakeNow = T0 + 60 * MIN;
    const mgrX = newReconciler();
    await mgrX._restore();
    await flushWrites();

    const openAms = T0 + 20 * MIN, closeAms = T0 + 30 * MIN;
    // ONE native close (null signalId), no trade_open → only time-window can match
    await seedEvent("trade_close", { signalId: null, symbol: "USD_CHF", profitPips: 2.0, reason: "TIME EXIT", outcome: "WIN" }, "USD_CHF", closeAms + 5000);
    const xRow = await db.get(
      "SELECT id FROM events WHERE type='trade_close' AND symbol=? AND ts=? AND data LIKE ?",
      "USD_CHF", new Date(closeAms + 5000).toISOString(), `%${NS}%`
    );
    assert.ok(xRow, "seeded native close row found");

    // Poll N: OANDA trade A → time-window match consumes native close X
    mock.closed = [oandaTrade({ id: `${NS}-T14A`, instrument: "USD_CHF", price: 0.88000, closePrice: 0.88020, units: 1000, openMs: openAms, closeMs: closeAms, txnIds: ["9014a"] })];
    mock.txns["9014a"] = { reason: "MARKET_ORDER_TRADE_CLOSE" };
    await mgrX._poll();
    await flushWrites();
    assert.equal((await syntheticClosesFor(`${NS}-T14A`)).length, 0, "trade A matched natively via time window");
    assert.ok(mgrX._consumedNative.has(xRow.id), "native close X consumed");

    // Poll N+1: OANDA trade B, same symbol, closeTime within ±90s of X —
    // X is already consumed → B MUST become synthetic, never silently lost
    mock.closed = [
      mock.closed[0],
      oandaTrade({ id: `${NS}-T14B`, instrument: "USD_CHF", price: 0.88100, closePrice: 0.88060, units: 1000, openMs: openAms + MIN, closeMs: closeAms + 60_000, txnIds: ["9014b"] }),
    ];
    mock.txns["9014b"] = { reason: "STOP_LOSS_ORDER" };
    await mgrX._poll();
    await flushWrites();
    const synB = await syntheticClosesFor(`${NS}-T14B`);
    assert.equal(synB.length, 1, "trade B captured as synthetic — X not re-consumed");
    assert.equal(synB[0].data.reason, REASON_MAP.STOP_LOSS_ORDER);

    // Restart: consumption is restored from cursor rows
    const mgrY = newReconciler();
    await mgrY._restore();
    await flushWrites();
    assert.ok(mgrY._consumedNative.has(xRow.id), "consumed native-close id restored from cursor after restart");
  });
});
