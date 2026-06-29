"use strict";
/**
 * Telemetry API server + bot lifecycle manager
 * Railway start command:  node telemetry/server.js
 *
 * Spawns:  node index.js  (bot — never modified by this file)
 * Serves:  Express API  +  live SSE stream  +  dashboard HTML
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const express    = require("express");
const path       = require("path");
const { spawn }  = require("child_process");
const { db, emitter, getLastId, backupDatabase, getDbStats, DATA_DIR, DATA_DIR_EXPLICIT, DB_PATH, USE_PG } = require("./index");
const { shadowLab, getShadowMode, setShadowMode, getShadowMemoryStats } = require("./shadowlab");
const { shadowM, getShadowMStats, getShadowMTrades, getShadowMTimeline } = require("./shadowm");

const PORT = process.env.PORT || 3001;
const app  = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── live state (from stdout parsing) ─────────────────────────────────────────
const live = {
  botStatus:    "starting",
  dailyTrades:  0,
  openTrades:   {},   // symbol → {symbol,side,pips,peak,breakEven,entryTime}
  recentBlocks: [],   // last 20
  lastSeen:     null,
};

const sseClients = new Set();

function broadcastSSE(msg) {
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// forward DB events to SSE
emitter.on("event", (row) => broadcastSSE({ source: "db", ...row }));

// ── stdout parser (live pips / trade status) ──────────────────────────────────
let lineBuffer = "";
let exitLines  = null;

function handleBotLine(raw) {
  const line = raw.trim();
  if (!line) return;

  // EXIT block collector
  if (line.startsWith("EXIT ")) {
    exitLines = [line];
    return;
  }
  if (exitLines) {
    if (/^(reason|profit|peak|minutes|breakEven)=/.test(line)) {
      exitLines.push(line);
      if (line.startsWith("breakEven=")) {
        parseExitBlock(exitLines);
        exitLines = null;
      }
      return;
    }
    parseExitBlock(exitLines);
    exitLines = null;
  }

  // live pips: "EUR_USD -> 2.34 pips"
  const pipsM = line.match(/^(\S+) -> (-?[\d.]+) pips$/);
  if (pipsM) {
    const [, sym, p] = pipsM;
    if (live.openTrades[sym]) live.openTrades[sym].pips = parseFloat(p);
    broadcastSSE({ source: "live", type: "pips", symbol: sym, pips: parseFloat(p) });
    return;
  }

  // peak: "EUR_USD PEAK -> 3.45"
  const peakM = line.match(/^(\S+) PEAK -> (-?[\d.]+)$/);
  if (peakM) {
    const [, sym, p] = peakM;
    if (live.openTrades[sym]) live.openTrades[sym].peak = parseFloat(p);
    return;
  }

  // trade opened
  const openM = line.match(/^Trade -> (\S+) (BUY|SELL)$/);
  if (openM) {
    const [, sym, side] = openM;
    live.openTrades[sym] = { symbol: sym, side: side.toLowerCase(), pips: 0, peak: 0, breakEven: false, entryTime: Date.now() };
    broadcastSSE({ source: "live", type: "trade_opened", symbol: sym, side: side.toLowerCase() });
    console.log(`[SHADOW M DIAG] handleBotLine detected trade_open: ${sym} ${side} | server PID=${process.pid}`);
    return;
  }

  // break even
  const beM = line.match(/^(\S+) BREAK EVEN ON$/);
  if (beM && live.openTrades[beM[1]]) {
    live.openTrades[beM[1]].breakEven = true;
    return;
  }

  // daily trades counter
  const dtM = line.match(/^dailyTrades=(\d+)$/);
  if (dtM) {
    live.dailyTrades = parseInt(dtM[1]);
    broadcastSSE({ source: "live", type: "daily_count", value: live.dailyTrades });
    return;
  }

  // blocks (already in DB via logEvent, just update live panel)
  if (line.includes("BLOCK") || line.includes("MARGIN PROTECTION")) {
    live.recentBlocks.unshift({ t: new Date().toISOString(), line });
    if (live.recentBlocks.length > 20) live.recentBlocks.pop();
    broadcastSSE({ source: "live", type: "block", line });
  }
}

function parseExitBlock(lines) {
  const e = {};
  for (const l of lines) {
    if (l.startsWith("EXIT ")) { e.symbol = l.slice(5); continue; }
    const kv = l.match(/^(\w+)=(.+)$/);
    if (kv) e[kv[1]] = kv[2];
  }
  if (e.symbol) {
    delete live.openTrades[e.symbol];
    broadcastSSE({ source: "live", type: "trade_closed", symbol: e.symbol, reason: e.reason, profit: parseFloat(e.profit || 0) });
  }
}

// ── spawn bot ─────────────────────────────────────────────────────────────────
function startBot() {
  console.log("[SERVER] Spawning: node index.js");
  live.botStatus = "running";

  const bot = spawn("node", [path.join(__dirname, "..", "index.js")], {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  function onData(chunk) {
    lineBuffer += chunk.toString();
    const parts = lineBuffer.split("\n");
    lineBuffer  = parts.pop();
    for (const line of parts) {
      process.stdout.write(line + "\n");
      handleBotLine(line);
    }
  }

  bot.stdout.on("data", onData);
  bot.stderr.on("data", onData);

  bot.on("exit", (code) => {
    live.botStatus = "stopped";
    broadcastSSE({ source: "live", type: "bot_status", status: "stopped" });
    console.log(`[SERVER] Bot exited (${code}), restart in 5 s`);
    setTimeout(startBot, 5000);
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────
function parseDate(str) {
  if (!str || str === "today") return new Date().toISOString().slice(0, 10);
  return str;
}

/**
 * classifyOutcome — TELEMETRY ONLY
 * Uses stored `outcome` field when present (new events).
 * Falls back to profitPips computation for historical data without outcome field.
 *
 * Rules:
 *   pips < 0       → LOSS
 *   0 ≤ pips ≤ 1.0 → BREAKEVEN
 *   pips > 1.0     → WIN
 *
 * Only WIN and LOSS count toward win rate denominator.
 * BREAKEVEN is reported separately and excluded from W/L ratio.
 */
function classifyOutcome(d) {
  if (d.outcome && ["WIN", "LOSS", "BREAKEVEN"].includes(d.outcome)) return d.outcome;
  const p = d.profitPips || 0;
  if (p < 0)    return "LOSS";
  if (p <= 1.0) return "BREAKEVEN";
  return "WIN";
}

async function queryEvents({ type, symbol, date, limit = 500 } = {}) {
  let sql    = "SELECT id,ts,bot_id,type,symbol,data FROM events WHERE 1=1";
  const args = [];
  if (type)   { sql += " AND type=?";            args.push(type); }
  if (symbol) { sql += " AND symbol=?";          args.push(symbol); }
  if (date)   { sql += " AND substr(ts,1,10)=?"; args.push(date); }
  sql += " ORDER BY id DESC LIMIT ?";
  args.push(limit);
  return (await db.all(sql, ...args)).map(r => ({ ...r, data: JSON.parse(r.data) }));
}

// ── API: GET /api/events ──────────────────────────────────────────────────────
app.get("/api/events", async (req, res) => {
  const rows = await queryEvents({
    type:   req.query.type,
    symbol: req.query.symbol,
    date:   req.query.date ? parseDate(req.query.date) : undefined,
    limit:  parseInt(req.query.limit || "500"),
  });
  res.json(rows);
});

// ── API: GET /api/trades ──────────────────────────────────────────────────────
app.get("/api/trades", async (req, res) => {
  const date   = req.query.date   ? parseDate(req.query.date) : undefined;
  const symbol = req.query.symbol;

  const opens  = await queryEvents({ type: "trade_open",  symbol, date, limit: 1000 });
  const closes = await queryEvents({ type: "trade_close", symbol, date, limit: 1000 });

  const closeMap = {};
  for (const c of closes) {
    const key = c.symbol;
    if (!closeMap[key]) closeMap[key] = [];
    closeMap[key].push(c);
  }

  const trades = opens.map(o => {
    const pool  = closeMap[o.symbol] || [];
    const match = pool.find(c => c.ts >= o.ts);
    return { open: o.data, close: match?.data || null };
  });

  res.json(trades);
});

// ── API: GET /api/today ───────────────────────────────────────────────────────
app.get("/api/today", async (req, res) => {
  const date   = parseDate("today");
  const closes = await queryEvents({ type: "trade_close", date, limit: 1000 });

  let wins = 0, losses = 0, breakevens = 0, totalPeak = 0, totalDur = 0;
  for (const c of closes) {
    const d  = c.data;
    const oc = classifyOutcome(d);
    if (oc === "WIN")       wins++;
    else if (oc === "LOSS") losses++;
    else                    breakevens++;
    totalPeak += d.peak || 0;
    totalDur  += d.duration || 0;
  }

  const n        = closes.length;
  const decisive = wins + losses;
  const blocks   = (await queryEvents({ date, limit: 1000 }))
    .filter(e => ["spread_block","cooldown_block","correlation_block","pullback_block","margin_block",
                  "exhaustion_block","spread_edge_block","symbol_disabled_block"].includes(e.type));

  const blockCounts = {};
  for (const b of blocks) blockCounts[b.type] = (blockCounts[b.type] || 0) + 1;

  res.json({
    date,
    trades:      n,
    wins,
    losses,
    breakevens,
    winRate:     decisive ? ((wins / decisive) * 100).toFixed(1) : "0.0",
    avgPeak:     n ? (totalPeak / n).toFixed(2) : "0.00",
    avgDuration: n ? (totalDur  / n).toFixed(1) : "0.0",
    blockCounts,
    dailyTrades: live.dailyTrades,
  });
});

// ── API: GET /api/stats ───────────────────────────────────────────────────────
app.get("/api/stats", async (req, res) => {
  const symbol = req.query.symbol;
  const date   = req.query.date ? parseDate(req.query.date) : undefined;

  const closes = await queryEvents({ type: "trade_close", symbol, date, limit: 5000 });
  let wins = 0, losses = 0, breakevens = 0, totalPeak = 0, totalDur = 0;
  for (const c of closes) {
    const d  = c.data;
    const oc = classifyOutcome(d);
    if (oc === "WIN")       wins++;
    else if (oc === "LOSS") losses++;
    else                    breakevens++;
    totalPeak += d.peak || 0;
    totalDur  += d.duration || 0;
  }
  const n        = closes.length;
  const decisive = wins + losses;

  const [_chkBuy, _chkSell] = await Promise.all([
    await queryEvents({ type: "buy_check",  symbol, date, limit: 5000 }),
    await queryEvents({ type: "sell_check", symbol, date, limit: 5000 }),
  ]);
  const checks = _chkBuy.concat(_chkSell);

  const allBlocks = (await queryEvents({ date, limit: 10000 }))
    .filter(e => e.type.endsWith("_block"));

  const blockCounts = {};
  for (const b of allBlocks) blockCounts[b.type] = (blockCounts[b.type] || 0) + 1;

  res.json({
    trades:      n,
    wins,
    losses,
    breakevens,
    winRate:     decisive ? ((wins / decisive) * 100).toFixed(1) : "0.0",
    avgPeak:     n ? (totalPeak / n).toFixed(2) : "0.00",
    avgDuration: n ? (totalDur  / n).toFixed(1) : "0.0",
    checksTotal: checks.length,
    blockCounts,
    botStatus:   live.botStatus,
    dailyTrades: live.dailyTrades,
  });
});

// ── API: GET /api/symbols ─────────────────────────────────────────────────────
app.get("/api/symbols", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  const map = {};
  for (const c of closes) {
    const sym = c.symbol;
    if (!map[sym]) map[sym] = { symbol: sym, trades: 0, wins: 0, losses: 0, breakevens: 0, totalPeak: 0, totalProfitPips: 0 };
    const d  = c.data;
    const oc = classifyOutcome(d);
    map[sym].trades++;
    if (oc === "WIN")       map[sym].wins++;
    else if (oc === "LOSS") map[sym].losses++;
    else                    map[sym].breakevens++;
    map[sym].totalPeak       += d.peak || 0;
    map[sym].totalProfitPips += d.profitPips || 0;
  }

  const result = Object.values(map).map(s => {
    const decisive = s.wins + s.losses;
    return {
      ...s,
      winRate:   decisive ? ((s.wins / decisive) * 100).toFixed(1) : "0.0",
      avgPeak:   s.trades ? (s.totalPeak / s.trades).toFixed(2) : "0.00",
      avgProfit: s.trades ? (s.totalProfitPips / s.trades).toFixed(2) : "0.00",
    };
  });

  res.json(result);
});

// ── API: GET /api/live ────────────────────────────────────────────────────────
app.get("/api/live", async (req, res) => {
  res.json({
    botStatus:    live.botStatus,
    dailyTrades:  live.dailyTrades,
    openTrades:   Object.values(live.openTrades),
    recentBlocks: live.recentBlocks,
  });
});

