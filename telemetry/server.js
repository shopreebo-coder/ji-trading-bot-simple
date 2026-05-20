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

const PORT   = process.env.PORT || 3001;
const app    = express();

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

function queryEvents({ type, symbol, date, limit = 500 } = {}) {
  let sql    = "SELECT id,ts,bot_id,type,symbol,data FROM events WHERE 1=1";
  const args = [];
  if (type)   { sql += " AND type=?";                args.push(type); }
  if (symbol) { sql += " AND symbol=?";              args.push(symbol); }
  if (date)   { sql += " AND substr(ts,1,10)=?";     args.push(date); }
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

  // match by symbol + nearest timestamp
  const closeMap = {};
  for (const c of closes) {
    const key = c.symbol;
    if (!closeMap[key]) closeMap[key] = [];
    closeMap[key].push(c);
  }

  const trades = opens.map(o => {
    const pool = closeMap[o.symbol] || [];
    const match = pool.find(c => c.ts >= o.ts);
    return { open: o.data, close: match?.data || null };
  });

  res.json(trades);
});

// ── API: GET /api/today ───────────────────────────────────────────────────────
app.get("/api/today", (req, res) => {
  const date   = parseDate("today");
  const closes = queryEvents({ type: "trade_close", date, limit: 1000 });

  let wins = 0, losses = 0, totalPeak = 0, totalDur = 0;
  for (const c of closes) {
    const d = c.data;
    if ((d.profitPips || 0) > 0) wins++; else losses++;
    totalPeak += d.peak || 0;
    totalDur  += d.duration || 0;
  }

  const n   = closes.length;
  const blocks = queryEvents({ date, limit: 1000 })
    .filter(e => ["spread_block","cooldown_block","correlation_block","pullback_block","margin_block"].includes(e.type));

  const blockCounts = {};
  for (const b of blocks) blockCounts[b.type] = (blockCounts[b.type] || 0) + 1;

  res.json({
    date,
    trades:        n,
    wins,
    losses,
    winRate:       n ? ((wins / n) * 100).toFixed(1) : "0.0",
    avgPeak:       n ? (totalPeak / n).toFixed(2) : "0.00",
    avgDuration:   n ? (totalDur  / n).toFixed(1) : "0.0",
    blockCounts,
    dailyTrades:   live.dailyTrades,
  });
});

// ── API: GET /api/stats ───────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  const symbol = req.query.symbol;
  const date   = req.query.date ? parseDate(req.query.date) : undefined;

  const closes = queryEvents({ type: "trade_close", symbol, date, limit: 5000 });
  let wins = 0, losses = 0, totalPeak = 0, totalDur = 0;
  for (const c of closes) {
    const d = c.data;
    if ((d.profitPips || 0) > 0) wins++; else losses++;
    totalPeak += d.peak || 0;
    totalDur  += d.duration || 0;
  }
  const n = closes.length;

  const checks = queryEvents({ type: "buy_check",  symbol, date, limit: 5000 })
    .concat(queryEvents({ type: "sell_check", symbol, date, limit: 5000 }));

  const allBlocks = queryEvents({ date, limit: 10000 })
    .filter(e => e.type.endsWith("_block"));

  const blockCounts = {};
  for (const b of allBlocks) blockCounts[b.type] = (blockCounts[b.type] || 0) + 1;

  res.json({
    trades:       n,
    wins,
    losses,
    winRate:      n ? ((wins / n) * 100).toFixed(1) : "0.0",
    avgPeak:      n ? (totalPeak / n).toFixed(2) : "0.00",
    avgDuration:  n ? (totalDur  / n).toFixed(1) : "0.0",
    checksTotal:  checks.length,
    blockCounts,
    botStatus:    live.botStatus,
    dailyTrades:  live.dailyTrades,
  });
});

// ── API: GET /api/symbols ─────────────────────────────────────────────────────
app.get("/api/symbols", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const closes = queryEvents({ type: "trade_close", date, limit: 10000 });

  const map = {};
  for (const c of closes) {
    const sym = c.symbol;
    if (!map[sym]) map[sym] = { symbol: sym, trades: 0, wins: 0, losses: 0, totalPeak: 0, totalProfitPips: 0 };
    const d = c.data;
    map[sym].trades++;
    if ((d.profitPips || 0) > 0) map[sym].wins++; else map[sym].losses++;
    map[sym].totalPeak         += d.peak || 0;
    map[sym].totalProfitPips   += d.profitPips || 0;
  }

  const result = Object.values(map).map(s => ({
    ...s,
    winRate:    s.trades ? ((s.wins / s.trades) * 100).toFixed(1) : "0.0",
    avgPeak:    s.trades ? (s.totalPeak / s.trades).toFixed(2) : "0.00",
    avgProfit:  s.trades ? (s.totalProfitPips / s.trades).toFixed(2) : "0.00",
  }));

  res.json(result);
});

