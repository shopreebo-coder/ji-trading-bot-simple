/**
 * FOREX ENGINE PRO — Telemetry Dashboard
 *
 * Wrapper around index.js. Spawns the bot as a child process,
 * parses its stdout/stderr, and serves a live web dashboard via SSE.
 *
 * Railway: change start command from  node index.js  →  node dashboard.js
 * Dashboard is served on  $PORT  (Railway injects this automatically).
 * Bot logs still pass through to Railway's own log stream.
 */

"use strict";

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const PORT = process.env.PORT || 3001;

// ─── In-memory state ────────────────────────────────────────────────────────

const state = {
  botStatus: "starting",
  dailyTrades: 0,
  stats: {
    wins: 0,
    losses: 0,
    totalTrades: 0,
    totalPeakPips: 0,
    totalDurationMin: 0,
  },
  openTrades: {},   // symbol → { symbol, side, pips, peak, breakEven, entryTime }
  recentExits: [],  // last 30
  filterBlocks: [], // last 30
  recentEntries: [],// last 30
  logLines: [],     // last 200
};

// ─── SSE clients ─────────────────────────────────────────────────────────────

const clients = new Set();

function broadcast(msg) {
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}

// ─── Log capture ─────────────────────────────────────────────────────────────

function addLog(line) {
  const entry = { t: new Date().toISOString(), line };
  state.logLines.push(entry);
  if (state.logLines.length > 200) state.logLines.shift();
  broadcast({ type: "log", ...entry });
}

// ─── Computed state snapshot ─────────────────────────────────────────────────

function snapshot() {
  const s = state.stats;
  const n = s.totalTrades;
  return {
    botStatus:     state.botStatus,
    dailyTrades:   state.dailyTrades,
    stats: {
      wins:        s.wins,
      losses:      s.losses,
      totalTrades: n,
      winRate:     n > 0 ? ((s.wins / n) * 100).toFixed(1) : "0.0",
      avgPeak:     n > 0 ? (s.totalPeakPips / n).toFixed(1) : "0.0",
      avgDuration: n > 0 ? (s.totalDurationMin / n).toFixed(1) : "0.0",
    },
    openTrades:    Object.values(state.openTrades),
    recentExits:   state.recentExits,
    filterBlocks:  state.filterBlocks,
    recentEntries: state.recentEntries,
  };
}

// ─── Exit-block parser ────────────────────────────────────────────────────────
// Bot emits a single console.log with embedded \n, which stdout splits into
// individual lines: EXIT EUR_USD / reason=X / profit=X / peak=X / minutes=X / breakEven=X

let exitBuffer = null;

function flushExitBuffer() {
  if (!exitBuffer) return;
  const e = exitBuffer;
  exitBuffer = null;

  e.t       = new Date().toISOString();
  e.profit  = parseFloat(e.profit  || 0);
  e.peak    = parseFloat(e.peak    || 0);
  e.minutes = parseFloat(e.minutes || 0);

  // Dashboard-side stats (session only — resets when dashboard restarts)
  if (e.profit > 0) state.stats.wins++;
  else              state.stats.losses++;
  state.stats.totalTrades++;
  state.stats.totalPeakPips     += e.peak;
  state.stats.totalDurationMin  += e.minutes;

  state.recentExits.unshift(e);
  if (state.recentExits.length > 30) state.recentExits.pop();

  delete state.openTrades[e.symbol];

  broadcast({ type: "state", state: snapshot() });
}

// ─── Single-line parser ───────────────────────────────────────────────────────

