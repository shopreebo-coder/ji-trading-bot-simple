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
const { db, emitter, getLastId } = require("./index");

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

function queryEvents({ type, symbol, date, limit = 500 } = {}) {
  let sql    = "SELECT id,ts,bot_id,type,symbol,data FROM events WHERE 1=1";
  const args = [];
  if (type)   { sql += " AND type=?";            args.push(type); }
  if (symbol) { sql += " AND symbol=?";          args.push(symbol); }
  if (date)   { sql += " AND substr(ts,1,10)=?"; args.push(date); }
  sql += " ORDER BY id DESC LIMIT ?";
  args.push(limit);
  return db.prepare(sql).all(...args).map(r => ({ ...r, data: JSON.parse(r.data) }));
}

// ── API: GET /api/events ──────────────────────────────────────────────────────
app.get("/api/events", (req, res) => {
  const rows = queryEvents({
    type:   req.query.type,
    symbol: req.query.symbol,
    date:   req.query.date ? parseDate(req.query.date) : undefined,
    limit:  parseInt(req.query.limit || "500"),
  });
  res.json(rows);
});

// ── API: GET /api/trades ──────────────────────────────────────────────────────
app.get("/api/trades", (req, res) => {
  const date   = req.query.date   ? parseDate(req.query.date) : undefined;
  const symbol = req.query.symbol;

  const opens  = queryEvents({ type: "trade_open",  symbol, date, limit: 1000 });
  const closes = queryEvents({ type: "trade_close", symbol, date, limit: 1000 });

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
app.get("/api/today", (req, res) => {
  const date   = parseDate("today");
  const closes = queryEvents({ type: "trade_close", date, limit: 1000 });

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
  const blocks   = queryEvents({ date, limit: 1000 })
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
app.get("/api/stats", (req, res) => {
  const symbol = req.query.symbol;
  const date   = req.query.date ? parseDate(req.query.date) : undefined;

  const closes = queryEvents({ type: "trade_close", symbol, date, limit: 5000 });
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

  const checks = queryEvents({ type: "buy_check",  symbol, date, limit: 5000 })
    .concat(queryEvents({ type: "sell_check", symbol, date, limit: 5000 }));

  const allBlocks = queryEvents({ date, limit: 10000 })
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
app.get("/api/symbols", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const closes = queryEvents({ type: "trade_close", date, limit: 10000 });

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
app.get("/api/live", (req, res) => {
  res.json({
    botStatus:    live.botStatus,
    dailyTrades:  live.dailyTrades,
    openTrades:   Object.values(live.openTrades),
    recentBlocks: live.recentBlocks,
  });
});

// ── API: GET /api/export ──────────────────────────────────────────────────────
app.get("/api/export", (req, res) => {
  const date   = parseDate(req.query.date || "today");
  const format = req.query.format || "json";
  const rows   = queryEvents({ date, limit: 50000 });

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

// ── SSE: GET /api/events/stream ───────────────────────────────────────────────
app.get("/api/events/stream", (req, res) => {
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
app.get("/api/winrate-analysis", (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;

  const opens  = queryEvents({ type: "trade_open",    date, limit: 5000  });
  const closes = queryEvents({ type: "trade_close",   date, limit: 5000  });
  const regime = queryEvents({ type: "market_regime", date, limit: 50000 });

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
app.get("/api/fingerprints", (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;
  const minN = parseInt(req.query.min || "1");

  const opens  = queryEvents({ type: "trade_open",  date, limit: 5000 });
  const closes = queryEvents({ type: "trade_close", date, limit: 5000 });

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
    });
  }

  const groups = {};
  for (const t of matched) {
    const k = t.fingerprint;
    if (!groups[k]) groups[k] = { fingerprint: k, fpDetail: t.fpDetail, wins: 0, total: 0, totalPips: 0 };
    groups[k].total++;
    groups[k].totalPips += t.profitPips;
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
    }));

  const byWinRate  = (a, b) => b.winRate - a.winRate || b.total - a.total;
  const top20      = [...list].sort(byWinRate).slice(0, 20);
  const bottom20   = [...list].sort((a, b) => -byWinRate(a, b)).slice(0, 20);

  res.json({ top20, bottom20, totalTrades: matched.length, uniquePatterns: list.length });
});

// ── API: GET /api/excursion ───────────────────────────────────────────────────
app.get("/api/excursion", (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;

  const closes = queryEvents({ type: "trade_close", date, limit: 5000 });
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
app.get("/api/confirmation-lag", (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;

  const checks = queryEvents({ type: "buy_check",  date, limit: 5000 })
    .concat(queryEvents({ type: "sell_check", date, limit: 5000 }));

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
    postEntryFailures: queryEvents({ type: "post_entry_failure", date, limit: 500 }).length,
  });
});

// ── API: GET /api/regime ──────────────────────────────────────────────────────
app.get("/api/regime", (req, res) => {
  const rows = queryEvents({
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
app.get("/api/session-performance", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const closes = queryEvents({ type: "trade_close", date, limit: 10000 });

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
app.get("/api/blocked-outcomes", (req, res) => {
  const date  = req.query.date ? parseDate(req.query.date) : undefined;
  const rows  = queryEvents({ type: "blocked_outcome", date, limit: 2000 });

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
app.get("/api/drift", (req, res) => {
  const date = req.query.date ? parseDate(req.query.date) : undefined;
  const rows = queryEvents({ type: "strategy_drift_alert", date, limit: 100 });
  res.json({ alerts: rows.map(r => ({ ts: r.ts, ...r.data })), total: rows.length });
});

// ── API: GET /api/insights ────────────────────────────────────────────────────
// Aggregated decision intelligence — best/worst session, symbol, fingerprint,
// exit efficiency, filter cost analysis, regime performance.
// Powers the INSIGHTS tab in the dashboard.
app.get("/api/insights", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const closes = queryEvents({ type: "trade_close",  date, limit: 10000 });
  const opens  = queryEvents({ type: "trade_open",   date, limit: 10000 });
  const blocks = queryEvents({ date, limit: 20000 })
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
  const postEntryFailures = queryEvents({ type: "post_entry_failure", date, limit: 500 }).length;

  // ── Drift alerts ──────────────────────────────────────────────────────────
  const driftAlerts = queryEvents({ type: "strategy_drift_alert", date, limit: 10 });

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
app.get("/api/m1trend-experiment", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = queryEvents({ type: "trade_close", date, limit: 10000 });

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
app.get("/api/almost-trades", (req, res) => {
  const date     = req.query.date ? parseDate(req.query.date) : undefined;
  const outcomes = queryEvents({ type: "almost_trade_outcome", date, limit: 10000 });
  const signals  = queryEvents({ type: "almost_trade",         date, limit: 10000 });

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

// ── API: GET /api/m5trend-experiment ──────────────────────────────────────────
// Project Snowball — M5Trend hard-block removal experiment.
// Segments all closed trades by m5TrendAtEntry boolean from trade_open events.
// Group A: m5trend=true (baseline)   Group B: m5trend=false (experiment)
app.get("/api/m5trend-experiment", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = queryEvents({ type: "trade_close", date, limit: 10000 });

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
app.get("/api/m1close-experiment", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = queryEvents({ type: "trade_close", date, limit: 10000 });

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
app.get("/api/gate-experiment", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = queryEvents({ type: "trade_close", date, limit: 10000 });

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
app.get("/api/post-entry-failures", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const pefs   = queryEvents({ type: "post_entry_failure", date, limit: 5000 });
  const opens  = queryEvents({ type: "trade_open",         date, limit: 10000 });
  const closes = queryEvents({ type: "trade_close",        date, limit: 10000 });

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
app.get("/api/trade-quality", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const opens  = queryEvents({ type: "trade_open",  date, limit: 10000 });
  const closes = queryEvents({ type: "trade_close", date, limit: 10000 });

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
app.get("/api/pipeline-audit", (req, res) => {
  const date  = req.query.date ? parseDate(req.query.date) : undefined;
  const lim   = 50000;

  // ── Stage counts ────────────────────────────────────────────────────────
  const detected    = queryEvents({ type: "signal_detected",          date, limit: lim }).length;
  const cooldown    = queryEvents({ type: "cooldown_block",            date, limit: lim }).length;
  const openTrade   = queryEvents({ type: "open_trade_block",          date, limit: lim }).length;
  const correlation = queryEvents({ type: "correlation_block",         date, limit: lim }).length;
  const disabled    = queryEvents({ type: "symbol_disabled_block",     date, limit: lim }).length;
  const spread      = queryEvents({ type: "spread_block",              date, limit: lim }).length;
  const candleRows  = queryEvents({ type: "candle_block",              date, limit: lim });
  const candleM5    = candleRows.filter(e => e.data.reason === "m5_insufficient").length;
  const candleM1    = candleRows.filter(e => e.data.reason === "m1_insufficient").length;
  const exhaustion  = queryEvents({ type: "exhaustion_block",          date, limit: lim }).length;
  const spreadEdge  = queryEvents({ type: "spread_edge_block",         date, limit: lim }).length;
  const pullback    = queryEvents({ type: "pullback_block",            date, limit: lim }).length;
  const margin      = queryEvents({ type: "margin_block",              date, limit: lim }).length;
  const defense     = queryEvents({ type: "defense_mode_skip",         date, limit: lim }).length;

  const buyChecks   = queryEvents({ type: "buy_check",                 date, limit: lim }).length;
  const sellChecks  = queryEvents({ type: "sell_check",                date, limit: lim }).length;
  const checksTotal = buyChecks;  // one per eval (same as sellChecks)

  const gateBlocks  = queryEvents({ type: "entry_blocked_at_gate",     date, limit: lim }).length;
  const almostN     = queryEvents({ type: "almost_trade",              date, limit: lim }).length;
  const tradeOpens  = queryEvents({ type: "trade_open",                date, limit: lim }).length;
  const closes      = queryEvents({ type: "trade_close",               date, limit: lim });
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
  const pullbackRows  = queryEvents({ type: "pullback_block",           date, limit: 500 });
  const marginRows    = queryEvents({ type: "margin_block",             date, limit: 500 });
  const defenseRows   = queryEvents({ type: "defense_mode_skip",        date, limit: 500 });
  const gateBlockRows = queryEvents({ type: "entry_blocked_at_gate",    date, limit: 500 });
  const almostRows    = queryEvents({ type: "almost_trade",             date, limit: 500 });

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
    SIGNAL_FILTERED:   { event: "signal_filtered",   count: queryEvents({ type: "signal_filtered", date, limit: lim }).length, note: "sub-event on every block" },
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

// ── root → dashboard ──────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const { DATA_DIR } = require("./index");
  console.log(`[SERVER] API on :${PORT}  DB: ${DATA_DIR}/events.db`);
  startBot();
});