// ── API: GET /api/live ────────────────────────────────────────────────────────
app.get("/api/live", (req, res) => {
  res.json({
    botStatus:   live.botStatus,
    dailyTrades: live.dailyTrades,
    openTrades:  Object.values(live.openTrades),
    recentBlocks: live.recentBlocks,
  });
});

// ── API: GET /api/export ──────────────────────────────────────────────────────
app.get("/api/export", (req, res) => {
  const date   = parseDate(req.query.date || "today");
  const format = req.query.format || "json";
  const rows   = queryEvents({ date, limit: 50000 });

  if (format === "csv") {
    const cols = ["id","ts","bot_id","type","symbol"];
    // collect all data keys
    const dataKeys = new Set();
    rows.forEach(r => Object.keys(r.data).forEach(k => dataKeys.add(k)));
    const dkArr = [...dataKeys].filter(k => !["type","symbol","ts","botId","timestamp"].includes(k));
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

  // send current live state immediately
  res.write(`data: ${JSON.stringify({ source: "live", type: "init", live: {
    botStatus:   live.botStatus,
    dailyTrades: live.dailyTrades,
    openTrades:  Object.values(live.openTrades),
    recentBlocks: live.recentBlocks,
  } })}\n\n`);

  // keepalive
  const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch (_) {} }, 25000);
  req.on("close", () => { clearInterval(ka); sseClients.delete(res); });
});

// ── API: GET /api/winrate-analysis ───────────────────────────────────────────
app.get("/api/winrate-analysis", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;

  const opens  = queryEvents({ type: "trade_open",     date, limit: 5000  });
  const closes = queryEvents({ type: "trade_close",    date, limit: 5000  });
  const regime = queryEvents({ type: "market_regime",  date, limit: 50000 });

  // Index regime by symbol for fast lookup
  const regBySymbol = {};
  for (const r of regime) {
    (regBySymbol[r.symbol] = regBySymbol[r.symbol] || []).push(r);
  }

  // Match each open trade with its close, then nearest regime snapshot
  const matched = [];
  for (const o of opens) {
    const sym    = o.symbol;
    const openTs = o.ts;
    const close  = closes.find(c => c.symbol === sym && c.ts >= openTs);
    if (!close) continue; // still open or unmatched

    const won   = (close.data.profitPips || 0) > 0;
    const pool  = regBySymbol[sym] || [];
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

  const symbolBuckets = bucketWinRate(matched, t => t.symbol);

  res.json({ atrBuckets, hourBuckets, spreadBuckets, symbolBuckets, totalTrades: matched.length });
});

// ── API: GET /api/fingerprints ────────────────────────────────────────────────
app.get("/api/fingerprints", (req, res) => {
  const date   = req.query.date ? parseDate(req.query.date) : undefined;
  const minN   = parseInt(req.query.min || "1");

  const opens  = queryEvents({ type: "trade_open",  date, limit: 5000 });
  const closes = queryEvents({ type: "trade_close", date, limit: 5000 });

  // Match each open to its close
  const matched = [];
  for (const o of opens) {
    const fp = o.data.fingerprint;
    if (!fp) continue;
    const close = closes.find(c => c.symbol === o.symbol && c.ts >= o.ts);
    if (!close) continue; // still open

    matched.push({
      fingerprint: fp,
      fpDetail:    o.data.fp || null,
      symbol:      o.symbol,
      side:        o.data.side,
      won:         (close.data.profitPips || 0) > 0,
      profitPips:  close.data.profitPips || 0,
    });
  }

  // Group by fingerprint
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
  const top20    = [...list].sort(byWinRate).slice(0, 20);
  const bottom20 = [...list].sort((a, b) => -byWinRate(a, b)).slice(0, 20);

  res.json({ top20, bottom20, totalTrades: matched.length, uniquePatterns: list.length });
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