// ── API: GET /api/export ──────────────────────────────────────────────────────
app.get("/api/export", async (req, res) => {
  const date   = parseDate(req.query.date || "today");
  const format = req.query.format || "json";
  const rows   = await queryEvents({ date, limit: 50000 });

  if (format === "csv") {
    const cols    = ["id","ts","bot_id","type","symbol"];
    const dataKeys = new Set();
    rows.forEach(r => Object.keys(r.data).forEach(k => dataKeys.add(k)));
    const dkArr  = [...dataKeys].filter(k => !["type","symbol","ts","botId","timestamp"].includes(k));
    const header = [...cols, ...dkArr].join(",");
    const lines  = rows.map(r => {
      const base = [r.id, r.ts, r.bot_id, r.type, r.symbol || ""].map(v => `"${v}"`).join(",");
      const data = dkArr.map(k => {
        const v = r.data[k];
        return v === undefined ? "" : `"${String(v).replace(/"/g,'""')}"`;
      }).join(",");
      return base + "," + data;
    });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="forex_${date}.csv"`);
    res.send([header, ...lines].join("\n"));
    return;
  }

  res.setHeader("Content-Disposition", `attachment; filename="forex_${date}.json"`);
  res.json({ date, exported: rows.length, events: rows });
});

// ── API: GET /api/exit-manager ────────────────────────────────────────────────
// Aggregate exit quality metrics across all closed trades.
// Fields: avg_mfe_capture_pct, avg_profit_given_back, exit_efficiency,
//         avg_mfe30, avg_mfe60, avg_mfe120 (time-based MFE snapshots).
app.get("/api/exit-manager", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  let totalMfeCap  = 0, nMfeCap  = 0;
  let totalGiven   = 0, nGiven   = 0;
  let totalEff     = 0, nEff     = 0;
  let totalMfe30   = 0, nMfe30   = 0;
  let totalMfe60   = 0, nMfe60   = 0;
  let totalMfe120  = 0, nMfe120  = 0;
  let totalRetained = 0, nRetained = 0;
  // EXIT FLOOR PROTECTION stats (v39.4)
  let floorTriggeredCount = 0;
  let totalSavedLoss = 0, nSavedLoss = 0;
  let totalProtectedProfit = 0, nProtectedProfit = 0;
  const reasonCounts = {};

  for (const c of closes) {
    const d = c.data;
    if (d.mfeCapturedPct      != null && Number.isFinite(d.mfeCapturedPct))      { totalMfeCap  += d.mfeCapturedPct;      nMfeCap++;  }
    if (d.profitGivenBackPips != null && Number.isFinite(d.profitGivenBackPips)) { totalGiven   += d.profitGivenBackPips; nGiven++;   }
    if (d.exitEfficiency      != null && Number.isFinite(d.exitEfficiency))      { totalEff     += d.exitEfficiency;      nEff++;     }
    if (d.mfe30  != null && Number.isFinite(d.mfe30))  { totalMfe30  += d.mfe30;  nMfe30++;  }
    if (d.mfe60  != null && Number.isFinite(d.mfe60))  { totalMfe60  += d.mfe60;  nMfe60++;  }
    if (d.mfe120 != null && Number.isFinite(d.mfe120)) { totalMfe120 += d.mfe120; nMfe120++; }
    // EXIT REASON DISTRIBUTION
    const reason = d.reason || "UNKNOWN";
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    // RETAINED PROFIT % — pips actually kept as % of peak move
    if (d.peak != null && d.peak > 0 && d.profitPips != null) {
      totalRetained += (Math.max(0, d.profitPips) / d.peak) * 100;
      nRetained++;
    }
    // EXIT FLOOR PROTECTION (v39.4)
    if (d.exit_floor_triggered === true) {
      floorTriggeredCount++;
      if (d.saved_loss        != null && Number.isFinite(d.saved_loss))        { totalSavedLoss       += d.saved_loss;        nSavedLoss++;        }
      if (d.protected_profit  != null && Number.isFinite(d.protected_profit))  { totalProtectedProfit += d.protected_profit;  nProtectedProfit++;  }
    }
  }

  const reasonDistribution = Object.entries(reasonCounts)
    .map(([reason, count]) => ({
      reason,
      count,
      pct: closes.length > 0 ? parseFloat(((count / closes.length) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  res.json({
    totalTrades:            closes.length,
    avg_mfe_capture_pct:    nMfeCap   ? parseFloat((totalMfeCap   / nMfeCap).toFixed(1))   : null,
    avg_profit_given_back:  nGiven    ? parseFloat((totalGiven    / nGiven).toFixed(2))    : null,
    exit_efficiency:        nEff      ? parseFloat((totalEff      / nEff).toFixed(1))      : null,
    avg_retained_profit:    nRetained ? parseFloat((totalRetained / nRetained).toFixed(1)) : null,
    avg_mfe30:              nMfe30    ? parseFloat((totalMfe30    / nMfe30).toFixed(2))    : null,
    avg_mfe60:              nMfe60    ? parseFloat((totalMfe60    / nMfe60).toFixed(2))    : null,
    avg_mfe120:             nMfe120   ? parseFloat((totalMfe120   / nMfe120).toFixed(2))   : null,
    sampleMfe30:            nMfe30,
    sampleMfe60:            nMfe60,
    sampleMfe120:           nMfe120,
    reasonDistribution,
    // EXIT FLOOR PROTECTION stats (v39.4)
    floor_triggered_count:  floorTriggeredCount,
    avg_saved_pips:         nSavedLoss       ? parseFloat((totalSavedLoss       / nSavedLoss).toFixed(2))       : null,
    avg_protected_profit:   nProtectedProfit ? parseFloat((totalProtectedProfit / nProtectedProfit).toFixed(2)) : null,
  });
});

// ── API: GET /api/spread-edge-analysis ───────────────────────────────────────
// Classifies spread_edge_block events into LOW / MEDIUM / HIGH tiers by edgeRatio.
// Joins with blocked_outcome events (15-min window) for move stats per tier.
// HIGH  0.90–1.15 — near-miss, almost profitable edge
// MEDIUM 0.60–0.90 — moderate shortfall
// LOW   < 0.60    — very poor edge, wide spread relative to expected move
app.get("/api/spread-edge-analysis", async (req, res) => {
  const date     = req.query.date ? parseDate(req.query.date) : undefined;
  const blocks   = await queryEvents({ type: "spread_edge_block", date, limit: 20000 });
  const outcomes = (await queryEvents({ type: "blocked_outcome",   date, limit: 20000 }))
    .filter(o => o.data.blockType === "spread_edge_block");

  const outcomeBySignal = {};
  for (const o of outcomes) {
    const sid = o.data.signalId;
    if (sid) outcomeBySignal[sid] = o.data;
  }

  function classify(er) {
    if (er >= 0.90) return "HIGH";
    if (er >= 0.60) return "MEDIUM";
    return "LOW";
  }

  const tiers = {
    HIGH:   { total: 0, withOutcome: 0, movedCount: 0, totalMove: 0, dirCorrect: 0, description: "edgeRatio 0.90–1.15 — near-miss" },
    MEDIUM: { total: 0, withOutcome: 0, movedCount: 0, totalMove: 0, dirCorrect: 0, description: "edgeRatio 0.60–0.90 — moderate gap" },
    LOW:    { total: 0, withOutcome: 0, movedCount: 0, totalMove: 0, dirCorrect: 0, description: "edgeRatio < 0.60 — wide spread" },
  };

  for (const b of blocks) {
    const cls = classify(b.data.edgeRatio || 0);
    const t   = tiers[cls];
    t.total++;
    const oc = b.data.signalId ? outcomeBySignal[b.data.signalId] : null;
    if (oc) {
      t.withOutcome++;
      t.totalMove += oc.absoluteMovePips || 0;
      if (oc.wouldHaveOutcome === "MOVED") t.movedCount++;
      if (oc.directionCorrect === true)    t.dirCorrect++;
    }
  }

  const classes = Object.entries(tiers).map(([cls, t]) => ({
    class:         cls,
    description:   t.description,
    total:         t.total,
    withOutcome:   t.withOutcome,
    movedPct:      t.withOutcome > 0 ? parseFloat(((t.movedCount / t.withOutcome) * 100).toFixed(1)) : null,
    dirCorrectPct: t.withOutcome > 0 ? parseFloat(((t.dirCorrect / t.withOutcome) * 100).toFixed(1)) : null,
    avgMove:       t.withOutcome > 0 ? parseFloat((t.totalMove   / t.withOutcome).toFixed(2))        : null,
  }));

  res.json({ classes, totalBlocked: blocks.length, totalWithOutcomes: outcomes.length });
});

// ── API: GET /api/cooldown-analysis ───────────────────────────────────────────
// Analyzes cooldown_block events: blocked count, direction breakdown, move stats.
// Direction from lastDirection field (set v39.3+, proxied from lastTradeDirection[symbol]).
// Subsequent price movement from blocked_outcome events (15-min window).
app.get("/api/cooldown-analysis", async (req, res) => {
  const date     = req.query.date ? parseDate(req.query.date) : undefined;
  const blocks   = await queryEvents({ type: "cooldown_block",  date, limit: 20000 });
  const outcomes = (await queryEvents({ type: "blocked_outcome", date, limit: 20000 }))
    .filter(o => o.data.blockType === "cooldown_block");

  const outcomeBySignal = {};
  for (const o of outcomes) {
    const sid = o.data.signalId;
    if (sid) outcomeBySignal[sid] = o.data;
  }

  const symbolMap  = {};
  const sessionMap = {};
  let buyBlocked = 0, sellBlocked = 0, noDir = 0;
  let buyCorrect = 0, sellCorrect = 0;
  let totalMove = 0, nMove = 0, movedCount = 0;

  for (const b of blocks) {
    const dir = b.data.lastDirection || null;
    const sym = b.symbol || b.data.symbol;
    const ses = b.data.session || "UNKNOWN";

    if (dir === "buy")       buyBlocked++;
    else if (dir === "sell") sellBlocked++;
    else                     noDir++;

    if (!symbolMap[sym])  symbolMap[sym]  = { symbol: sym,  total: 0, withOutcome: 0, _move: 0 };
    if (!sessionMap[ses]) sessionMap[ses] = { session: ses, total: 0, withOutcome: 0 };
    symbolMap[sym].total++;
    sessionMap[ses].total++;

    const oc = b.data.signalId ? outcomeBySignal[b.data.signalId] : null;
    if (oc) {
      totalMove += oc.absoluteMovePips || 0;
      nMove++;
      symbolMap[sym].withOutcome++;
      symbolMap[sym]._move += oc.absoluteMovePips || 0;
      sessionMap[ses].withOutcome++;
      if (oc.wouldHaveOutcome === "MOVED") movedCount++;
      if (oc.directionCorrect === true) {
        if (dir === "buy")       buyCorrect++;
        else if (dir === "sell") sellCorrect++;
      }
    }
  }

  const bySymbol = Object.values(symbolMap).map(s => ({
    symbol:      s.symbol,
    total:       s.total,
    withOutcome: s.withOutcome,
    avgMove:     s.withOutcome > 0 ? parseFloat((s._move / s.withOutcome).toFixed(2)) : null,
  })).sort((a, b) => b.total - a.total);

  const bySession = Object.values(sessionMap).sort((a, b) => b.total - a.total);

  res.json({
    totalBlocked:      blocks.length,
    totalWithOutcomes: outcomes.length,
    movedPct:          nMove > 0 ? parseFloat(((movedCount  / nMove) * 100).toFixed(1)) : null,
    avgMove:           nMove > 0 ? parseFloat((totalMove    / nMove).toFixed(2))        : null,
    buy:  { blocked: buyBlocked,  dirCorrectPct: buyBlocked  > 0 ? parseFloat(((buyCorrect  / buyBlocked)  * 100).toFixed(1)) : null },
    sell: { blocked: sellBlocked, dirCorrectPct: sellBlocked > 0 ? parseFloat(((sellCorrect / sellBlocked) * 100).toFixed(1)) : null },
    noDirectionCount: noDir,
    bySymbol,
    bySession,
  });
});

// ── SSE: GET /api/events/stream ───────────────────────────────────────────────
app.get("/api/events/stream", async (req, res) => {
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  sseClients.add(res);

  res.write(`data: ${JSON.stringify({ source: "live", type: "init", live: {
    botStatus:    live.botStatus,
    dailyTrades:  live.dailyTrades,
    openTrades:   Object.values(live.openTrades),
    recentBlocks: live.recentBlocks,
  } })}\n\n`);

  const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch (_) {} }, 25000);
  req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
});

// ── API: GET /api/winrate-analysis ───────────────────────────────────────────
app.get("/api/winrate-analysis", async (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;

  const opens  = await queryEvents({ type: "trade_open",    date, limit: 5000  });
  const closes = await queryEvents({ type: "trade_close",   date, limit: 5000  });
  const regime = await queryEvents({ type: "market_regime", date, limit: 50000 });

  const regBySymbol = {};
  for (const r of regime) {
    (regBySymbol[r.symbol] = regBySymbol[r.symbol] || []).push(r);
  }

  const matched = [];
  for (const o of opens) {
    const sym    = o.symbol;
    const openTs = o.ts;
    const close  = closes.find(c => c.symbol === sym && c.ts >= openTs);
    if (!close) continue;

    const won    = classifyOutcome(close.data) === "WIN";
    const pool   = regBySymbol[sym] || [];
    let best = null, bestDiff = Infinity;
    for (const r of pool) {
      const diff = Math.abs(new Date(r.ts) - new Date(openTs));
      if (diff < bestDiff) { bestDiff = diff; best = r; }
    }
    matched.push({
      symbol:      sym,
      won,
      profitPips:  close.data.profitPips || 0,
      atr:         best?.data?.atr          ?? null,
      spread:      best?.data?.spread       ?? null,
      emaDistance: best?.data?.emaDistance  ?? null,
      hour:        best?.data?.hour         ?? new Date(openTs).getUTCHours(),
      dow:         best?.data?.dow          ?? new Date(openTs).getUTCDay(),
      // NEW: session and bucket fields from enriched trade_open data
      session:     close.data.session       ?? o.data.session  ?? null,
      volBucket:   close.data.volatilityBucket ?? o.data.volatilityBucket ?? null,
      trendBkt:    close.data.trendBucket      ?? o.data.trendBucket      ?? null,
    });
  }

  function bucketWinRate(items, getKey) {
    const map = {};
    for (const t of items) {
      const k = getKey(t);
      if (k === null || k === undefined) continue;
      if (!map[k]) map[k] = { wins: 0, total: 0 };
      map[k].total++;
      if (t.won) map[k].wins++;
    }
    return Object.entries(map)
      .map(([key, v]) => ({
        key,
        winRate: v.total > 0 ? parseFloat(((v.wins / v.total) * 100).toFixed(1)) : 0,
        trades:  v.total,
        wins:    v.wins,
      }))
      .sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
  }

  const atrBuckets = bucketWinRate(matched, t => {
    if (t.atr === null) return null;
    const a = parseFloat(t.atr);
    if (a < 5)  return "0-5 p";
    if (a < 10) return "5-10 p";
    if (a < 15) return "10-15 p";
    if (a < 20) return "15-20 p";
    return "20+ p";
  });

  const hourBuckets = bucketWinRate(matched, t =>
    t.hour !== null && t.hour !== undefined ? String(t.hour).padStart(2, "0") + ":00" : null
  );

  const spreadBuckets = bucketWinRate(matched, t => {
    if (t.spread === null) return null;
    const s = parseFloat(t.spread);
    if (s < 0.5) return "0-0.5";
    if (s < 1.0) return "0.5-1.0";
    if (s < 1.5) return "1.0-1.5";
    return "1.5+";
  });

  const symbolBuckets  = bucketWinRate(matched, t => t.symbol);
  const sessionBuckets = bucketWinRate(matched, t => t.session);
  const volBuckets     = bucketWinRate(matched, t => t.volBucket);
  const trendBuckets   = bucketWinRate(matched, t => t.trendBkt);

  res.json({
    atrBuckets, hourBuckets, spreadBuckets, symbolBuckets,
    sessionBuckets, volBuckets, trendBuckets,
    totalTrades: matched.length,
  });
});

// ── API: GET /api/fingerprints ────────────────────────────────────────────────
app.get("/api/fingerprints", async (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;
  const minN = parseInt(req.query.min || "1");

  const opens  = await queryEvents({ type: "trade_open",  date, limit: 5000 });
  const closes = await queryEvents({ type: "trade_close", date, limit: 5000 });

  const matched = [];
  for (const o of opens) {
    const fp = o.data.fingerprint;
    if (!fp) continue;
    const close = closes.find(c => c.symbol === o.symbol && c.ts >= o.ts);
    if (!close) continue;

    matched.push({
      fingerprint: fp,
      fpDetail:    o.data.fp || null,
      symbol:      o.symbol,
      side:        o.data.side,
      won:         classifyOutcome(close.data) === "WIN",
      profitPips:  close.data.profitPips || 0,
      mfe:         close.data.mfe              || 0,
      mae:         Math.abs(close.data.mae     || 0),
    });
  }

  const groups = {};
  for (const t of matched) {
    const k = t.fingerprint;
    if (!groups[k]) groups[k] = { fingerprint: k, fpDetail: t.fpDetail, wins: 0, total: 0, totalPips: 0, totalMfe: 0, totalMae: 0 };
    groups[k].total++;
    groups[k].totalPips += t.profitPips;
    groups[k].totalMfe  += t.mfe;
    groups[k].totalMae  += t.mae;
    if (t.won) groups[k].wins++;
  }

  const list = Object.values(groups)
    .filter(g => g.total >= minN)
    .map(g => ({
      fingerprint: g.fingerprint,
      fpDetail:    g.fpDetail,
      wins:        g.wins,
      losses:      g.total - g.wins,
      total:       g.total,
      winRate:     parseFloat(((g.wins / g.total) * 100).toFixed(1)),
      avgPips:     parseFloat((g.totalPips / g.total).toFixed(2)),
      avgMfe:      parseFloat((g.totalMfe  / g.total).toFixed(2)),
      avgMae:      parseFloat((g.totalMae  / g.total).toFixed(2)),
    }));

  const byWinRate  = (a, b) => b.winRate - a.winRate || b.total - a.total;
  const top20      = [...list].sort(byWinRate).slice(0, 20);
  const bottom20   = [...list].sort((a, b) => -byWinRate(a, b)).slice(0, 20);

  res.json({ top20, bottom20, totalTrades: matched.length, uniquePatterns: list.length });
});

// ── API: GET /api/excursion ───────────────────────────────────────────────────
app.get("/api/excursion", async (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;

  const closes = await queryEvents({ type: "trade_close", date, limit: 5000 });
  const real   = closes.map(c => ({ ...c, oc: classifyOutcome(c.data) }));
  const wins   = real.filter(r => r.oc === "WIN");
  const losses = real.filter(r => r.oc === "LOSS");

  function agg(arr, key) {
    const vals = arr.map(r => r.data[key]).filter(v => v != null && Number.isFinite(v));
    if (!vals.length) return { avg: null, min: null, max: null, n: 0 };
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      avg: parseFloat((sum / vals.length).toFixed(2)),
      min: parseFloat(Math.min(...vals).toFixed(2)),
      max: parseFloat(Math.max(...vals).toFixed(2)),
      n:   vals.length,
    };
  }

  const allMFE  = agg(real,   "mfe");
  const allMAE  = agg(real,   "mae");
  const winMFE  = agg(wins,   "mfe");
  const lossMFE = agg(losses, "mfe");
  const winMAE  = agg(wins,   "mae");
  const lossMAE = agg(losses, "mae");

  const mfeMAERatio = (allMFE.avg != null && allMAE.avg != null && allMAE.avg !== 0)
    ? parseFloat((allMFE.avg / Math.abs(allMAE.avg)).toFixed(2))
    : null;

  function hist(arr, key, size = 2) {
    const map = {};
    for (const r of arr) {
      const v = r.data[key];
      if (v == null || !Number.isFinite(v)) continue;
      const b = Math.round(v / size) * size;
      map[b] = (map[b] || 0) + 1;
    }
    return Object.entries(map)
      .map(([k, count]) => ({ bucket: parseFloat(k), count }))
      .sort((a, b) => a.bucket - b.bucket);
  }

  const mfeHist = hist(real, "mfe");
  const maeHist = hist(real, "mae");

  const comparison = [
    { label: "MFE avg",  win: winMFE.avg,  loss: lossMFE.avg  },
    { label: "MFE max",  win: winMFE.max,  loss: lossMFE.max  },
    { label: "MAE avg",  win: winMAE.avg,  loss: lossMAE.avg  },
    { label: "MAE min",  win: winMAE.min,  loss: lossMAE.min  },
  ];

  // EXIT EFFICIENCY analytics — TELEMETRY ONLY
  const exitEff  = agg(real, "exitEfficiency");
  const entryEff = agg(real, "entryEfficiencyPips");

  res.json({
    totalTrades: real.length,
    wins:        wins.length,
    losses:      losses.length,
    mfeMAERatio,
    allMFE, allMAE,
    winMFE, lossMFE,
    winMAE, lossMAE,
    mfeHist, maeHist,
    comparison,
    exitEfficiency:  exitEff,
    entryEfficiency: entryEff,
    timing: {
      timeToProfit: agg(real, "timeToProfit"),
      timeToDd:     agg(real, "timeToDd"),
      breakEven:    agg(real, "beTime"),
    },
  });
});

// ── API: GET /api/confirmation-lag ───────────────────────────────────────────
// Counts how often each entry condition is TRUE vs FALSE across all buy/sell checks.
// Lowest trueRate = most restrictive condition = likely the lag source.
app.get("/api/confirmation-lag", async (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;

  const [_chkBuy, _chkSell] = await Promise.all([
    await queryEvents({ type: "buy_check",  date, limit: 5000 }),
    await queryEvents({ type: "sell_check", date, limit: 5000 }),
  ]);
  const checks = _chkBuy.concat(_chkSell);

  const conditions = ["trend","candle","ema","strength","m1trend","m1candle","m1prev","m1close"];
  const counts = {};
  for (const k of conditions) counts[k] = { trueN: 0, falseN: 0, total: 0 };

  for (const c of checks) {
    const d = c.data;
    for (const k of conditions) {
      if (d[k] !== undefined) {
        counts[k].total++;
        if (d[k]) counts[k].trueN++;
        else       counts[k].falseN++;
      }
    }
  }

  const result = conditions
    .map(k => ({
      condition: k,
      total:     counts[k].total,
      trueN:     counts[k].trueN,
      falseN:    counts[k].falseN,
      trueRate:  counts[k].total ? parseFloat((counts[k].trueN / counts[k].total * 100).toFixed(1)) : null,
    }))
    .sort((a, b) => (a.trueRate ?? 100) - (b.trueRate ?? 100));

  res.json({
    totalChecks:      checks.length,
    conditions:       result,
    mostRestrictive:  result[0]                  || null,
    leastRestrictive: result[result.length - 1]  || null,
    postEntryFailures: await queryEvents({ type: "post_entry_failure", date, limit: 500 }).length,
  });
});

// ── API: GET /api/regime ──────────────────────────────────────────────────────
app.get("/api/regime", async (req, res) => {
  const rows = await queryEvents({
    type:   "market_regime",
    symbol: req.query.symbol,
    date:   req.query.date ? parseDate(req.query.date) : undefined,
    limit:  parseInt(req.query.limit || "1000"),
  });
  res.json(rows);
});

// ── API: GET /api/session-performance ────────────────────────────────────────
// Aggregates trade_close events by market session (ASIA/LONDON/OVERLAP/NEW_YORK/DEAD_ZONE).
// Returns win rate, avg profit, avg MFE per session for regime-based analysis.
app.get("/api/session-performance", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  const map = {};
  for (const c of closes) {
    const session = c.data.session || "UNKNOWN";
    if (!map[session]) map[session] = { session, trades: 0, wins: 0, losses: 0, totalPips: 0, totalMFE: 0, totalExit: 0, exitN: 0 };
    const d  = c.data;
    const oc = classifyOutcome(d);
    map[session].trades++;
    if (oc === "WIN")       map[session].wins++;
    else if (oc === "LOSS") map[session].losses++;
    map[session].totalPips += d.profitPips || 0;
    map[session].totalMFE  += d.mfe        || 0;
    if (d.exitEfficiency != null) {
      map[session].totalExit += d.exitEfficiency;
      map[session].exitN++;
    }
  }

  const result = Object.values(map).map(s => {
    const decisive = s.wins + s.losses;
    return {
      session:      s.session,
      trades:       s.trades,
      wins:         s.wins,
      losses:       s.losses,
      winRate:      decisive ? parseFloat(((s.wins / decisive) * 100).toFixed(1)) : 0,
      avgPips:      s.trades ? parseFloat((s.totalPips / s.trades).toFixed(2)) : 0,
      avgMFE:       s.trades ? parseFloat((s.totalMFE  / s.trades).toFixed(2)) : 0,
      avgExitEff:   s.exitN  ? parseFloat((s.totalExit / s.exitN).toFixed(1))  : null,
    };
  }).sort((a, b) => b.winRate - a.winRate);

  res.json(result);
});

// ── API: GET /api/blocked-outcomes ───────────────────────────────────────────
// Returns blocked_outcome events for filter effectiveness analysis.
// Shows whether filtered signals would have been profitable 15 min later.
app.get("/api/blocked-outcomes", async (req, res) => {
  const date  = req.query.date ? parseDate(req.query.date) : undefined;
  const rows  = await queryEvents({ type: "blocked_outcome", date, limit: 2000 });

  const byType = {};
  for (const r of rows) {
    const bt = r.data.blockType || "unknown";
    if (!byType[bt]) byType[bt] = { blockType: bt, total: 0, moved: 0, stagnant: 0, totalMovePips: 0 };
    byType[bt].total++;
    byType[bt].totalMovePips += r.data.absoluteMovePips || 0;
    if (r.data.wouldHaveOutcome === "MOVED") byType[bt].moved++;
    else                                      byType[bt].stagnant++;
  }

  const summary = Object.values(byType).map(b => ({
    blockType:     b.blockType,
    total:         b.total,
    moved:         b.moved,
    stagnant:      b.stagnant,
    movedPct:      b.total ? parseFloat(((b.moved / b.total) * 100).toFixed(1)) : 0,
    avgMovePips:   b.total ? parseFloat((b.totalMovePips / b.total).toFixed(2)) : 0,
  })).sort((a, b) => b.movedPct - a.movedPct);

  res.json({ summary, recent: rows.slice(0, 50).map(r => r.data), total: rows.length });
});

// ── API: GET /api/drift ───────────────────────────────────────────────────────
// Returns recent strategy_drift_alert events for monitoring.
app.get("/api/drift", async (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;
  const rows = await queryEvents({ type: "strategy_drift_alert", date, limit: 100 });
  res.json({ alerts: rows.map(r => ({ ts: r.ts, ...r.data })), total: rows.length });
});

// ── API: GET /api/insights ────────────────────────────────────────────────────
// Aggregated decision intelligence — best/worst session, symbol, fingerprint,
// exit efficiency, filter cost analysis, regime performance.
// Powers the INSIGHTS tab in the dashboard.
app.get("/api/insights", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const closes = await queryEvents({ type: "trade_close",  date, limit: 10000 });
  const opens  = await queryEvents({ type: "trade_open",   date, limit: 10000 });
  const blocks = await queryEvents({ date, limit: 20000 })
    .filter(e => e.type.endsWith("_block") && !e.type.startsWith("signal_"));

  // ── Session performance ───────────────────────────────────────────────────
  const sessionMap = {};
  for (const c of closes) {
    const s = c.data.session || "UNKNOWN";
    if (!sessionMap[s]) sessionMap[s] = { wins: 0, losses: 0, totalPips: 0, totalMFE: 0, totalExitEff: 0, exitN: 0 };
    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       sessionMap[s].wins++;
    else if (oc === "LOSS") sessionMap[s].losses++;
    sessionMap[s].totalPips    += c.data.profitPips || 0;
    sessionMap[s].totalMFE     += c.data.mfe        || 0;
    if (c.data.exitEfficiency != null) {
      sessionMap[s].totalExitEff += c.data.exitEfficiency;
      sessionMap[s].exitN++;
    }
  }
  const sessionStats = Object.entries(sessionMap).map(([session, s]) => {
    const decisive = s.wins + s.losses;
    return {
      session,
      winRate:    decisive ? parseFloat(((s.wins / decisive) * 100).toFixed(1)) : 0,
      avgPips:    (s.wins + s.losses) ? parseFloat((s.totalPips / (s.wins + s.losses)).toFixed(2)) : 0,
      avgMFE:     (s.wins + s.losses) ? parseFloat((s.totalMFE  / (s.wins + s.losses)).toFixed(2)) : 0,
      avgExitEff: s.exitN ? parseFloat((s.totalExitEff / s.exitN).toFixed(1)) : null,
      trades:     s.wins + s.losses,
    };
  });
  const bestSession  = sessionStats.sort((a, b) => b.winRate - a.winRate)[0] || null;
  const worstSession = [...sessionStats].sort((a, b) => a.winRate - b.winRate)[0] || null;

  // ── Symbol performance ────────────────────────────────────────────────────
  const symMap = {};
  for (const c of closes) {
    const sym = c.symbol;
    if (!symMap[sym]) symMap[sym] = { wins: 0, losses: 0, totalPips: 0 };
    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       symMap[sym].wins++;
    else if (oc === "LOSS") symMap[sym].losses++;
    symMap[sym].totalPips += c.data.profitPips || 0;
  }
  const symStats = Object.entries(symMap).map(([symbol, s]) => {
    const decisive = s.wins + s.losses;
    return { symbol, winRate: decisive ? parseFloat(((s.wins / decisive) * 100).toFixed(1)) : 0, trades: decisive, avgPips: decisive ? parseFloat((s.totalPips / decisive).toFixed(2)) : 0 };
  });
  const worstSymbol = symStats.sort((a, b) => a.winRate - b.winRate)[0] || null;
  const bestSymbol  = [...symStats].sort((a, b) => b.winRate - a.winRate)[0] || null;

  // ── Most expensive filter (most blocks) ──────────────────────────────────
  const blockCounts = {};
  for (const b of blocks) {
    blockCounts[b.type] = (blockCounts[b.type] || 0) + 1;
  }
  const blockArr         = Object.entries(blockCounts).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  const mostExpensiveFilter = blockArr[0] || null;
  const totalBlocks         = blockArr.reduce((s, b) => s + b.count, 0);

  // ── Exit efficiency ───────────────────────────────────────────────────────
  const effVals = closes
    .map(c => c.data.exitEfficiency)
    .filter(v => v != null && Number.isFinite(v));
  const avgExitEfficiency = effVals.length
    ? parseFloat((effVals.reduce((a, b) => a + b, 0) / effVals.length).toFixed(1))
    : null;
  const lowestExitEff = effVals.length ? parseFloat(Math.min(...effVals).toFixed(1)) : null;

  // ── Entry efficiency ──────────────────────────────────────────────────────
  const entryVals = closes
    .map(c => c.data.entryEfficiencyPips)
    .filter(v => v != null && Number.isFinite(v));
  const avgEntryEfficiency = entryVals.length
    ? parseFloat((entryVals.reduce((a, b) => a + b, 0) / entryVals.length).toFixed(2))
    : null;

  // ── Fingerprint ───────────────────────────────────────────────────────────
  const fpGroups = {};
  for (const o of opens) {
    const fp = o.data.fingerprint;
    if (!fp) continue;
    const close = closes.find(c => c.symbol === o.symbol && c.ts >= o.ts);
    if (!close) continue;
    if (!fpGroups[fp]) fpGroups[fp] = { wins: 0, total: 0, totalPips: 0 };
    fpGroups[fp].total++;
    fpGroups[fp].totalPips += close.data.profitPips || 0;
    if (classifyOutcome(close.data) === "WIN") fpGroups[fp].wins++;
  }
  const fpList = Object.entries(fpGroups)
    .map(([fp, g]) => ({ fp, winRate: parseFloat(((g.wins / g.total) * 100).toFixed(1)), avgPips: parseFloat((g.totalPips / g.total).toFixed(2)), total: g.total }))
    .filter(g => g.total >= 2);
  const bestFingerprint  = fpList.sort((a, b) => b.winRate - a.winRate)[0] || null;
  const worstFingerprint = [...fpList].sort((a, b) => a.winRate - b.winRate)[0] || null;

  // ── Volatility regime performance ─────────────────────────────────────────
  const volMap = {};
  for (const c of closes) {
    const vb = c.data.volatilityBucket || "UNKNOWN";
    if (!volMap[vb]) volMap[vb] = { wins: 0, losses: 0, totalPips: 0, totalMFE: 0 };
    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       volMap[vb].wins++;
    else if (oc === "LOSS") volMap[vb].losses++;
    volMap[vb].totalPips += c.data.profitPips || 0;
    volMap[vb].totalMFE  += c.data.mfe        || 0;
  }
  const volStats = Object.entries(volMap).map(([bucket, v]) => {
    const decisive = v.wins + v.losses;
    return { bucket, winRate: decisive ? parseFloat(((v.wins / decisive) * 100).toFixed(1)) : 0, avgMFE: decisive ? parseFloat((v.totalMFE / decisive).toFixed(2)) : 0, trades: decisive };
  });
  const highestMFERegime = volStats.sort((a, b) => b.avgMFE - a.avgMFE)[0] || null;
  const bestVolRegime    = [...volStats].sort((a, b) => b.winRate - a.winRate)[0] || null;

  // ── Post-entry failures ───────────────────────────────────────────────────
  const postEntryFailures = await queryEvents({ type: "post_entry_failure", date, limit: 500 }).length;

  // ── Drift alerts ──────────────────────────────────────────────────────────
  const driftAlerts = await queryEvents({ type: "strategy_drift_alert", date, limit: 10 });

  res.json({
    summary: {
      totalTrades:        closes.length,
      totalBlocks,
      avgExitEfficiency,
      avgEntryEfficiency,
      postEntryFailures,
      driftAlertCount:   driftAlerts.length,
    },
    bestSession,
    worstSession,
    bestSymbol,
    worstSymbol,
    mostExpensiveFilter,
    blockBreakdown: blockArr,
    bestFingerprint,
    worstFingerprint,
    highestMFERegime,
    bestVolRegime,
    sessionStats,
    volStats,
    recentDriftAlerts: driftAlerts.slice(0, 3).map(r => ({ ts: r.ts, ...r.data })),
  });
});

// ── API: GET /api/m1trend-experiment ──────────────────────────────────────────
// Project Snowball — M1Trend hard-block removal experiment.
// Segments all closed trades by m1TrendAtEntry boolean from trade_open events.
// Group A: m1trend=true (baseline)   Group B: m1trend=false (experiment)
// Compare win rate, avg pips, avg MFE, avg MAE, exit efficiency for both groups.
app.get("/api/m1trend-experiment", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = await queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  // Index opens by signalId for fast lookup
  const openMap = {};
  for (const o of opens) {
    if (o.data.signalId) openMap[o.data.signalId] = o.data;
  }

  const makeGroup = () => ({ wins: 0, losses: 0, be: 0, totalPips: 0, totalMFE: 0, totalMAE: 0, exitEffArr: [], n: 0 });
  const groups = { m1true: makeGroup(), m1false: makeGroup(), unknown: makeGroup() };

  for (const c of closes) {
    const od = openMap[c.data.signalId];
    let grp;
    if (!od || od.m1TrendAtEntry === undefined) grp = groups.unknown;
    else grp = od.m1TrendAtEntry ? groups.m1true : groups.m1false;

    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       grp.wins++;
    else if (oc === "LOSS") grp.losses++;
    else                    grp.be++;
    grp.n++;
    grp.totalPips += c.data.profitPips || 0;
    grp.totalMFE  += c.data.mfe        || 0;
    grp.totalMAE  += c.data.mae        || 0;
    if (c.data.exitEfficiency != null) grp.exitEffArr.push(c.data.exitEfficiency);
  }

  function summarize(g, label) {
    const decisive = g.wins + g.losses;
    return {
      label,
      trades:    g.n,
      wins:      g.wins,
      losses:    g.losses,
      breakevens: g.be,
      winRate:   decisive ? ((g.wins / decisive) * 100).toFixed(1) : "0.0",
      avgPips:   g.n ? (g.totalPips / g.n).toFixed(2) : "0.00",
      avgMFE:    g.n ? (g.totalMFE  / g.n).toFixed(2) : "0.00",
      avgMAE:    g.n ? (g.totalMAE  / g.n).toFixed(2) : "0.00",
      avgExitEff: g.exitEffArr.length
        ? (g.exitEffArr.reduce((a, b) => a + b, 0) / g.exitEffArr.length).toFixed(1)
        : null,
    };
  }

  res.json({
    groupA:    summarize(groups.m1true,  "m1trend=TRUE  (baseline)"),
    groupB:    summarize(groups.m1false, "m1trend=FALSE (experiment)"),
    preExperiment: summarize(groups.unknown, "pre-experiment (no m1TrendAtEntry tag)"),
    experimentNote: "M1Trend_HardBlock_Removed — Project Snowball decision quality experiment. Rollback: git revert to b250cf5.",
  });
});

// ── API: GET /api/almost-trades ───────────────────────────────────────────────
// Returns per-condition stats aggregated from almost_trade_outcome events.
// "Almost trades" = setups passing >= 4 of 9 gate conditions that were NOT executed.
app.get("/api/almost-trades", async (req, res) => {
  const date     = req.query.date ? parseDate(req.query.date) : undefined;
  const outcomes = await queryEvents({ type: "almost_trade_outcome", date, limit: 10000 });
  const signals  = await queryEvents({ type: "almost_trade",         date, limit: 10000 });

  const condMap = {};
  for (const o of outcomes) {
    const d = o.data;
    for (const fc of (d.failedConditions || [])) {
      if (!condMap[fc]) condMap[fc] = { condition: fc, total: 0, reached2p: 0, reached4p: 0, reached6p: 0, totalMovePips: 0, correctDir: 0 };
      condMap[fc].total++;
      if (d.reached2p)        condMap[fc].reached2p++;
      if (d.reached4p)        condMap[fc].reached4p++;
      if (d.reached6p)        condMap[fc].reached6p++;
      if (d.directionCorrect) condMap[fc].correctDir++;
      condMap[fc].totalMovePips += Math.abs(d.maxMovePips || 0);
    }
  }

  const conditionStats = Object.values(condMap).map(c => ({
    condition:     c.condition,
    total:         c.total,
    reached2p:     c.reached2p,
    reached4p:     c.reached4p,
    reached6p:     c.reached6p,
    pct2p:         c.total ? ((c.reached2p / c.total) * 100).toFixed(1) : "0.0",
    pct4p:         c.total ? ((c.reached4p / c.total) * 100).toFixed(1) : "0.0",
    pct6p:         c.total ? ((c.reached6p / c.total) * 100).toFixed(1) : "0.0",
    avgMove:       c.total ? (c.totalMovePips / c.total).toFixed(1) : "0.0",
    dirCorrectPct: c.total ? ((c.correctDir / c.total) * 100).toFixed(1) : "0.0",
  })).sort((a, b) => parseFloat(b.pct4p) - parseFloat(a.pct4p));

  // Module 3: Missed Opportunities by pass score (passCount breakdown)
  const passcoreMap = {};
  for (const o of outcomes) {
    const pc = o.data.passCount;
    if (!pc) continue;
    const key = `${pc}/9`;
    if (!passcoreMap[key]) passcoreMap[key] = { score: key, passCount: pc, blocked: 0, reached2p: 0, reached4p: 0, reached6p: 0, totalMove: 0 };
    passcoreMap[key].blocked++;
    if (o.data.reached2p) passcoreMap[key].reached2p++;
    if (o.data.reached4p) passcoreMap[key].reached4p++;
    if (o.data.reached6p) passcoreMap[key].reached6p++;
    passcoreMap[key].totalMove += Math.abs(o.data.maxMovePips || 0);
  }
  const passcoreStats = Object.values(passcoreMap).sort((a, b) => b.passCount - a.passCount).map(p => ({
    score:   p.score,
    blocked: p.blocked,
    pct2p:   p.blocked ? ((p.reached2p / p.blocked) * 100).toFixed(1) : "0.0",
    pct4p:   p.blocked ? ((p.reached4p / p.blocked) * 100).toFixed(1) : "0.0",
    pct6p:   p.blocked ? ((p.reached6p / p.blocked) * 100).toFixed(1) : "0.0",
    avgMove: p.blocked ? (p.totalMove / p.blocked).toFixed(1) : "0.0",
  }));

  res.json({
    totalSignals:   signals.length,
    totalOutcomes:  outcomes.length,
    conditionStats,
    passcoreStats,
    recentSignals:  signals.slice(0, 20).map(r => ({ ts: r.ts, symbol: r.symbol, ...r.data })),
    recentOutcomes: outcomes.slice(0, 20).map(r => ({ ts: r.ts, symbol: r.symbol, ...r.data })),
  });
});

// ── API: GET /api/blocked-winners-v2 ─────────────────────────────────────────
// Blocked Winners Analysis V2 — per-condition BUY / SELL split.
// For each failing gate condition: shows whether it blocks BUY setups,
// SELL setups, or both, and how far price moved afterward.
app.get("/api/blocked-winners-v2", async (req, res) => {
  const date     = req.query.date ? parseDate(req.query.date) : undefined;
  const outcomes = await queryEvents({ type: "almost_trade_outcome", date, limit: 10000 });

  const condAll  = {};
  const condBuy  = {};
  const condSell = {};

  function addTo(map, fc, d) {
    if (!map[fc]) map[fc] = { condition: fc, total: 0, reached2p: 0, reached4p: 0, reached6p: 0, totalMove: 0, correctDir: 0 };
    map[fc].total++;
    if (d.reached2p)        map[fc].reached2p++;
    if (d.reached4p)        map[fc].reached4p++;
    if (d.reached6p)        map[fc].reached6p++;
    if (d.directionCorrect) map[fc].correctDir++;
    map[fc].totalMove += Math.abs(d.maxMovePips || 0);
  }

  function toStats(map) {
    return Object.values(map).map(c => ({
      condition:     c.condition,
      total:         c.total,
      pct2p:         c.total ? parseFloat(((c.reached2p / c.total) * 100).toFixed(1)) : 0,
      pct4p:         c.total ? parseFloat(((c.reached4p / c.total) * 100).toFixed(1)) : 0,
      pct6p:         c.total ? parseFloat(((c.reached6p / c.total) * 100).toFixed(1)) : 0,
      avgMove:       c.total ? parseFloat((c.totalMove   / c.total).toFixed(2)) : 0,
      dirCorrectPct: c.total ? parseFloat(((c.correctDir / c.total) * 100).toFixed(1)) : 0,
    })).sort((a, b) => b.pct4p - a.pct4p);
  }

  for (const o of outcomes) {
    const d   = o.data;
    const dir = (d.direction || "").toLowerCase();
    for (const fc of (d.failedConditions || [])) {
      addTo(condAll, fc, d);
      if (dir === "buy")  addTo(condBuy,  fc, d);
      if (dir === "sell") addTo(condSell, fc, d);
    }
  }

  res.json({
    total:         toStats(condAll),
    buy:           toStats(condBuy),
    sell:          toStats(condSell),
    totalOutcomes: outcomes.length,
  });
});

// ── API: GET /api/condition-performance ───────────────────────────────────────
// Per-condition pass / fail stats linked to trade outcomes via signalId.
// For each of the 9 gate conditions: pass count, fail count, win rate,
// avg pips, avg MFE, avg MAE — computed only for evaluations that led to a trade.
app.get("/api/condition-performance", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const checks = [
    ...await queryEvents({ type: "buy_check",  date, limit: 10000 }),
    ...await queryEvents({ type: "sell_check", date, limit: 10000 }),
  ];
  const opens  = await queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  const closeBySignal = {};
  for (const c of closes) {
    if (c.data.signalId) closeBySignal[c.data.signalId] = c.data;
  }

  const CONDS = ["trend", "m5close", "candle", "ema", "strength", "m1trend", "m1candle", "m1prev", "m1close"];

  // BLOCKED WINNERS % — join buy/sell_check.signalId → almost_trade_outcome.signalId
  // When condition k=false AND signal produced an almost_trade_outcome with reached4p → blocked winner
  const atOutcomes = await queryEvents({ type: "almost_trade_outcome", date, limit: 10000 });
  const atBySignal = {};
  for (const o of atOutcomes) {
    const sid = o.data.signalId;
    if (sid) atBySignal[sid] = o.data;
  }

  const stats = {};
  for (const k of CONDS) {
    stats[k] = { condition: k, passCount: 0, failCount: 0, traded: 0, wins: 0, losses: 0,
                 totalPips: 0, totalMfe: 0, totalMae: 0, failWithOutcome: 0, failReached4p: 0 };
  }

  for (const c of checks) {
    const d     = c.data;
    const close = d.signalId ? closeBySignal[d.signalId] : null;
    const ato   = d.signalId ? atBySignal[d.signalId]    : null;
    for (const k of CONDS) {
      const s = stats[k];
      if (d[k] === true) {
        s.passCount++;
        if (close) {
          s.traded++;
          const oc = classifyOutcome(close);
          if (oc === "WIN")       s.wins++;
          else if (oc === "LOSS") s.losses++;
          s.totalPips += close.profitPips || 0;
          s.totalMfe  += close.mfe        || 0;
          s.totalMae  += Math.abs(close.mae || 0);
        }
      } else if (d[k] === false) {
        s.failCount++;
        if (ato) {
          s.failWithOutcome++;
          if (ato.reached4p) s.failReached4p++;
        }
      }
    }
  }

  const conditions = Object.values(stats).map(s => {
    const decisive = s.wins + s.losses;
    return {
      condition:         s.condition,
      passCount:         s.passCount,
      failCount:         s.failCount,
      traded:            s.traded,
      winRate:           decisive ? parseFloat(((s.wins / decisive) * 100).toFixed(1)) : null,
      avgPips:           s.traded ? parseFloat((s.totalPips / s.traded).toFixed(2)) : null,
      avgMfe:            s.traded ? parseFloat((s.totalMfe  / s.traded).toFixed(2)) : null,
      avgMae:            s.traded ? parseFloat((s.totalMae  / s.traded).toFixed(2)) : null,
      blockedWinnersPct: s.failWithOutcome > 0
        ? parseFloat(((s.failReached4p / s.failWithOutcome) * 100).toFixed(1)) : null,
    };
  });

  res.json({ conditions, totalChecks: checks.length, totalTrades: opens.length });
});

// ── API: GET /api/m5trend-experiment ──────────────────────────────────────────
// Project Snowball — M5Trend hard-block removal experiment.
// Segments all closed trades by m5TrendAtEntry boolean from trade_open events.
// Group A: m5trend=true (baseline)   Group B: m5trend=false (experiment)
app.get("/api/m5trend-experiment", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = await queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  const openMap = {};
  for (const o of opens) {
    if (o.data.signalId) openMap[o.data.signalId] = o.data;
  }

  const makeGroup = () => ({ wins: 0, losses: 0, be: 0, totalPips: 0, totalMFE: 0, totalMAE: 0, exitEffArr: [], n: 0 });
  const groups = { m5true: makeGroup(), m5false: makeGroup(), unknown: makeGroup() };

  for (const c of closes) {
    const od = openMap[c.data.signalId];
    let grp;
    if (!od || od.m5TrendAtEntry === undefined) grp = groups.unknown;
    else grp = od.m5TrendAtEntry ? groups.m5true : groups.m5false;

    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       grp.wins++;
    else if (oc === "LOSS") grp.losses++;
    else                    grp.be++;
    grp.n++;
    grp.totalPips += c.data.profitPips || 0;
    grp.totalMFE  += c.data.mfe        || 0;
    grp.totalMAE  += c.data.mae        || 0;
    if (c.data.exitEfficiency != null) grp.exitEffArr.push(c.data.exitEfficiency);
  }

  function summarize(g, label) {
    const decisive = g.wins + g.losses;
    return {
      label,
      trades:     g.n,
      wins:       g.wins,
      losses:     g.losses,
      breakevens: g.be,
      winRate:    decisive ? ((g.wins / decisive) * 100).toFixed(1) : "0.0",
      avgPips:    g.n ? (g.totalPips / g.n).toFixed(2) : "0.00",
      avgMFE:     g.n ? (g.totalMFE  / g.n).toFixed(2) : "0.00",
      avgMAE:     g.n ? (g.totalMAE  / g.n).toFixed(2) : "0.00",
      avgExitEff: g.exitEffArr.length
        ? (g.exitEffArr.reduce((a, b) => a + b, 0) / g.exitEffArr.length).toFixed(1)
        : null,
    };
  }

  res.json({
    groupA:    summarize(groups.m5true,  "m5trend=TRUE  (baseline)"),
    groupB:    summarize(groups.m5false, "m5trend=FALSE (experiment)"),
    preExperiment: summarize(groups.unknown, "pre-experiment (no m5TrendAtEntry tag)"),
    experimentNote: "M5Trend_HardBlock_Removed — Project Snowball. Rollback: git revert to 472ea02.",
  });
});

// ── API: GET /api/m1close-experiment ──────────────────────────────────────────
// Project Snowball — M1Close hard-block removal experiment.
// Segments all closed trades by m1CloseAtEntry boolean from trade_open events.
// Group A: m1close=true (baseline)   Group B: m1close=false (experiment)
app.get("/api/m1close-experiment", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = await queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  const openMap = {};
  for (const o of opens) {
    if (o.data.signalId) openMap[o.data.signalId] = o.data;
  }

  const makeGroup = () => ({ wins: 0, losses: 0, be: 0, totalPips: 0, totalMFE: 0, totalMAE: 0, exitEffArr: [], n: 0 });
  const groups = { m1true: makeGroup(), m1false: makeGroup(), unknown: makeGroup() };

  for (const c of closes) {
    const od = openMap[c.data.signalId];
    let grp;
    if (!od || od.m1CloseAtEntry === undefined) grp = groups.unknown;
    else grp = od.m1CloseAtEntry ? groups.m1true : groups.m1false;

    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       grp.wins++;
    else if (oc === "LOSS") grp.losses++;
    else                    grp.be++;
    grp.n++;
    grp.totalPips += c.data.profitPips || 0;
    grp.totalMFE  += c.data.mfe        || 0;
    grp.totalMAE  += c.data.mae        || 0;
    if (c.data.exitEfficiency != null) grp.exitEffArr.push(c.data.exitEfficiency);
  }

  function summarize(g, label) {
    const decisive = g.wins + g.losses;
    return {
      label,
      trades:     g.n,
      wins:       g.wins,
      losses:     g.losses,
      breakevens: g.be,
      winRate:    decisive ? ((g.wins / decisive) * 100).toFixed(1) : "0.0",
      avgPips:    g.n ? (g.totalPips / g.n).toFixed(2) : "0.00",
      avgMFE:     g.n ? (g.totalMFE  / g.n).toFixed(2) : "0.00",
      avgMAE:     g.n ? (g.totalMAE  / g.n).toFixed(2) : "0.00",
      avgExitEff: g.exitEffArr.length
        ? (g.exitEffArr.reduce((a, b) => a + b, 0) / g.exitEffArr.length).toFixed(1)
        : null,
    };
  }

  res.json({
    groupA:    summarize(groups.m1true,  "m1close=TRUE  (baseline)"),
    groupB:    summarize(groups.m1false, "m1close=FALSE (experiment)"),
    preExperiment: summarize(groups.unknown, "pre-experiment (no m1CloseAtEntry tag)"),
    experimentNote: "M1Close_HardBlock_Removed — Project Snowball Gate v3. Rollback: git revert to 261260e.",
  });
});

// ── API: GET /api/gate-experiment ─────────────────────────────────────────────
// Project Snowball — Gate v3 relaxed path tracking.
// Segments trades by entryGate: "HARD" (6 conditions) vs "RELAXED" (passScore>=6 + anchor).
app.get("/api/gate-experiment", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = await queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  const openMap = {};
  for (const o of opens) {
    if (o.data.signalId) openMap[o.data.signalId] = o.data;
  }

  const makeGroup = () => ({ wins: 0, losses: 0, be: 0, totalPips: 0, totalMFE: 0, totalMAE: 0, exitEffArr: [], n: 0 });
  const groups = { hard: makeGroup(), relaxed: makeGroup(), unknown: makeGroup() };

  for (const c of closes) {
    const od = openMap[c.data.signalId];
    let grp;
    if (!od || !od.entryGate) grp = groups.unknown;
    else grp = od.entryGate === "HARD" ? groups.hard : groups.relaxed;

    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       grp.wins++;
    else if (oc === "LOSS") grp.losses++;
    else                    grp.be++;
    grp.n++;
    grp.totalPips += c.data.profitPips || 0;
    grp.totalMFE  += c.data.mfe        || 0;
    grp.totalMAE  += c.data.mae        || 0;
    if (c.data.exitEfficiency != null) grp.exitEffArr.push(c.data.exitEfficiency);
  }

  function summarize(g, label) {
    const decisive = g.wins + g.losses;
    return {
      label,
      trades:     g.n,
      wins:       g.wins,
      losses:     g.losses,
      breakevens: g.be,
      winRate:    decisive ? ((g.wins / decisive) * 100).toFixed(1) : "0.0",
      avgPips:    g.n ? (g.totalPips / g.n).toFixed(2) : "0.00",
      avgMFE:     g.n ? (g.totalMFE  / g.n).toFixed(2) : "0.00",
      avgMAE:     g.n ? (g.totalMAE  / g.n).toFixed(2) : "0.00",
      avgExitEff: g.exitEffArr.length
        ? (g.exitEffArr.reduce((a, b) => a + b, 0) / g.exitEffArr.length).toFixed(1)
        : null,
    };
  }

  res.json({
    groupA: summarize(groups.hard,    "HARD gate  (6 conditions)"),
    groupB: summarize(groups.relaxed, "RELAXED gate (passScore≥6 + anchor)"),
    preExperiment: summarize(groups.unknown, "pre-Gate-v3 (no entryGate tag)"),
    experimentNote: "Gate_v3 — Project Snowball. RELAXED = passScore>=6 AND ema+strength+candle TRUE.",
  });
});

// ── API: GET /api/post-entry-failures ─────────────────────────────────────────
// Module 1: Per-condition failure analysis — which conditions were FALSE on losing post-entry trades.
// Module 4: Failure pattern clustering   — unique condition patterns on LOSS trades, sorted by count.
// Module 5: Session failure analysis     — post-entry failures grouped by trading session.
app.get("/api/post-entry-failures", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const pefs   = await queryEvents({ type: "post_entry_failure", date, limit: 5000 });
  const opens  = await queryEvents({ type: "trade_open",         date, limit: 10000 });
  const closes = await queryEvents({ type: "trade_close",        date, limit: 10000 });

  const openMap  = {};
  const closeMap = {};
  for (const o of opens)  if (o.data.signalId) openMap[o.data.signalId]  = o.data;
  for (const c of closes) if (c.data.signalId) closeMap[c.data.signalId] = c.data;

  // Module 1 — per-condition stats (only for post-entry failures with conditionMap)
  const COND_KEYS = ["trend","m5close","candle","ema","strength","m1trend","m1candle","m1prev","m1close"];
  const condStats = {};
  let totalMFE = 0, totalMAE = 0, totalPips = 0, enrichedCount = 0;

  for (const pef of pefs) {
    const od = openMap[pef.data.signalId];
    const cl = od ? closeMap[pef.data.signalId] : null;
    if (od?.conditionMap) {
      enrichedCount++;
      totalMAE  += pef.data.mae || 0;
      totalMFE  += cl?.mfe        || 0;
      totalPips += cl?.profitPips || 0;
      for (const k of COND_KEYS) {
        if (!od.conditionMap[k]) {   // condition was FALSE at entry
          if (!condStats[k]) condStats[k] = { condition: k, fails: 0, totalMAE: 0, totalMFE: 0, totalPips: 0 };
          condStats[k].fails++;
          condStats[k].totalMAE  += pef.data.mae || 0;
          condStats[k].totalMFE  += cl?.mfe        || 0;
          condStats[k].totalPips += cl?.profitPips || 0;
        }
      }
    }
  }

  // Module 4 — failure pattern clustering on all LOSS trade_closes that have conditionMap
  const patternMap = {};
  for (const c of closes) {
    if (classifyOutcome(c.data) !== "LOSS") continue;
    const od = openMap[c.data.signalId];
    if (!od?.conditionMap) continue;
    const pat = COND_KEYS.map(k => od.conditionMap[k] ? "T" : "F").join("");
    if (!patternMap[pat]) patternMap[pat] = { pattern: pat, count: 0, totalPips: 0, totalMFE: 0, totalMAE: 0 };
    patternMap[pat].count++;
    patternMap[pat].totalPips += c.data.profitPips || 0;
    patternMap[pat].totalMFE  += c.data.mfe        || 0;
    patternMap[pat].totalMAE  += c.data.mae        || 0;
  }

  // Module 5 — session failure stats
  const sessionStats = {};
  for (const pef of pefs) {
    const sess = pef.data.session || "UNKNOWN";
    const cl   = closeMap[pef.data.signalId];
    if (!sessionStats[sess]) sessionStats[sess] = { session: sess, fails: 0, totalMAE: 0, totalMFE: 0, totalPips: 0 };
    sessionStats[sess].fails++;
    sessionStats[sess].totalMAE  += pef.data.mae || 0;
    sessionStats[sess].totalMFE  += cl?.mfe        || 0;
    sessionStats[sess].totalPips += cl?.profitPips || 0;
  }

  res.json({
    total:        pefs.length,
    enriched:     enrichedCount,
    avgMAE:       enrichedCount ? (totalMAE  / enrichedCount).toFixed(2) : "0.00",
    avgMFE:       enrichedCount ? (totalMFE  / enrichedCount).toFixed(2) : "0.00",
    avgPips:      enrichedCount ? (totalPips / enrichedCount).toFixed(2) : "0.00",
    conditions: Object.values(condStats).map(c => ({
      condition: c.condition,
      fails:     c.fails,
      avgMAE:    c.fails ? (c.totalMAE  / c.fails).toFixed(2) : "0.00",
      avgMFE:    c.fails ? (c.totalMFE  / c.fails).toFixed(2) : "0.00",
      avgPips:   c.fails ? (c.totalPips / c.fails).toFixed(2) : "0.00",
    })).sort((a, b) => b.fails - a.fails),
    patterns: Object.values(patternMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .map(p => ({
        pattern: p.pattern,
        count:   p.count,
        avgPips: (p.totalPips / p.count).toFixed(2),
        avgMFE:  (p.totalMFE  / p.count).toFixed(2),
        avgMAE:  (p.totalMAE  / p.count).toFixed(2),
      })),
    sessions: Object.values(sessionStats).map(s => ({
      session: s.session,
      fails:   s.fails,
      avgMAE:  s.fails ? (s.totalMAE  / s.fails).toFixed(2) : "0.00",
      avgMFE:  s.fails ? (s.totalMFE  / s.fails).toFixed(2) : "0.00",
      avgPips: s.fails ? (s.totalPips / s.fails).toFixed(2) : "0.00",
    })).sort((a, b) => b.fails - a.fails),
  });
});

// ── API: GET /api/trade-quality ────────────────────────────────────────────────
// Module 2: Trade Quality Score — segments closed trades by passCount (# of 9 conditions met at entry).
// Compares win rate, avg pips, avg MFE, avg MAE across 9/9 vs 8/9 vs 7/9 etc.
app.get("/api/trade-quality", async (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = await queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = await queryEvents({ type: "trade_close", date, limit: 10000 });

  const openMap = {};
  for (const o of opens) {
    if (o.data.signalId && o.data.passCount !== undefined) openMap[o.data.signalId] = o.data;
  }

  const scores = {};
  for (const c of closes) {
    const od = openMap[c.data.signalId];
    if (!od) continue;
    const pc  = od.passCount;
    const key = `${pc}/9`;
    if (!scores[key]) scores[key] = { score: key, passCount: pc, wins: 0, losses: 0, be: 0, totalPips: 0, totalMFE: 0, totalMAE: 0, n: 0 };
    const s  = scores[key];
    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       s.wins++;
    else if (oc === "LOSS") s.losses++;
    else                    s.be++;
    s.n++;
    s.totalPips += c.data.profitPips || 0;
    s.totalMFE  += c.data.mfe        || 0;
    s.totalMAE  += c.data.mae        || 0;
  }

  res.json(Object.values(scores).sort((a, b) => b.passCount - a.passCount).map(s => {
    const decisive = s.wins + s.losses;
    return {
      score:      s.score,
      trades:     s.n,
      wins:       s.wins,
      losses:     s.losses,
      breakevens: s.be,
      winRate:    decisive ? ((s.wins / decisive) * 100).toFixed(1) : "0.0",
      avgPips:    s.n ? (s.totalPips / s.n).toFixed(2) : "0.00",
      avgMFE:     s.n ? (s.totalMFE  / s.n).toFixed(2) : "0.00",
      avgMAE:     s.n ? (s.totalMAE  / s.n).toFixed(2) : "0.00",
    };
  }));
});

// ── API: GET /api/pipeline-audit ─────────────────────────────────────────────
// Full decision pipeline waterfall: counts at every stage + recent rejections.
// Answers: WHY Checks=0, WHERE signals disappear, WHAT the terminal blocker is.
app.get("/api/pipeline-audit", async (req, res) => {
  const date  = req.query.date ? parseDate(req.query.date) : undefined;
  const lim   = 50000;

  // ── Stage counts ────────────────────────────────────────────────────────
  const detected    = await queryEvents({ type: "signal_detected",          date, limit: lim }).length;
  const cooldown    = await queryEvents({ type: "cooldown_block",            date, limit: lim }).length;
  const openTrade   = await queryEvents({ type: "open_trade_block",          date, limit: lim }).length;
  const correlation = await queryEvents({ type: "correlation_block",         date, limit: lim }).length;
  const disabled    = await queryEvents({ type: "symbol_disabled_block",     date, limit: lim }).length;
  const spread      = await queryEvents({ type: "spread_block",              date, limit: lim }).length;
  const candleRows  = await queryEvents({ type: "candle_block",              date, limit: lim });
  const candleM5    = candleRows.filter(e => e.data.reason === "m5_insufficient").length;
  const candleM1    = candleRows.filter(e => e.data.reason === "m1_insufficient").length;
  const exhaustion  = await queryEvents({ type: "exhaustion_block",          date, limit: lim }).length;
  const spreadEdge  = await queryEvents({ type: "spread_edge_block",         date, limit: lim }).length;
  const pullback    = await queryEvents({ type: "pullback_block",            date, limit: lim }).length;
  const margin      = await queryEvents({ type: "margin_block",              date, limit: lim }).length;
  const defense     = await queryEvents({ type: "defense_mode_skip",         date, limit: lim }).length;

  const buyChecks   = await queryEvents({ type: "buy_check",                 date, limit: lim }).length;
  const sellChecks  = await queryEvents({ type: "sell_check",                date, limit: lim }).length;
  const checksTotal = buyChecks;  // one per eval (same as sellChecks)

  const gateBlocks  = await queryEvents({ type: "entry_blocked_at_gate",     date, limit: lim }).length;
  const almostN     = await queryEvents({ type: "almost_trade",              date, limit: lim }).length;
  const tradeOpens  = await queryEvents({ type: "trade_open",                date, limit: lim }).length;
  const closes      = await queryEvents({ type: "trade_close",               date, limit: lim });
  const tradeCloses = closes.length;

  // Outcome taxonomy
  let wins = 0, losses = 0, breakevens = 0;
  for (const c of closes) {
    const oc = classifyOutcome(c.data);
    if (oc === "WIN")       wins++;
    else if (oc === "LOSS") losses++;
    else                    breakevens++;
  }

  // ── Waterfall — pipeline stage survival ─────────────────────────────────
  // Blocks are sequential + mutually exclusive: each signal exits on first block.
  // Survivors = detected − cumulative blocks up to that stage.
  let rem = detected;
  const waterfall = [];
  const stage = (name, blocks, note) => {
    rem -= (blocks || 0);
    waterfall.push({ stage: name, blocks: blocks || 0, survivors: rem, note: note || "" });
  };
  waterfall.push({ stage: "Signals Detected",       blocks: null, survivors: detected, note: "signal_detected events" });
  stage("After Cooldown Block",          cooldown,    "cooldown_block events");
  stage("After Open-Trade Block",        openTrade,   "open_trade_block events [NEW]");
  stage("After Correlation Block",       correlation, "correlation_block events");
  stage("After Disabled-Symbol Block",   disabled,    "symbol_disabled_block events");
  stage("After Spread Block (>2.0p)",    spread,      "spread_block events");
  stage("After M5 Candle Block",         candleM5,    "candle_block[m5_insufficient] events [NEW]");
  stage("After Exhaustion Block",        exhaustion,  "exhaustion_block events");
  stage("After SpreadEdge Block",        spreadEdge,  "spread_edge_block events");
  stage("After M1 Candle Block",         candleM1,    "candle_block[m1_insufficient] events [NEW]");
  stage("After Pullback Block (>1.5p)",  pullback,    "pullback_block events");
  stage("After Margin Block (>50%)",     margin,      "margin_block events");
  stage("After Defense-Mode Skip",       defense,     "defense_mode_skip events");

  // Expected vs actual at gate
  const expectedAtGate = rem;   // based on block arithmetic
  const actualAtGate   = checksTotal;
  const silentLeakage  = expectedAtGate - actualAtGate;

  waterfall.push({
    stage:     "Reached Gate (Checks)",
    blocks:    null,
    survivors: actualAtGate,
    note:      `buy_check events — expected ${expectedAtGate} from arithmetic; leakage=${silentLeakage}`,
  });
  waterfall.push({ stage: "Gate Pass → Trade Open",  blocks: gateBlocks, survivors: tradeOpens, note: "trade_open events" });
  waterfall.push({ stage: "Trade Closed (bot)",       blocks: null,       survivors: tradeCloses, note: "trade_close events (OANDA SL/TP not captured)" });

  // ── Dominant blocker identification ─────────────────────────────────────
  const blockMap = { cooldown, openTrade, correlation, disabled, spread, candleM5, exhaustion, spreadEdge, candleM1, pullback, margin, defense };
  const totalBlocks = Object.values(blockMap).reduce((a, b) => a + b, 0);
  const dominantBlocker = Object.entries(blockMap).sort((a, b) => b[1] - a[1])[0] || null;
  const terminalBlocker = pullback > 0 && checksTotal === 0 ? "pullback_block"
    : margin  > 0 && checksTotal === 0 ? "margin_block"
    : defense > 0 && checksTotal === 0 ? "defense_mode_skip"
    : checksTotal === 0 && silentLeakage > 0 ? "SILENT_STAGE (candle_block or open_trade_block — check leakage)"
    : checksTotal === 0 ? "UNKNOWN — all signals blocked before gate"
    : null;

  // ── Recent 20 rejected opportunities ─────────────────────────────────────
  // Union: signals that passed spread_edge but didn't trade.
  // Sources: pullback_block, margin_block, defense_mode_skip, entry_blocked_at_gate, almost_trade
  const pullbackRows  = await queryEvents({ type: "pullback_block",           date, limit: 500 });
  const marginRows    = await queryEvents({ type: "margin_block",             date, limit: 500 });
  const defenseRows   = await queryEvents({ type: "defense_mode_skip",        date, limit: 500 });
  const gateBlockRows = await queryEvents({ type: "entry_blocked_at_gate",    date, limit: 500 });
  const almostRows    = await queryEvents({ type: "almost_trade",             date, limit: 500 });

  const rejected = [
    ...pullbackRows.map(e => ({
      ts: e.ts, symbol: e.symbol, reason: "pullback_block",
      passScore: null, spread: e.data.spread || null,
      entryDistance: e.data.entryDistance || null,
      emaDistance: e.data.emaDistance || null,
      candleStrength: e.data.candleStrength || null,
      session: e.data.session || null,
      failedConditions: null, gateStatus: "PRE-GATE",
    })),
    ...marginRows.map(e => ({
      ts: e.ts, symbol: e.symbol, reason: "margin_block",
      passScore: null, spread: null,
      entryDistance: null, emaDistance: null, candleStrength: null,
      session: e.data.session || null,
      failedConditions: null, gateStatus: "PRE-GATE",
    })),
    ...defenseRows.map(e => ({
      ts: e.ts, symbol: e.symbol, reason: "defense_mode_skip",
      passScore: null, spread: null,
      entryDistance: null, emaDistance: e.data.emaDistance || null, candleStrength: null,
      session: e.data.session || null,
      failedConditions: null, gateStatus: "PRE-GATE",
    })),
    ...gateBlockRows.map(e => {
      const d = e.data;
      const m5b = d.m5Buy || {}; const m1b = d.m1Buy || {};
      const m5s = d.m5Sell || {}; const m1s = d.m1Sell || {};
      const buyScore  = [m5b.trend,m5b.close,m5b.candle,m5b.ema,m5b.strength,m1b.trend,m1b.candle,m1b.prev,m1b.close].filter(Boolean).length;
      const sellScore = [m5s.trend,m5s.close,m5s.candle,m5s.ema,m5s.strength,m1s.trend,m1s.candle,m1s.prev,m1s.close].filter(Boolean).length;
      return {
        ts: e.ts, symbol: e.symbol, reason: "gate_block",
        passScore: Math.max(buyScore, sellScore),
        spread: d.spread || null, entryDistance: d.entryDistance || null,
        emaDistance: d.emaDistance || null, candleStrength: d.candleStrength || null,
        session: d.session || null,
        failedConditions: [d.buyFirstFail, d.sellFirstFail].filter(Boolean).join(" / ") || null,
        gateStatus: "GATE_FAIL",
      };
    }),
    ...almostRows.map(e => ({
      ts: e.ts, symbol: e.symbol, reason: "almost_trade",
      passScore: e.data.passCount || null, spread: e.data.spread || null,
      entryDistance: e.data.entryDistance || null,
      emaDistance: e.data.emaDistance || null, candleStrength: e.data.candleStrength || null,
      session: e.data.session || null,
      failedConditions: (e.data.failedConditions || []).join(",") || null,
      gateStatus: "ALMOST",
    })),
  ]
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, 20);

  // ── Telemetry taxonomy ───────────────────────────────────────────────────
  const taxonomy = {
    SIGNAL_DETECTED:   { event: "signal_detected",   count: detected,    note: "every strategy() call" },
    SIGNAL_FILTERED:   { event: "signal_filtered",   count: await queryEvents({ type: "signal_filtered", date, limit: lim }).length, note: "sub-event on every block" },
    ORDER_CREATED:     { event: "N/A",               count: 0,           note: "market orders — no pending-order creation phase" },
    ORDER_CANCELLED:   { event: "N/A",               count: 0,           note: "no pending orders used" },
    ORDER_EXPIRED:     { event: "N/A",               count: 0,           note: "no pending orders used" },
    TRADE_EXECUTED:    { event: "trade_open",         count: tradeOpens,  note: "emitted on OANDA order fill" },
    TRADE_CLOSED_WIN:  { event: "trade_close[WIN]",  count: wins,        note: "classifyOutcome at query time" },
    TRADE_CLOSED_LOSS: { event: "trade_close[LOSS]", count: losses,      note: "classifyOutcome at query time" },
    TRADE_BREAKEVEN:   { event: "trade_close[BE]",   count: breakevens,  note: "classifyOutcome at query time" },
  };

  // ── Gaps / findings ──────────────────────────────────────────────────────
  const findings = [];
  if (checksTotal === 0 && detected > 0)
    findings.push({ severity: "CRITICAL", classification: "STRATEGY ISSUE", finding: `Checks=0 with ${detected} signals detected. Terminal blocker: ${terminalBlocker || "unknown"}. No signal survives all pre-filters.` });
  if (tradeOpens === 0 && checksTotal === 0)
    findings.push({ severity: "CRITICAL", classification: "STRATEGY ISSUE", finding: "Trades=0 is a direct consequence of Checks=0. If no signal reaches the gate, nothing can trade." });
  if (silentLeakage > 0)
    findings.push({ severity: "HIGH", classification: "TELEMETRY BUG", finding: `Silent stage leakage = ${silentLeakage} signals. Expected ${expectedAtGate} to reach gate based on block arithmetic but ${actualAtGate} buy_check events found. Candle-block or open_trade_block events may have been recently added — leakage will be 0 once Railway deploys this build.` });
  if (pullback > 0 && checksTotal === 0)
    findings.push({ severity: "HIGH", classification: "STRATEGY ISSUE", finding: `pullback_block is the terminal pre-gate filter with ${pullback} blocks and 0 checks. Structural contradiction: M5 momentum conditions require price movement that inherently places M1 price >1.5p from EMA9.` });
  if (totalBlocks > 0)
    findings.push({ severity: "INFO", classification: "SAFE", finding: `${totalBlocks} total pre-filter blocks confirms bot IS running and evaluating signals. Dominant blocker: ${dominantBlocker ? dominantBlocker[0] + " (" + dominantBlocker[1] + ")" : "none"}.` });
  findings.push({ severity: "INFO", classification: "TELEMETRY BUG", finding: "OANDA SL/TP exits are NOT captured in telemetry. Trades closed by OANDA SL/TP orders do not emit trade_close events — this is the largest telemetry blind spot." });
  findings.push({ severity: "INFO", classification: "SAFE", finding: "open_trade_block, candle_block events are newly added in this build. They were previously silent — will appear in future runs after Railway redeploys." });

  res.json({
    generated:      new Date().toISOString(),
    waterfall,
    blockBreakdown: { ...blockMap, total: totalBlocks },
    terminalBlocker,
    dominantBlocker: dominantBlocker ? { name: dominantBlocker[0], count: dominantBlocker[1] } : null,
    silentLeakage,
    checksTotal:    actualAtGate,
    gateBlocks,
    almostTrades:   almostN,
    tradeOpens,
    tradeCloses,
    wins, losses, breakevens,
    recentRejections: rejected,
    taxonomy,
    findings,
  });
});

// ── API: GET /api/weak-relaxed ────────────────────────────────────────────────
// Telemetry for the v39.4b WEAK RELAXED FILTER.
// Queries weak_relaxed_no_trend events (immediate log) and almost_trade_outcome
// events where failedConditions contains "weak_relaxed_no_trend" (15-min outcome).
// Returns: total rejected, by-symbol, by-session, would_have_won%, avg_move.
app.get("/api/weak-relaxed", async (req, res) => {
  const date     = req.query.date ? parseDate(req.query.date) : undefined;
  const rejected = await queryEvents({ type: "weak_relaxed_no_trend",   date, limit: 10000 });
  const outcomes = await queryEvents({ type: "almost_trade_outcome",     date, limit: 10000 })
    .filter(o => Array.isArray(o.data.failedConditions) && o.data.failedConditions.includes("weak_relaxed_no_trend"));

  // ── per-symbol aggregation
  const bySymbol = {};
  for (const r of rejected) {
    const sym = r.data.symbol || "UNKNOWN";
    if (!bySymbol[sym]) bySymbol[sym] = { symbol: sym, rejected: 0, outcomes: 0, wins: 0, losses: 0, totalMove: 0 };
    bySymbol[sym].rejected++;
  }
  for (const o of outcomes) {
    const sym = o.data.symbol || "UNKNOWN";
    if (!bySymbol[sym]) bySymbol[sym] = { symbol: sym, rejected: 0, outcomes: 0, wins: 0, losses: 0, totalMove: 0 };
    bySymbol[sym].outcomes++;
    bySymbol[sym].totalMove += Math.abs(o.data.maxMovePips || 0);
    if (o.data.directionCorrect) bySymbol[sym].wins++;
    else                          bySymbol[sym].losses++;
  }
  const symbolStats = Object.values(bySymbol).map(s => ({
    symbol:          s.symbol,
    rejected:        s.rejected,
    outcomes:        s.outcomes,
    wouldHaveWonPct: s.outcomes ? parseFloat(((s.wins   / s.outcomes) * 100).toFixed(1)) : null,
    wouldHaveLostPct:s.outcomes ? parseFloat(((s.losses / s.outcomes) * 100).toFixed(1)) : null,
    avgMove:         s.outcomes ? parseFloat((s.totalMove / s.outcomes).toFixed(2))       : null,
  })).sort((a, b) => b.rejected - a.rejected);

  // ── per-session aggregation
  const bySess = {};
  for (const r of rejected) {
    const sess = r.data.session || "UNKNOWN";
    if (!bySess[sess]) bySess[sess] = { session: sess, rejected: 0, outcomes: 0, wins: 0, totalMove: 0 };
    bySess[sess].rejected++;
  }
  for (const o of outcomes) {
    const sess = o.data.session || "UNKNOWN";
    if (!bySess[sess]) bySess[sess] = { session: sess, rejected: 0, outcomes: 0, wins: 0, totalMove: 0 };
    bySess[sess].outcomes++;
    bySess[sess].totalMove += Math.abs(o.data.maxMovePips || 0);
    if (o.data.directionCorrect) bySess[sess].wins++;
  }
  const sessionStats = Object.values(bySess).map(s => ({
    session:         s.session,
    rejected:        s.rejected,
    outcomes:        s.outcomes,
    wouldHaveWonPct: s.outcomes ? parseFloat(((s.wins / s.outcomes) * 100).toFixed(1)) : null,
    avgMove:         s.outcomes ? parseFloat((s.totalMove / s.outcomes).toFixed(2))     : null,
  })).sort((a, b) => b.rejected - a.rejected);

  // ── overall outcome stats
  let totalWins = 0, totalOutcomes = outcomes.length, totalMove = 0;
  for (const o of outcomes) {
    if (o.data.directionCorrect) totalWins++;
    totalMove += Math.abs(o.data.maxMovePips || 0);
  }

  // ── recent rejections (last 50)
  const recent = rejected.slice(-50).reverse().map(r => ({
    ts:       r.ts,
    symbol:   r.data.symbol,
    session:  r.data.session,
    side:     r.data.side,
    passScore:r.data.passScore,
    spread:   r.data.spread,
    atrPips:  r.data.atrPips,
  }));

  res.json({
    totalRejected:    rejected.length,
    totalOutcomes,
    wouldHaveWonPct:  totalOutcomes ? parseFloat(((totalWins / totalOutcomes) * 100).toFixed(1)) : null,
    wouldHaveLostPct: totalOutcomes ? parseFloat((((totalOutcomes - totalWins) / totalOutcomes) * 100).toFixed(1)) : null,
    avgMove:          totalOutcomes ? parseFloat((totalMove / totalOutcomes).toFixed(2)) : null,
    symbolStats,
    sessionStats,
    recent,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SNOWBALL LAB — /api/lab/* endpoints
// ══════════════════════════════════════════════════════════════════════════════

// ── Shared helper: build closeMap from trade_close events ─────────────────────
async function buildCloseMap(limit = 5000) {
  try {
    return (await db.all(
      "SELECT data FROM events WHERE type='trade_close' ORDER BY id DESC LIMIT ?", limit
    )).reduce((m, r) => {
      try { const d = JSON.parse(r.data); if (d.signalId) m[d.signalId] = d; } catch (_) {}
      return m;
    }, {});
  } catch (_) { return {}; }
}

// ── Shared helper: virtual performance stats for one engine ───────────────────
function computeVirtualPerf(labEvents, closeMap) {
  // labEvents = raw DB rows for lab_shadow_X
  const decisions = labEvents.map(r => {
    try { return JSON.parse(r.data); } catch (_) { return null; }
  }).filter(Boolean);

  const decided    = decisions.filter(d => d.wouldTrade !== null && d.wouldTrade !== undefined);
  const wouldTrade = decided.filter(d => d.wouldTrade === true);
  const wouldSkip  = decided.filter(d => d.wouldTrade === false);
  const abstains   = decisions.length - decided.length;

  const resolved     = wouldTrade.filter(d => closeMap[d.signalId]);
  const resolvedSkip = wouldSkip.filter(d => closeMap[d.signalId]);

  const wins   = resolved.filter(d => (closeMap[d.signalId].profitPips || 0) > 1.0);
  const losses = resolved.filter(d => (closeMap[d.signalId].profitPips || 0) < 0);
  const be     = resolved.filter(d => { const p = closeMap[d.signalId].profitPips || 0; return p >= 0 && p <= 1.0; });

  const wl = wins.length + losses.length;
  const winRate = wl > 0 ? parseFloat(((wins.length / wl) * 100).toFixed(1)) : null;

  const totalProfit = resolved.reduce((s, d) => s + (closeMap[d.signalId].profitPips || 0), 0);
  const expectancy  = resolved.length > 0 ? parseFloat((totalProfit / resolved.length).toFixed(2)) : null;

  const posSum = wins.reduce((s, d) => s + (closeMap[d.signalId].profitPips || 0), 0);
  const negSum = Math.abs(losses.reduce((s, d) => s + (closeMap[d.signalId].profitPips || 0), 0));
  const profitFactor = negSum > 0 ? parseFloat((posSum / negSum).toFixed(2)) : null;

  const avgMFE = resolved.length > 0
    ? parseFloat((resolved.reduce((s, d) => s + (closeMap[d.signalId].peak || 0), 0) / resolved.length).toFixed(2)) : null;
  const avgMAE = resolved.length > 0
    ? parseFloat((resolved.reduce((s, d) => s + Math.abs(closeMap[d.signalId].mae || closeMap[d.signalId].maxAdverseExcursion || 0), 0) / resolved.length).toFixed(2)) : null;

  const avoidedLosses = resolvedSkip.filter(d => (closeMap[d.signalId].profitPips || 0) < 0).length;
  const avoidedWins   = resolvedSkip.filter(d => (closeMap[d.signalId].profitPips || 0) > 1.0).length;

  return {
    totalDecisions:  decided.length,
    abstains,
    wouldTradeCount: wouldTrade.length,
    wouldSkipCount:  wouldSkip.length,
    resolved:        resolved.length,
    wins:            wins.length,
    losses:          losses.length,
    breakevens:      be.length,
    winRate,
    expectancy,
    profitFactor,
    avgMFE,
    avgMAE,
    avoidedLosses,
    avoidedWins,
    resolvedSkip:    resolvedSkip.length,
  };
}

// ── GET /api/lab/overview ─────────────────────────────────────────────────────
app.get("/api/lab/overview", async (req, res) => {
  const limit = 5000;
  let rowsA = [], rowsB = [], rowsC = [], rowsComp = [];
  try { rowsA    = await db.all("SELECT data FROM events WHERE type='lab_shadow_a'    ORDER BY id DESC LIMIT ?", limit); } catch (_) {}
  try { rowsB    = await db.all("SELECT data FROM events WHERE type='lab_shadow_b'    ORDER BY id DESC LIMIT ?", limit); } catch (_) {}
  try { rowsC    = await db.all("SELECT data FROM events WHERE type='lab_shadow_c'    ORDER BY id DESC LIMIT ?", limit); } catch (_) {}
  try { rowsComp = await db.all("SELECT data FROM events WHERE type='lab_comparison'  ORDER BY id DESC LIMIT ?", limit); } catch (_) {}

  const parseAll = rows => rows.map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);
  const dA = parseAll(rowsA);
  const dB = parseAll(rowsB);
  const dC = parseAll(rowsC);
  const dComp = parseAll(rowsComp);

  // Agreement rates
  const compDecided = dComp.filter(d => d.decidedEngines > 0);
  const avgAgreement = compDecided.length > 0
    ? parseFloat((compDecided.reduce((s, d) => s + (d.agreementPct || 0), 0) / compDecided.length).toFixed(1)) : null;
  const cautionFlags = dComp.filter(d => d.cautionFlag === true).length;

  // Engine A avg score
  const aScored = dA.filter(d => d.score != null);
  const avgScoreA = aScored.length > 0 ? parseFloat((aScored.reduce((s, d) => s + d.score, 0) / aScored.length).toFixed(1)) : null;

  // Engine B state breakdown
  const bStateCounts = {};
  for (const d of dB) { const s = d.marketState || "UNKNOWN"; bStateCounts[s] = (bStateCounts[s] || 0) + 1; }

  // Engine C abstain rate
  const cAbstains = dC.filter(d => d.confidence === "NONE").length;
  const cAbstainRate = dC.length > 0 ? parseFloat(((cAbstains / dC.length) * 100).toFixed(1)) : null;

  // Last processed timestamp
  let lastTs = null;
  try {
    const row = await db.get("SELECT ts FROM events WHERE type='lab_comparison' ORDER BY id DESC LIMIT 1");
    if (row) lastTs = row.ts;
  } catch (_) {}

  res.json({
    generated:       new Date().toISOString(),
    lastProcessedTs: lastTs,
    totalProcessed:  dComp.length,
    engineA:  { decisions: dA.length, wouldTrade: dA.filter(d => d.wouldTrade).length, avgScore: avgScoreA },
    engineB:  { decisions: dB.length, wouldTrade: dB.filter(d => d.wouldTrade).length, stateBreakdown: bStateCounts },
    engineC:  { decisions: dC.length, wouldTrade: dC.filter(d => d.wouldTrade === true).length, abstains: cAbstains, abstainRate: cAbstainRate },
    comparison: { total: dComp.length, avgAgreement, cautionFlags, cautionFlagRate: dComp.length > 0 ? parseFloat(((cautionFlags / dComp.length) * 100).toFixed(1)) : null },
  });
});

// ── GET /api/lab/shadow-a ─────────────────────────────────────────────────────
app.get("/api/lab/shadow-a", async (req, res) => {
  let rows = [];
  try { rows = await db.all("SELECT data FROM events WHERE type='lab_shadow_a' ORDER BY id DESC LIMIT 1000"); } catch (_) {}
  const decisions = rows.map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

  // Score distribution buckets: 0-20, 20-40, 40-60, 60-80, 80-100
  const dist = { "0-20": 0, "20-40": 0, "40-60": 0, "60-80": 0, "80-100": 0 };
  for (const d of decisions) {
    const s = d.score || 0;
    if      (s < 20)  dist["0-20"]++;
    else if (s < 40)  dist["20-40"]++;
    else if (s < 60)  dist["40-60"]++;
    else if (s < 80)  dist["60-80"]++;
    else              dist["80-100"]++;
  }

  // Confidence breakdown
  const conf = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const d of decisions) { if (conf[d.confidence] !== undefined) conf[d.confidence]++; }

  // By symbol
  const bySym = {};
  for (const d of decisions) {
    const sym = d.symbol || "?";
    if (!bySym[sym]) bySym[sym] = { symbol: sym, count: 0, scoreSum: 0, wouldTrade: 0 };
    bySym[sym].count++;
    bySym[sym].scoreSum += d.score || 0;
    if (d.wouldTrade) bySym[sym].wouldTrade++;
  }

  // By session
  const bySess = {};
  for (const d of decisions) {
    const sess = d.session || "?";
    if (!bySess[sess]) bySess[sess] = { session: sess, count: 0, scoreSum: 0, wouldTrade: 0 };
    bySess[sess].count++;
    bySess[sess].scoreSum += d.score || 0;
    if (d.wouldTrade) bySess[sess].wouldTrade++;
  }

  const toAvgRows = (obj, key) => Object.values(obj).map(s => ({
    ...s, avgScore: s.count > 0 ? parseFloat((s.scoreSum / s.count).toFixed(1)) : null,
    wouldTradePct: s.count > 0 ? parseFloat(((s.wouldTrade / s.count) * 100).toFixed(1)) : null,
  })).sort((a, b) => b.count - a.count);

  const wouldTradeCount = decisions.filter(d => d.wouldTrade).length;
  const avgScore = decisions.length > 0 ? parseFloat((decisions.reduce((s, d) => s + (d.score || 0), 0) / decisions.length).toFixed(1)) : null;

  res.json({
    generated:      new Date().toISOString(),
    totalDecisions: decisions.length,
    wouldTradeCount,
    wouldSkipCount: decisions.filter(d => !d.wouldTrade).length,
    wouldTradePct:  decisions.length > 0 ? parseFloat(((wouldTradeCount / decisions.length) * 100).toFixed(1)) : null,
    avgScore,
    scoreDistribution: dist,
    confidenceBreakdown: conf,
    bySymbol:  toAvgRows(bySym,  "symbol"),
    bySession: toAvgRows(bySess, "session"),
    recent: decisions.slice(0, 50).map(d => ({
      ts: d.sourceTs, symbol: d.symbol, session: d.session, side: d.side,
      score: d.score, confidence: d.confidence, wouldTrade: d.wouldTrade, reason: d.reason,
      entryGate: d.entryGate, spread: d.spread, atrPips: d.atrPips, emaDistance: d.emaDistance,
    })),
  });
});

// ── GET /api/lab/shadow-b ─────────────────────────────────────────────────────
app.get("/api/lab/shadow-b", async (req, res) => {
  let rows = [];
  try { rows = await db.all("SELECT data FROM events WHERE type='lab_shadow_b' ORDER BY id DESC LIMIT 1000"); } catch (_) {}
  const decisions = rows.map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

  const states = {};
  for (const d of decisions) {
    const s = d.marketState || "UNKNOWN";
    if (!states[s]) states[s] = { state: s, count: 0, wouldTrade: 0 };
    states[s].count++;
    if (d.wouldTrade) states[s].wouldTrade++;
  }

  const bySession = {};
  for (const d of decisions) {
    const sess = d.session || "?";
    if (!bySession[sess]) bySession[sess] = {};
    bySession[sess][d.marketState || "UNKNOWN"] = (bySession[sess][d.marketState || "UNKNOWN"] || 0) + 1;
  }

  const wouldTradeCount = decisions.filter(d => d.wouldTrade).length;

  res.json({
    generated:      new Date().toISOString(),
    totalDecisions: decisions.length,
    wouldTradeCount,
    wouldSkipCount: decisions.filter(d => !d.wouldTrade).length,
    wouldTradePct:  decisions.length > 0 ? parseFloat(((wouldTradeCount / decisions.length) * 100).toFixed(1)) : null,
    stateBreakdown: Object.values(states).sort((a, b) => b.count - a.count),
    bySession,
    recent: decisions.slice(0, 50).map(d => ({
      ts: d.sourceTs, symbol: d.symbol, session: d.session, side: d.side,
      marketState: d.marketState, confidence: d.confidence, wouldTrade: d.wouldTrade, reason: d.reason,
      atrPips: d.atrPips, emaDistance: d.emaDistance, candleStrength: d.candleStrength, spread: d.spread,
    })),
  });
});

// ── GET /api/lab/shadow-c ─────────────────────────────────────────────────────
app.get("/api/lab/shadow-c", async (req, res) => {
  let rows = [];
  try { rows = await db.all("SELECT data FROM events WHERE type='lab_shadow_c' ORDER BY id DESC LIMIT 1000"); } catch (_) {}
  const decisions = rows.map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

  const confBreak = { HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 };
  for (const d of decisions) { const c = d.confidence || "NONE"; if (confBreak[c] !== undefined) confBreak[c]++; }

  const decidedC = decisions.filter(d => d.confidence !== "NONE");
  const wouldTradeCount = decisions.filter(d => d.wouldTrade === true).length;

  const avgWr = decidedC.length > 0
    ? parseFloat((decidedC.reduce((s, d) => s + (d.historicalWinrate || 0), 0) / decidedC.length).toFixed(1)) : null;
  const avgExp = decidedC.length > 0
    ? parseFloat((decidedC.reduce((s, d) => s + (d.historicalExpectancy || 0), 0) / decidedC.length).toFixed(2)) : null;

  res.json({
    generated:        new Date().toISOString(),
    totalDecisions:   decisions.length,
    decidedCount:     decidedC.length,
    abstainCount:     confBreak.NONE,
    abstainRate:      decisions.length > 0 ? parseFloat(((confBreak.NONE / decisions.length) * 100).toFixed(1)) : null,
    wouldTradeCount,
    wouldSkipCount:   decisions.filter(d => d.wouldTrade === false).length,
    avgHistoricalWinrate: avgWr,
    avgHistoricalExpectancy: avgExp,
    confidenceBreakdown: confBreak,
    recent: decisions.slice(0, 50).map(d => ({
      ts: d.sourceTs, symbol: d.symbol, session: d.session, side: d.side,
      wouldTrade: d.wouldTrade, confidence: d.confidence, reason: d.reason,
      historicalWinrate: d.historicalWinrate, historicalExpectancy: d.historicalExpectancy,
      kNeighbours: d.kNeighbours, avgSimilarity: d.avgSimilarity,
      profitFactor: d.profitFactor, datasetSize: d.datasetSize,
    })),
  });
});

// ── GET /api/lab/comparison ───────────────────────────────────────────────────
app.get("/api/lab/comparison", async (req, res) => {
  let rows = [];
  try { rows = await db.all("SELECT data FROM events WHERE type='lab_comparison' ORDER BY id DESC LIMIT 1000"); } catch (_) {}
  const comps = rows.map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

  const withDecisions = comps.filter(c => c.decidedEngines > 0);
  const allAgreeCount = comps.filter(c => c.allAgree).length;
  const cautionCount  = comps.filter(c => c.cautionFlag).length;
  const avgAgreement  = withDecisions.length > 0
    ? parseFloat((withDecisions.reduce((s, c) => s + (c.agreementPct || 0), 0) / withDecisions.length).toFixed(1)) : null;

  // Engine-level agreement with live
  const aAgree = comps.filter(c => c.engineADecision === true).length;
  const bAgree = comps.filter(c => c.engineBDecision === true).length;
  const cAgree = comps.filter(c => c.engineCDecision === true && c.engineCDecision !== null).length;
  const cDecided = comps.filter(c => c.engineCDecision !== null).length;

  // By symbol
  const bySym = {};
  for (const c of comps) {
    const sym = c.symbol || "?";
    if (!bySym[sym]) bySym[sym] = { symbol: sym, count: 0, cautionCount: 0, agreeSum: 0 };
    bySym[sym].count++;
    if (c.cautionFlag) bySym[sym].cautionCount++;
    if (c.agreementPct != null) bySym[sym].agreeSum += c.agreementPct;
  }

  res.json({
    generated:       new Date().toISOString(),
    totalComparisons: comps.length,
    avgAgreementPct: avgAgreement,
    allAgreeCount,
    allAgreePct: comps.length > 0 ? parseFloat(((allAgreeCount / comps.length) * 100).toFixed(1)) : null,
    cautionFlagCount: cautionCount,
    cautionFlagPct: comps.length > 0 ? parseFloat(((cautionCount / comps.length) * 100).toFixed(1)) : null,
    engineAgreement: {
      A: { agree: aAgree, pct: comps.length > 0 ? parseFloat(((aAgree / comps.length) * 100).toFixed(1)) : null },
      B: { agree: bAgree, pct: comps.length > 0 ? parseFloat(((bAgree / comps.length) * 100).toFixed(1)) : null },
      C: { agree: cAgree, decided: cDecided, pct: cDecided > 0 ? parseFloat(((cAgree / cDecided) * 100).toFixed(1)) : null },
    },
    bySymbol: Object.values(bySym).map(s => ({
      symbol: s.symbol, count: s.count, cautionCount: s.cautionCount,
      cautionRate: s.count > 0 ? parseFloat(((s.cautionCount / s.count) * 100).toFixed(1)) : null,
      avgAgreement: s.count > 0 ? parseFloat((s.agreeSum / s.count).toFixed(1)) : null,
    })).sort((a, b) => b.count - a.count),
    recent: comps.slice(0, 50).map(c => ({
      ts: c.sourceTs, symbol: c.symbol, session: c.session, side: c.side,
      engineADecision: c.engineADecision, engineAScore: c.engineAScore,
      engineBDecision: c.engineBDecision, engineBState: c.engineBState,
      engineCDecision: c.engineCDecision, engineCWinrate: c.engineCWinrate,
      engineDDecision: c.engineDDecision, engineDVoteScore: c.engineDVoteScore,
      agreementPct: c.agreementPct, allAgree: c.allAgree, cautionFlag: c.cautionFlag,
    })),
  });
});

// ── GET /api/lab/virtual-performance ─────────────────────────────────────────
app.get("/api/lab/virtual-performance", async (req, res) => {
  let rawA = [], rawB = [], rawC = [], rawD = [];
  try { rawA = await db.all("SELECT data FROM events WHERE type='lab_shadow_a' ORDER BY id DESC LIMIT 5000"); } catch (_) {}
  try { rawB = await db.all("SELECT data FROM events WHERE type='lab_shadow_b' ORDER BY id DESC LIMIT 5000"); } catch (_) {}
  try { rawC = await db.all("SELECT data FROM events WHERE type='lab_shadow_c' ORDER BY id DESC LIMIT 5000"); } catch (_) {}
  try { rawD = await db.all("SELECT data FROM events WHERE type='lab_shadow_d' ORDER BY id DESC LIMIT 5000"); } catch (_) {}

  const closeMap = await buildCloseMap(10000);

  // Live bot stats (from trade_close events directly)
  const allCloses = Object.values(closeMap);
  const liveWins   = allCloses.filter(d => (d.profitPips || 0) > 1.0).length;
  const liveLosses = allCloses.filter(d => (d.profitPips || 0) < 0).length;
  const liveBE     = allCloses.filter(d => { const p = d.profitPips || 0; return p >= 0 && p <= 1.0; }).length;
  const liveWL     = liveWins + liveLosses;
  const liveWR     = liveWL > 0 ? parseFloat(((liveWins / liveWL) * 100).toFixed(1)) : null;
  const liveTotalProfit = allCloses.reduce((s, d) => s + (d.profitPips || 0), 0);
  const liveExp    = allCloses.length > 0 ? parseFloat((liveTotalProfit / allCloses.length).toFixed(2)) : null;
  const livePosSum = allCloses.filter(d => (d.profitPips || 0) > 0).reduce((s, d) => s + d.profitPips, 0);
  const liveNegSum = Math.abs(allCloses.filter(d => (d.profitPips || 0) < 0).reduce((s, d) => s + d.profitPips, 0));
  const livePF     = liveNegSum > 0 ? parseFloat((livePosSum / liveNegSum).toFixed(2)) : null;
  const liveMFE    = allCloses.length > 0 ? parseFloat((allCloses.reduce((s, d) => s + (d.peak || 0), 0) / allCloses.length).toFixed(2)) : null;

  res.json({
    generated:  new Date().toISOString(),
    live: {
      label: "LIVE BOT", trades: allCloses.length, wins: liveWins, losses: liveLosses, breakevens: liveBE,
      winRate: liveWR, expectancy: liveExp, profitFactor: livePF, avgMFE: liveMFE,
    },
    engineA: { label: "Engine A — Quality Score",  ...computeVirtualPerf(rawA, closeMap) },
    engineB: { label: "Engine B — Market Context", ...computeVirtualPerf(rawB, closeMap) },
    engineC: { label: "Engine C — KNN Memory",     ...computeVirtualPerf(rawC, closeMap) },
    engineD: { label: "Engine D — Meta Engine",    ...computeVirtualPerf(rawD, closeMap) },
  });
});

// ── GET /api/lab/engine-ranking ───────────────────────────────────────────────
app.get("/api/lab/engine-ranking", async (req, res) => {
  let rawA = [], rawB = [], rawC = [], rawD = [];
  try { rawA = await db.all("SELECT data FROM events WHERE type='lab_shadow_a' ORDER BY id DESC LIMIT 5000"); } catch (_) {}
  try { rawB = await db.all("SELECT data FROM events WHERE type='lab_shadow_b' ORDER BY id DESC LIMIT 5000"); } catch (_) {}
  try { rawC = await db.all("SELECT data FROM events WHERE type='lab_shadow_c' ORDER BY id DESC LIMIT 5000"); } catch (_) {}
  try { rawD = await db.all("SELECT data FROM events WHERE type='lab_shadow_d' ORDER BY id DESC LIMIT 5000"); } catch (_) {}

  const closeMap = await buildCloseMap(10000);

  const perfA = computeVirtualPerf(rawA, closeMap);
  const perfB = computeVirtualPerf(rawB, closeMap);
  const perfC = computeVirtualPerf(rawC, closeMap);
  const perfD = computeVirtualPerf(rawD, closeMap);

  // Live bot reference
  const allCloses = Object.values(closeMap);
  const liveWins   = allCloses.filter(d => (d.profitPips || 0) > 1.0).length;
  const liveLosses = allCloses.filter(d => (d.profitPips || 0) < 0).length;
  const liveWL     = liveWins + liveLosses;
  const liveWR     = liveWL > 0 ? parseFloat(((liveWins / liveWL) * 100).toFixed(1)) : null;
  const liveExp    = allCloses.length > 0 ? parseFloat((allCloses.reduce((s, d) => s + (d.profitPips || 0), 0) / allCloses.length).toFixed(2)) : null;

  // Rank engines by expectancy (most reliable indicator)
  const engines = [
    { id: "ENGINE_A", label: "Engine A — Quality Score",  ...perfA },
    { id: "ENGINE_B", label: "Engine B — Market Context", ...perfB },
    { id: "ENGINE_C", label: "Engine C — KNN Memory",     ...perfC },
    { id: "ENGINE_D", label: "Engine D — Meta Engine",    ...perfD },
  ].sort((a, b) => {
    // Sort by expectancy (null last), then winRate
    if (a.expectancy == null && b.expectancy == null) return 0;
    if (a.expectancy == null) return 1;
    if (b.expectancy == null) return -1;
    return b.expectancy - a.expectancy;
  });

  // Add rank
  engines.forEach((e, i) => { e.rank = i + 1; });

  res.json({
    generated:   new Date().toISOString(),
    note:        "Ranking based on virtual expectancy. Minimum 10 resolved trades required for reliable ranking. Engine C and D abstain when data is insufficient — lower totalDecisions is expected for both.",
    liveBot:     { label: "LIVE BOT (reference)", winRate: liveWR, expectancy: liveExp, trades: allCloses.length },
    engines,
    dataQualityNote: allCloses.length < 50
      ? "INSUFFICIENT_DATA — fewer than 50 closed trades. Rankings are unreliable. Collect more data before interpreting results."
      : allCloses.length < 200 ? "LOW_DATA — fewer than 200 closed trades. Treat rankings as indicative only." : "ADEQUATE",
  });
});

// ── GET /api/shadow/status ────────────────────────────────────────────────────
app.get("/api/shadow/status", async (req, res) => {
  const mem  = await getShadowMemoryStats();
  const dbSt = await getDbStats();
  res.json({
    generated:     new Date().toISOString(),
    shadowMode:    mem.mode,
    gateActive:    mem.mode === "GATE",
    dataCollection: {
      closedTrades:    mem.closedTrades,
      target:          mem.dataCollectionTarget,
      progressPct:     mem.dataCollectionPct,
      ready:           mem.dataCollectionReady,
      note:            mem.dataCollectionReady
        ? "Dataset mature — consider switching to GATE mode via POST /api/shadow/mode"
        : `Collecting data: ${mem.closedTrades}/${mem.dataCollectionTarget} closed trades (${mem.dataCollectionPct}%)`,
    },
    memoryCounts: mem.counts,
    gateStats: {
      evaluations: mem.gateEvals,
      blocks:      mem.gateBlocks,
      blockRate:   mem.gateEvals > 0 ? parseFloat(((mem.gateBlocks / mem.gateEvals) * 100).toFixed(1)) : null,
    },
    database: {
      path:             dbSt.path,
      dataDirExplicit:  DATA_DIR_EXPLICIT,
      persistent:       DATA_DIR_EXPLICIT,
      totalEvents:      dbSt.total,
      oldest:           dbSt.oldest,
      newest:           dbSt.newest,
      persistenceNote:  DATA_DIR_EXPLICIT
        ? "✓ DATA_DIR explicitly set — data persists across Railway redeploys"
        : "⚠ DATA_DIR not set — data is EPHEMERAL on Railway. Add Volume at /data and set DATA_DIR=/data",
    },
    failSafe: "active — shadow errors always allow live execution",
  });
});

// ── POST /api/shadow/mode ─────────────────────────────────────────────────────
app.post("/api/shadow/mode", express.json(), async (req, res) => {
  const { mode } = req.body || {};
  if (!mode) return res.status(400).json({ error: "mode required: OBSERVE or GATE" });
  try {
    setShadowMode(mode);
    res.json({ ok: true, mode: getShadowMode(), message: `Shadow mode switched to ${getShadowMode()}` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/system/backup ───────────────────────────────────────────────────
app.post("/api/system/backup", async (_req, res) => {
  const result = await backupDatabase();
  if (result.ok) res.json({ ok: true, path: result.path });
  else           res.status(500).json({ ok: false, error: result.error });
});

// ── GET /api/lab/unified-report ───────────────────────────────────────────────
app.get("/api/lab/unified-report", async (req, res) => {
  const limit = 2000;
  const parse = rows => rows.map(r => { try { return JSON.parse(r.data); } catch (_) { return null; } }).filter(Boolean);

  let dA = [], dB = [], dC = [], dD = [], dComp = [], dGate = [];
  try { dA    = parse(await db.all("SELECT data FROM events WHERE type='lab_shadow_a'    ORDER BY id DESC LIMIT ?", limit)); } catch (_) {}
  try { dB    = parse(await db.all("SELECT data FROM events WHERE type='lab_shadow_b'    ORDER BY id DESC LIMIT ?", limit)); } catch (_) {}
  try { dC    = parse(await db.all("SELECT data FROM events WHERE type='lab_shadow_c'    ORDER BY id DESC LIMIT ?", limit)); } catch (_) {}
  try { dD    = parse(await db.all("SELECT data FROM events WHERE type='lab_shadow_d'    ORDER BY id DESC LIMIT ?", limit)); } catch (_) {}
  try { dComp = parse(await db.all("SELECT data FROM events WHERE type='lab_comparison'  ORDER BY id DESC LIMIT ?", limit)); } catch (_) {}
  try { dGate = parse(await db.all("SELECT data FROM events WHERE type='shadow_gate_eval' ORDER BY id DESC LIMIT 500")); } catch (_) {}

  const closeMap = await buildCloseMap(5000);
  const allCloses = Object.values(closeMap);

  const mem = await getShadowMemoryStats();

  const snapshot = (arr) => {
    if (!arr.length) return null;
    const trade = arr.filter(d => d.wouldTrade === true).length;
    const skip  = arr.filter(d => d.wouldTrade === false).length;
    const abs   = arr.filter(d => d.wouldTrade == null).length;
    return { n: arr.length, trade, skip, abstain: abs,
             tradePct: arr.length ? parseFloat(((trade/arr.length)*100).toFixed(1)) : null };
  };

  res.json({
    generated:      new Date().toISOString(),
    shadowMode:     mem.mode,
    dataCollection: { closedTrades: mem.closedTrades, target: mem.dataCollectionTarget, pct: mem.dataCollectionPct },
    engineA:   snapshot(dA),
    engineB:   snapshot(dB),
    engineC:   snapshot(dC),
    engineD:   snapshot(dD),
    comparison: {
      n:            dComp.length,
      allAgree:     dComp.filter(d => d.allAgree).length,
      cautionFlags: dComp.filter(d => d.cautionFlag).length,
    },
    gate: {
      evals:  dGate.length,
      blocks: dGate.filter(d => d.blocked).length,
      recent: dGate.slice(0, 10).map(d => ({
        symbol: d.symbol, session: d.session, side: d.side,
        mode: d.mode, engineDDecision: d.engineDDecision,
        engineDConfidence: d.engineDConfidence, blocked: d.blocked,
      })),
    },
    liveBot: {
      closedTrades: allCloses.length,
      wins:   allCloses.filter(d => (d.profitPips||0) >  1.0).length,
      losses: allCloses.filter(d => (d.profitPips||0) <  0).length,
      expectancy: allCloses.length > 0
        ? parseFloat((allCloses.reduce((s,d) => s+(d.profitPips||0), 0) / allCloses.length).toFixed(2)) : null,
    },
  });
});

// ── GET /api/shadowm/status ───────────────────────────────────────────────────
app.get("/api/shadowm/status", async (req, res) => {
  try {
    const stats = await getShadowMStats();
    res.json({ ok: true, module: "Shadow M", mode: "OBSERVE", stats });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/shadowm/trades ───────────────────────────────────────────────────
app.get("/api/shadowm/trades", async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || "100", 10), 500);
    const offset = parseInt(req.query.offset || "0", 10);
    const trades = await getShadowMTrades({ limit, offset });
    res.json({ ok: true, trades, total: trades.length });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/shadowm/active ───────────────────────────────────────────────────
app.get("/api/shadowm/active", async (req, res) => {
  try {
    const trades = await getShadowMTrades({ limit: 50, openOnly: true });
    res.json({ ok: true, active: trades.length, trades });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/shadowm/dashboard ────────────────────────────────────────────────
// Used by the Exit Lab UI — stats + recent closed trades in one call.
app.get("/api/shadowm/dashboard", async (req, res) => {
  try {
    const stats  = await getShadowMStats();
    const trades = await getShadowMTrades({ limit: 50 });
    res.json({ ok: true, stats, trades });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── GET /api/lab/shadow-d ─────────────────────────────────────────────────────
app.get("/api/lab/shadow-d", async (req, res) => {
  let rows = [];
  try {
    rows = await db.all("SELECT ts,data FROM events WHERE type='lab_shadow_d' ORDER BY id DESC LIMIT 2000");
  } catch (_) {}

  const all = rows.map(r => {
    try { const d = JSON.parse(r.data); d._ts = r.ts; return d; } catch (_) { return null; }
  }).filter(Boolean);

  const abstains       = all.filter(d => d.wouldTrade === null || d.wouldTrade === undefined);
  const decided        = all.filter(d => d.wouldTrade !== null  && d.wouldTrade !== undefined);
  const wouldTrade     = decided.filter(d => d.wouldTrade === true);
  const wouldSkip      = decided.filter(d => d.wouldTrade === false);

  const totalDecisions = all.length;
  const abstainCount   = abstains.length;
  const decidedCount   = decided.length;
  const wouldTradeCount = wouldTrade.length;
  const wouldSkipCount  = wouldSkip.length;
  const abstainRate    = totalDecisions > 0 ? parseFloat(((abstainCount / totalDecisions) * 100).toFixed(1)) : null;

  const withScore  = all.filter(d => d.metaVoteScore != null);
  const avgVoteScore = withScore.length > 0
    ? parseFloat((withScore.reduce((s, d) => s + d.metaVoteScore, 0) / withScore.length).toFixed(3)) : null;

  const withW    = all.filter(d => d.weightA != null);
  const avgWeightA = withW.length > 0 ? parseFloat((withW.reduce((s, d) => s + d.weightA, 0) / withW.length).toFixed(3)) : null;
  const avgWeightB = withW.length > 0 ? parseFloat((withW.reduce((s, d) => s + d.weightB, 0) / withW.length).toFixed(3)) : null;
  const avgWeightC = withW.length > 0 ? parseFloat((withW.reduce((s, d) => s + d.weightC, 0) / withW.length).toFixed(3)) : null;

  const confCounts = {};
  for (const d of all) { const c = d.confidence || "NONE"; confCounts[c] = (confCounts[c] || 0) + 1; }

  const regimeCounts = {};
  for (const d of all) { const r = d.regime || "UNKNOWN"; regimeCounts[r] = (regimeCounts[r] || 0) + 1; }

  const symMap = {};
  for (const d of all) {
    const s = d.symbol || "UNKNOWN";
    if (!symMap[s]) symMap[s] = { symbol: s, count: 0, trade: 0, skip: 0, abstain: 0, voteSum: 0, voteN: 0 };
    symMap[s].count++;
    if (d.wouldTrade === true)       symMap[s].trade++;
    else if (d.wouldTrade === false) symMap[s].skip++;
    else                             symMap[s].abstain++;
    if (d.metaVoteScore != null)    { symMap[s].voteSum += d.metaVoteScore; symMap[s].voteN++; }
  }
  const bySymbol = Object.values(symMap).map(s => ({
    ...s,
    avgVoteScore: s.voteN > 0 ? parseFloat((s.voteSum / s.voteN).toFixed(3)) : null,
  })).sort((a, b) => b.count - a.count);

  res.json({
    generated: new Date().toISOString(),
    totalDecisions, abstainCount, decidedCount, wouldTradeCount, wouldSkipCount,
    abstainRate, avgVoteScore, avgWeightA, avgWeightB, avgWeightC,
    confCounts, regimeCounts, bySymbol,
    engineStatus: "live — weights learned per (symbol, session); cold-start = equal 1/3",
    recent: all.slice(0, 20).map(d => ({
      ts:            d._ts,      symbol:        d.symbol,
      session:       d.session,  side:          d.side,
      wouldTrade:    d.wouldTrade, confidence:  d.confidence,
      metaVoteScore: d.metaVoteScore, weightA:  d.weightA,
      weightB:       d.weightB,  weightC:       d.weightC,
      regime:        d.regime,   decidedEngines: d.decidedEngines,
      agreeCount:    d.agreeCount, reason:      d.reason,
    })),
  });
});

// ── root → dashboard ──────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[SERVER] API on :${PORT}  DB: ${DB_PATH}`);
  startBot();
  shadowLab.start();
  shadowM.start().catch(err => console.error("[SERVER] shadowM.start:", err.message));
});