function parseLine(raw) {
  const line = raw.trim();
  if (!line) return;

  addLog(line);

  // ── collect EXIT block lines ──────────────────────────────────────────────
  if (line.startsWith("EXIT ")) {
    flushExitBuffer(); // flush any prior incomplete block
    exitBuffer = { symbol: line.slice(5) };
    return;
  }

  if (exitBuffer) {
    const kv = line.match(/^(reason|profit|peak|minutes|breakEven)=(.+)$/);
    if (kv) {
      exitBuffer[kv[1]] = kv[2];
      if (kv[1] === "breakEven") flushExitBuffer(); // last expected field
      return;
    }
    // unexpected line → flush what we have
    flushExitBuffer();
  }

  // ── trade opened: "Trade -> EUR_USD BUY" ─────────────────────────────────
  const tradeOpen = line.match(/^Trade -> (\S+) (BUY|SELL)$/);
  if (tradeOpen) {
    const symbol = tradeOpen[1];
    const side   = tradeOpen[2].toLowerCase();
    state.openTrades[symbol] = {
      symbol,
      side,
      pips: 0,
      peak: 0,
      breakEven: false,
      entryTime: Date.now(),
    };
    state.recentEntries.unshift({ symbol, side, t: new Date().toISOString() });
    if (state.recentEntries.length > 30) state.recentEntries.pop();
    broadcast({ type: "state", state: snapshot() });
    return;
  }

  // ── live pips: "EUR_USD -> 2.34 pips" ────────────────────────────────────
  const pipsLine = line.match(/^(\S+) -> (-?[\d.]+) pips$/);
  if (pipsLine) {
    const symbol = pipsLine[1];
    const pips   = parseFloat(pipsLine[2]);
    if (state.openTrades[symbol]) {
      state.openTrades[symbol].pips = pips;
      broadcast({ type: "pips", symbol, pips });
    }
    return;
  }

  // ── peak update: "EUR_USD PEAK -> 3.45" ──────────────────────────────────
  const peakLine = line.match(/^(\S+) PEAK -> (-?[\d.]+)$/);
  if (peakLine) {
    const symbol = peakLine[1];
    const peak   = parseFloat(peakLine[2]);
    if (state.openTrades[symbol]) {
      state.openTrades[symbol].peak = peak;
      broadcast({ type: "pips", symbol, pips: state.openTrades[symbol].pips });
    }
    return;
  }

  // ── break even: "EUR_USD BREAK EVEN ON" ──────────────────────────────────
  const beLine = line.match(/^(\S+) BREAK EVEN ON$/);
  if (beLine) {
    const symbol = beLine[1];
    if (state.openTrades[symbol]) {
      state.openTrades[symbol].breakEven = true;
      broadcast({ type: "state", state: snapshot() });
    }
    return;
  }

  // ── daily trade counter: "dailyTrades=5" ─────────────────────────────────
  const dtLine = line.match(/^dailyTrades=(\d+)$/);
  if (dtLine) {
    state.dailyTrades = parseInt(dtLine[1]);
    broadcast({ type: "dailyTrades", value: state.dailyTrades });
    return;
  }

  // ── filter blocks ─────────────────────────────────────────────────────────
  if (
    line.includes("PULLBACK BLOCK") ||
    line.includes("SPREAD BLOCK") ||
    line.includes("CORRELATION BLOCK") ||
    line.includes("MARGIN PROTECTION ACTIVE")
  ) {
    state.filterBlocks.unshift({ t: new Date().toISOString(), line });
    if (state.filterBlocks.length > 30) state.filterBlocks.pop();
    broadcast({ type: "state", state: snapshot() });
  }
}

// ─── Bot process ──────────────────────────────────────────────────────────────

function startBot() {
  console.log("[DASHBOARD] Starting bot: node index.js");
  state.botStatus = "running";

  const bot = spawn("node", [path.join(__dirname, "index.js")], {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
  });

  let buf = "";

  function onData(chunk) {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop(); // keep incomplete tail
    for (const line of lines) {
      process.stdout.write(line + "\n"); // pass through → Railway log stream
      parseLine(line);
    }
  }

  bot.stdout.on("data", onData);
  bot.stderr.on("data", onData);

  bot.on("exit", (code) => {
    flushExitBuffer();
    state.botStatus = "stopped";
    broadcast({ type: "state", state: snapshot() });
    console.log(`[DASHBOARD] Bot exited (code=${code}), restarting in 5 s…`);
    setTimeout(startBot, 5000);
  });
}

// ─── HTML dashboard ───────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FOREX ENGINE PRO — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:'Segoe UI',monospace;font-size:14px}
header{background:#161b22;border-bottom:1px solid #30363d;padding:14px 24px;display:flex;align-items:center;gap:14px}
header h1{font-size:15px;font-weight:600;letter-spacing:.4px;color:#58a6ff}
.dot{width:10px;height:10px;border-radius:50%;background:#3fb950;flex-shrink:0}
.dot.stopped{background:#f85149}
.dot.starting{background:#d29922;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.ts{margin-left:auto;font-size:11px;color:#484f58}
.wrap{padding:20px 24px;max-width:1400px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;margin-bottom:20px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px}
.card .lbl{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px}
.card .val{font-size:26px;font-weight:700}
.val.blue{color:#58a6ff}.val.green{color:#3fb950}.val.red{color:#f85149}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
@media(max-width:860px){.g2{grid-template-columns:1fr}}
.panel{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
.ph{padding:9px 14px;border-bottom:1px solid #30363d;font-size:11px;font-weight:600;color:#8b949e;text-transform:uppercase;letter-spacing:.8px;display:flex;justify-content:space-between}
.pb{overflow-y:auto;max-height:280px}
table{width:100%;border-collapse:collapse}
th{background:#0d1117;color:#8b949e;font-size:10px;font-weight:600;text-transform:uppercase;padding:7px 12px;text-align:left;position:sticky;top:0;z-index:1}
td{padding:7px 12px;border-bottom:1px solid #21262d;font-size:12px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#1c2128}
.empty{color:#484f58;padding:14px;text-align:center;font-size:12px}
.tag{display:inline-block;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700}
.buy{background:#1f4a2e;color:#3fb950}.sell{background:#4a1f1f;color:#f85149}.be{background:#1f3a4a;color:#58a6ff}
.pp{color:#3fb950;font-weight:600}.pn{color:#f85149;font-weight:600}.pz{color:#8b949e}
.logpanel{background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden;margin-bottom:20px}
.logbody{height:190px;overflow-y:auto;padding:8px 14px;font-family:monospace;font-size:11px;color:#8b949e;scroll-behavior:smooth}
.ll{padding:1px 0;border-bottom:1px solid #21262d18;white-space:pre-wrap;word-break:break-all}
.ll.t{color:#3fb950}.ll.x{color:#f85149}.ll.b{color:#d29922}.ll.e{color:#58a6ff}
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>FOREX ENGINE PRO v39.1 &mdash; Telemetry</h1>
  <span class="ts" id="ts">connecting&hellip;</span>
</header>
<div class="wrap">
  <div class="cards">
    <div class="card"><div class="lbl">Daily Trades</div><div class="val blue" id="c-dt">0</div></div>
    <div class="card"><div class="lbl">Closed (session)</div><div class="val" id="c-tot">0</div></div>
    <div class="card"><div class="lbl">Wins</div><div class="val green" id="c-w">0</div></div>
    <div class="card"><div class="lbl">Losses</div><div class="val red" id="c-l">0</div></div>
    <div class="card"><div class="lbl">Win Rate</div><div class="val" id="c-wr">0%</div></div>
    <div class="card"><div class="lbl">Avg Peak</div><div class="val" id="c-pk">0 p</div></div>
    <div class="card"><div class="lbl">Avg Duration</div><div class="val" id="c-dur">0 min</div></div>
  </div>

  <div class="g2">
    <div class="panel">
      <div class="ph">Open Trades <span id="ot-cnt">0</span></div>
      <div class="pb">
        <table><thead><tr><th>Symbol</th><th>Side</th><th>Pips</th><th>Peak</th><th>BE</th><th>Open</th></tr></thead>
        <tbody id="ot-body"><tr><td colspan="6" class="empty">No open trades</td></tr></tbody></table>
      </div>
    </div>
    <div class="panel">
      <div class="ph">Recent Exits <span id="ex-cnt">0</span></div>
      <div class="pb">
        <table><thead><tr><th>Symbol</th><th>Reason</th><th>Profit</th><th>Peak</th><th>Min</th></tr></thead>
        <tbody id="ex-body"><tr><td colspan="5" class="empty">No exits yet</td></tr></tbody></table>
      </div>
    </div>
  </div>

  <div class="g2">
    <div class="panel">
      <div class="ph">Filter Blocks</div>
      <div class="pb">
        <table><thead><tr><th>UTC</th><th>Event</th></tr></thead>
        <tbody id="bl-body"><tr><td colspan="2" class="empty">No blocks</td></tr></tbody></table>
      </div>
    </div>
    <div class="panel">
      <div class="ph">Entries</div>
      <div class="pb">
        <table><thead><tr><th>UTC</th><th>Symbol</th><th>Side</th></tr></thead>
        <tbody id="en-body"><tr><td colspan="3" class="empty">No entries yet</td></tr></tbody></table>
      </div>
    </div>
  </div>

  <div class="logpanel">
    <div class="ph">Live Log</div>
    <div class="logbody" id="log"></div>
  </div>
</div>

<script>
const $=id=>document.getElementById(id);

function hms(iso){return new Date(iso).toUTCString().slice(17,25)}

function pips(v){
  v=parseFloat(v);
  const cls=v>0?'pp':v<0?'pn':'pz';
  return '<span class="'+cls+'">'+(v>0?'+':'')+v.toFixed(2)+'</span>';
}

// Open-trade pips refreshed every 2 s from in-memory clone
let openTradeCache=[];
function renderOpen(){
  const rows=openTradeCache;
  $('ot-cnt').textContent=rows.length;
  if(!rows.length){$('ot-body').innerHTML='<tr><td colspan="6" class="empty">No open trades</td></tr>';return;}
  $('ot-body').innerHTML=rows.map(t=>{
    const min=((Date.now()-t.entryTime)/60000).toFixed(1);
    const beTag=t.breakEven?'<span class="tag be">BE</span>':'';
    return '<tr><td>'+t.symbol+'</td><td><span class="tag '+t.side+'">'+t.side.toUpperCase()+'</span></td><td>'+pips(t.pips)+'</td><td>'+pips(t.peak)+'</td><td>'+beTag+'</td><td>'+min+'m</td></tr>';
  }).join('');
}
setInterval(renderOpen,2000);

function renderState(s){
  $('c-dt').textContent=s.dailyTrades;
  $('c-tot').textContent=s.stats.totalTrades;
  $('c-w').textContent=s.stats.wins;
  $('c-l').textContent=s.stats.losses;
  $('c-wr').textContent=s.stats.winRate+'%';
  $('c-pk').textContent=s.stats.avgPeak+' p';
  $('c-dur').textContent=s.stats.avgDuration+' min';

  openTradeCache=s.openTrades;
  renderOpen();

  $('ex-cnt').textContent=s.recentExits.length;
  $('ex-body').innerHTML=s.recentExits.length
    ?s.recentExits.slice(0,20).map(e=>'<tr><td>'+e.symbol+'</td><td>'+e.reason+'</td><td>'+pips(e.profit)+'</td><td>'+pips(e.peak)+'</td><td>'+e.minutes+'m</td></tr>').join('')
    :'<tr><td colspan="5" class="empty">No exits yet</td></tr>';

  $('bl-body').innerHTML=s.filterBlocks.length
    ?s.filterBlocks.slice(0,20).map(b=>'<tr><td>'+hms(b.t)+'</td><td>'+b.line+'</td></tr>').join('')
    :'<tr><td colspan="2" class="empty">No blocks</td></tr>';

  $('en-body').innerHTML=s.recentEntries.length
    ?s.recentEntries.slice(0,20).map(e=>'<tr><td>'+hms(e.t)+'</td><td>'+e.symbol+'</td><td><span class="tag '+e.side+'">'+e.side.toUpperCase()+'</span></td></tr>').join('')
    :'<tr><td colspan="3" class="empty">No entries yet</td></tr>';

  const dot=$('dot');
  dot.className='dot '+(s.botStatus==='running'?'':s.botStatus);
}

function appendLog(t,line){
  const lb=$('log');
  const d=document.createElement('div');
  const cls=line.startsWith('Trade ->')?'t':line.startsWith('EXIT')?'x':line.includes('BLOCK')?'b':line.includes('BREAK EVEN')?'e':'';
  d.className='ll'+(cls?' '+cls:'');
  d.textContent=hms(t)+' '+line;
  lb.appendChild(d);
  if(lb.children.length>400)lb.removeChild(lb.firstChild);
  lb.scrollTop=lb.scrollHeight;
}

// SSE
const es=new EventSource('/events');
es.onmessage=function(ev){
  const msg=JSON.parse(ev.data);
  $('ts').textContent='last: '+hms(new Date().toISOString())+' UTC';
  if(msg.type==='state')renderState(msg.state);
  else if(msg.type==='log')appendLog(msg.t,msg.line);
  else if(msg.type==='pips'){
    const t=openTradeCache.find(x=>x.symbol===msg.symbol);
    if(t)t.pips=msg.pips;
  }
  else if(msg.type==='dailyTrades')$('c-dt').textContent=msg.value;
};
es.onerror=function(){
  $('dot').className='dot stopped';
  $('ts').textContent='disconnected — reconnecting\u2026';
};

fetch('/state').then(r=>r.json()).then(renderState);
</script>
</body>
</html>`;

// ─── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // SSE stream
  if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    clients.add(res);
    // Send current state immediately on connect
    res.write(`data: ${JSON.stringify({ type: "state", state: snapshot() })}\n\n`);
    // Replay last 50 log lines
    for (const entry of state.logLines.slice(-50)) {
      res.write(`data: ${JSON.stringify({ type: "log", ...entry })}\n\n`);
    }
    req.on("close", () => clients.delete(res));
    return;
  }

  // State JSON
  if (req.url === "/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  // Dashboard HTML
  if (req.url === "/" || req.url === "/dashboard") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`[DASHBOARD] Listening on port ${PORT}`);
  startBot();
});
