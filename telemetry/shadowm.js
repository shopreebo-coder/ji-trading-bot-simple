"use strict";
/**
 * Shadow M — Exit Lab
 * ════════════════════════════════════════════════════════════════
 * OBSERVE MODE ONLY. Does NOT open, close, or modify any trade.
 * Does NOT influence Live, Shadow A/B/C, or Meta D.
 * Independent persistent memory (own DB tables).
 *
 * Architecture: fully event-driven — no OANDA polling.
 * The live bot emits trade_state_snapshot every 30 s. Shadow M
 * listens to three events via the shared EventEmitter:
 *   trade_open           → start tracking position
 *   trade_state_snapshot → update MFE/MAE, check exit strategies
 *   trade_close          → finalize, rank strategies, persist result
 * ════════════════════════════════════════════════════════════════
 * DB calls are all async (via db-adapter.js).
 * Tables are created in _initTables(), called from start().
 */

const { db, emitter, logEvent } = require("./index");

// ── SQL constants (replaces prepared statements — adapter handles conversion) ──

const _UPSERT_SQL = `
  INSERT INTO shadowm_trades
    (signal_id, symbol, side, sl_pips, tp_pips, atr_entry, entry_time,
     exit_time, profit_live, mfe, mae, duration_min, profit_given_back,
     ex_atr_trail, ex_profit_protect, ex_time_1h, ex_time_2h, ex_time_4h,
     ex_breakeven, ex_tp_ext, best_strategy, best_profit, profit_saved, data)
  VALUES
    (@signal_id, @symbol, @side, @sl_pips, @tp_pips, @atr_entry, @entry_time,
     @exit_time, @profit_live, @mfe, @mae, @duration_min, @profit_given_back,
     @ex_atr_trail, @ex_profit_protect, @ex_time_1h, @ex_time_2h, @ex_time_4h,
     @ex_breakeven, @ex_tp_ext, @best_strategy, @best_profit, @profit_saved, @data)
  ON CONFLICT(signal_id) DO UPDATE SET
    exit_time         = excluded.exit_time,
    profit_live       = excluded.profit_live,
    mfe               = excluded.mfe,
    mae               = excluded.mae,
    duration_min      = excluded.duration_min,
    profit_given_back = excluded.profit_given_back,
    ex_atr_trail      = excluded.ex_atr_trail,
    ex_profit_protect = excluded.ex_profit_protect,
    ex_time_1h        = excluded.ex_time_1h,
    ex_time_2h        = excluded.ex_time_2h,
    ex_time_4h        = excluded.ex_time_4h,
    ex_breakeven      = excluded.ex_breakeven,
    ex_tp_ext         = excluded.ex_tp_ext,
    best_strategy     = excluded.best_strategy,
    best_profit       = excluded.best_profit,
    profit_saved      = excluded.profit_saved,
    data              = excluded.data
`;

const _TIMELINE_SQL = `
  INSERT INTO shadowm_timeline (signal_id, ts, pips, mfe, mae, minutes)
  VALUES (@signal_id, @ts, @pips, @mfe, @mae, @minutes)
`;

// ── Create own tables — called from start() ───────────────────────────────────
async function _initTables() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS shadowm_trades (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id         TEXT UNIQUE NOT NULL,
      symbol            TEXT,
      side              TEXT,
      sl_pips           REAL,
      tp_pips           REAL,
      atr_entry         REAL,
      entry_time        TEXT,
      exit_time         TEXT,
      profit_live       REAL,
      mfe               REAL DEFAULT 0,
      mae               REAL DEFAULT 0,
      duration_min      REAL,
      profit_given_back REAL,
      ex_atr_trail      REAL,
      ex_profit_protect REAL,
      ex_time_1h        REAL,
      ex_time_2h        REAL,
      ex_time_4h        REAL,
      ex_breakeven      REAL,
      ex_tp_ext         REAL,
      best_strategy     TEXT,
      best_profit       REAL,
      profit_saved      REAL,
      data              TEXT
    );
    CREATE TABLE IF NOT EXISTS shadowm_timeline (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id   TEXT    NOT NULL,
      ts          TEXT    NOT NULL,
      pips        REAL,
      mfe         REAL,
      mae         REAL,
      minutes     REAL
    );
    CREATE INDEX IF NOT EXISTS idx_smt_sid  ON shadowm_trades(signal_id);
    CREATE INDEX IF NOT EXISTS idx_smtl_sid ON shadowm_timeline(signal_id)
  `);
}

// ── STRATEGY LABELS ───────────────────────────────────────────────────────────

const STRATEGY_LABELS = {
  atrTrail:      "ATR Trailing",
  profitProtect: "Profit Protection",
  time1h:        "Time Exit 1h",
  time2h:        "Time Exit 2h",
  time4h:        "Time Exit 4h",
  breakeven:     "Breakeven Guard",
  tpExtended:    "TP Extended (1.5×)",
  live:          "Live (baseline)",
};

// ── EXIT STRATEGY ENGINE ──────────────────────────────────────────────────────

function _newStrategies() {
  return {
    atrTrail:      { triggered: false, exitPips: null, exitTime: null },
    profitProtect: { triggered: false, exitPips: null, exitTime: null },
    time1h:        { triggered: false, exitPips: null, exitTime: null },
    time2h:        { triggered: false, exitPips: null, exitTime: null },
    time4h:        { triggered: false, exitPips: null, exitTime: null },
    breakeven:     { triggered: false, exitPips: null, exitTime: null },
    tpExtended:    { triggered: false, exitPips: null, exitTime: null },
  };
}

/**
 * Run all exit strategy checks for one price snapshot.
 * All strategies are one-shot: once triggered they never override.
 * Uses only: current pips, running MFE, minutesOpen, and entry meta (tp, atr).
 */
function _checkStrategies(t, pips, mfe, minutesOpen, ts) {
  const s   = t.strategies;
  const tp  = t.tpPips   > 0 ? t.tpPips   : 20;
  const atr = t.atrEntry > 0 ? t.atrEntry : tp / 3;
  const p   = parseFloat(pips.toFixed(2));

  // 1. ATR Trailing — exit when price retraces 1.5×ATR from peak
  //    Requires MFE to be at least 1×ATR before the trail kicks in.
  if (!s.atrTrail.triggered && mfe > atr && (mfe - pips) > atr * 1.5) {
    s.atrTrail = { triggered: true, exitPips: p, exitTime: ts };
  }

  // 2. Profit Protection — exit when floating drops below 60% of MFE
  //    Only activates once MFE exceeds 50% of TP (meaningful profit locked in).
  if (!s.profitProtect.triggered && mfe > tp * 0.5 && pips < mfe * 0.6) {
    s.profitProtect = { triggered: true, exitPips: p, exitTime: ts };
  }

  // 3–5. Time Exits — capture floating P&L at fixed elapsed time thresholds.
  if (!s.time1h.triggered && minutesOpen >= 60) {
    s.time1h = { triggered: true, exitPips: p, exitTime: ts };
  }
  if (!s.time2h.triggered && minutesOpen >= 120) {
    s.time2h = { triggered: true, exitPips: p, exitTime: ts };
  }
  if (!s.time4h.triggered && minutesOpen >= 240) {
    s.time4h = { triggered: true, exitPips: p, exitTime: ts };
  }

  // 6. Breakeven Guard — exit at 0 when trade comes back to entry after
  //    having reached at least 25% of TP (avoids turning winners into losers).
  if (!s.breakeven.triggered && mfe > tp * 0.25 && pips <= 0) {
    s.breakeven = { triggered: true, exitPips: 0, exitTime: ts };
  }

  // 7. TP Extended — virtual exit at 1.5× TP (would running have helped?)
  if (!s.tpExtended.triggered && pips >= tp * 1.5) {
    s.tpExtended = { triggered: true, exitPips: parseFloat((tp * 1.5).toFixed(2)), exitTime: ts };
  }
}

/**
 * At trade close: compare all strategy exits vs live exit.
 * If a strategy never triggered → it falls back to live result (no harm done).
 */
function _rankStrategies(t) {
  const live = t.profitLive ?? 0;
  const s    = t.strategies;

  const candidates = {
    atrTrail:      s.atrTrail.triggered      ? s.atrTrail.exitPips      : live,
    profitProtect: s.profitProtect.triggered ? s.profitProtect.exitPips : live,
    time1h:        s.time1h.triggered        ? s.time1h.exitPips        : live,
    time2h:        s.time2h.triggered        ? s.time2h.exitPips        : live,
    time4h:        s.time4h.triggered        ? s.time4h.exitPips        : live,
    breakeven:     s.breakeven.triggered     ? s.breakeven.exitPips     : live,
    tpExtended:    s.tpExtended.triggered    ? s.tpExtended.exitPips    : live,
  };

  let best = "live";
  let bestVal = live;
  for (const [k, v] of Object.entries(candidates)) {
    if (v !== null && v > bestVal) { bestVal = v; best = k; }
  }

  t.bestStrategy = best === "live"
    ? "Live (no improvement)"
    : (STRATEGY_LABELS[best] || best);
  t.bestProfit  = parseFloat(bestVal.toFixed(2));
  t.profitSaved = parseFloat((bestVal - live).toFixed(2));

  t.strategyRanking = [
    ...Object.entries(candidates).map(([k, v]) => ({
      strategy: STRATEGY_LABELS[k] || k,
      pips:     v !== null ? parseFloat(v.toFixed(2)) : null,
    })),
    { strategy: STRATEGY_LABELS.live, pips: parseFloat(live.toFixed(2)) },
  ].sort((a, b) => (b.pips ?? -9999) - (a.pips ?? -9999));
}

// ── ROW SERIALIZER ────────────────────────────────────────────────────────────

function _toRow(t) {
  return {
    signal_id:         t.signalId,
    symbol:            t.symbol            ?? null,
    side:              t.side              ?? null,
    sl_pips:           t.slPips            ?? null,
    tp_pips:           t.tpPips            ?? null,
    atr_entry:         t.atrEntry          ?? null,
    entry_time:        t.entryTime         ?? null,
    exit_time:         t.exitTime          ?? null,
    profit_live:       t.profitLive        ?? null,
    mfe:               t.mfe               ?? 0,
    mae:               t.mae               ?? 0,
    duration_min:      t.durationMin       ?? null,
    profit_given_back: t.profitGivenBack   ?? null,
    ex_atr_trail:      t.strategies?.atrTrail?.exitPips      ?? null,
    ex_profit_protect: t.strategies?.profitProtect?.exitPips ?? null,
    ex_time_1h:        t.strategies?.time1h?.exitPips        ?? null,
    ex_time_2h:        t.strategies?.time2h?.exitPips        ?? null,
    ex_time_4h:        t.strategies?.time4h?.exitPips        ?? null,
    ex_breakeven:      t.strategies?.breakeven?.exitPips     ?? null,
    ex_tp_ext:         t.strategies?.tpExtended?.exitPips    ?? null,
    best_strategy:     t.bestStrategy      ?? null,
    best_profit:       t.bestProfit        ?? null,
    profit_saved:      t.profitSaved       ?? null,
    data:              JSON.stringify(t),
  };
}

// ── SHADOW M CLASS ────────────────────────────────────────────────────────────

class ShadowM {
  constructor() {
    this._active  = new Map();  // signalId → tracking object
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    await _initTables();
    console.log(`[SHADOW M DIAG] Tables ready. PID=${process.pid} — registering emitter listener`);

    emitter.on("event", (row) => {
      console.log(`[SHADOW M DIAG] emitter fired: type=${row.type} PID=${process.pid}`);
      (async () => {
        try {
          switch (row.type) {
            case "trade_open":           await this._onOpen(row.data);     break;
            case "trade_state_snapshot": await this._onSnapshot(row.data); break;
            case "trade_close":          await this._onClose(row.data);    break;
          }
        } catch (err) {
          console.error("[SHADOW M] Handler error:", err.message);
        }
      })();
    });

    await this._restore();

    console.log(`[SHADOW M] Exit Lab online — event-driven, OBSERVE only | PID=${process.pid}`);
    logEvent({ type: "shadowm_startup", module: "exit_lab", restored: this._active.size });
  }

  // ── Restore in-flight trades after process restart ────────────────────────
  async _restore() {
    try {
      const rows = await db.all(
        "SELECT data FROM shadowm_trades WHERE exit_time IS NULL ORDER BY id ASC"
      );
      for (const row of rows) {
        try {
          const t = JSON.parse(row.data);
          if (t?.signalId) this._active.set(t.signalId, t);
        } catch (_) {}
      }
      if (this._active.size > 0) {
        console.log(`[SHADOW M] Restored ${this._active.size} in-progress trade(s)`);
      }
    } catch (err) {
      console.error("[SHADOW M] Restore error:", err.message);
    }
  }

  // ── trade_open → start tracking ──────────────────────────────────────────
  async _onOpen(event) {
    const signalId = event.signalId;
    console.log(`[SHADOW M DIAG] _onOpen called: signalId=${signalId} symbol=${event.symbol}`);
    if (!signalId) return;

    const tracking = {
      signalId,
      symbol:    event.symbol            ?? null,
      side:      event.side              ?? null,
      slPips:    event.stopLossPips      ?? 0,
      tpPips:    event.takeProfitPips    ?? 0,
      atrEntry:  event.atrPips           ?? 0,
      entryTime: event.ts                || new Date().toISOString(),
      exitTime:          null,
      profitLive:        null,
      mfe:               0,
      mae:               0,
      durationMin:       null,
      profitGivenBack:   null,
      bestStrategy:      null,
      bestProfit:        null,
      profitSaved:       null,
      strategyRanking:   [],
      tickCount:         0,
      strategies:        _newStrategies(),
    };

    this._active.set(signalId, tracking);
    await db.run(_UPSERT_SQL, _toRow(tracking));

    logEvent({ type: "shadowm_open", symbol: tracking.symbol, signalId, side: tracking.side });
    console.log(`[SHADOW M] Tracking: ${tracking.symbol} ${(tracking.side || "?").toUpperCase()} | id:${signalId}`);
  }

  // ── trade_state_snapshot → update strategies ──────────────────────────────
  async _onSnapshot(event) {
    const signalId = event.signalId;
    if (!signalId) return;
    const t = this._active.get(signalId);
    if (!t) return;

    const pips    = typeof event.pips        === "number" ? event.pips        : 0;
    const mfe     = typeof event.mfe         === "number" ? event.mfe         : t.mfe;
    const mae     = typeof event.mae         === "number" ? event.mae         : t.mae;
    const minutes = typeof event.minutesOpen === "number" ? event.minutesOpen : 0;
    const ts      = event.ts || new Date().toISOString();

    // Accept live bot's MFE/MAE (it tracks these precisely)
    if (mfe > t.mfe) t.mfe = mfe;
    if (mae < t.mae) t.mae = mae;
    t.tickCount++;

    _checkStrategies(t, pips, t.mfe, minutes, ts);

    // Timeline: every other tick to keep DB lean
    if (t.tickCount % 2 === 0) {
      await db.run(_TIMELINE_SQL, { signal_id: signalId, ts, pips, mfe: t.mfe, mae: t.mae, minutes });
    }

    await db.run(_UPSERT_SQL, _toRow(t));
  }

  // ── trade_close → finalize + rank ────────────────────────────────────────
  async _onClose(event) {
    const signalId = event.signalId;
    if (!signalId) return;
    const t = this._active.get(signalId);
    if (!t) return;

    const ts = event.ts || new Date().toISOString();

    // Use live bot's final authoritative values
    t.exitTime     = ts;
    t.profitLive   = typeof event.profitPips          === "number" ? event.profitPips          : null;
    t.durationMin  = typeof event.duration            === "number" ? event.duration            : null;
    t.mfe          = typeof event.mfe                 === "number" ? Math.max(t.mfe, event.mfe) : t.mfe;
    t.mae          = typeof event.mae                 === "number" ? Math.min(t.mae, event.mae) : t.mae;
    t.profitGivenBack = typeof event.profitGivenBackPips === "number"
      ? event.profitGivenBackPips
      : (t.mfe > 0 && t.profitLive !== null ? parseFloat((t.mfe - t.profitLive).toFixed(2)) : null);

    _rankStrategies(t);
    await db.run(_UPSERT_SQL, _toRow(t));

    logEvent({
      type:            "shadowm_close",
      symbol:          t.symbol,
      signalId,
      profitLive:      t.profitLive,
      mfe:             t.mfe,
      mae:             t.mae,
      profitGivenBack: t.profitGivenBack,
      bestStrategy:    t.bestStrategy,
      profitSaved:     t.profitSaved,
    });

    console.log(
      `[SHADOW M] ${t.symbol} closed | Live:${t.profitLive?.toFixed(1)}p` +
      ` MFE:${t.mfe.toFixed(1)}p GivenBack:${t.profitGivenBack?.toFixed(1)}p` +
      ` Best:"${t.bestStrategy}" Saved:${t.profitSaved?.toFixed(1)}p`
    );

    this._active.delete(signalId);
  }
}

// ── SINGLETON ──────────────────────────────────────────────────────────────────

const shadowM = new ShadowM();

// ── TELEMETRY / QUERY FUNCTIONS ────────────────────────────────────────────────

async function getShadowMStats() {
  const closed = await db.all(
    "SELECT * FROM shadowm_trades WHERE exit_time IS NOT NULL"
  );
  const activeCount = (await db.get(
    "SELECT COUNT(*) AS n FROM shadowm_trades WHERE exit_time IS NULL"
  ))?.n ?? 0;

  const n = closed.length;
  if (n === 0) {
    return {
      tradesObserved: 0, activeNow: activeCount,
      avgMfe: null, avgMae: null, avgDuration: null,
      avgProfitLive: null, avgProfitSaved: null, totalProfitSaved: null,
      avgGivenBack: null, exitEfficiency: null,
      bestStrategyOverall: null, strategyWins: {},
      strategyRankingOverall: [],
    };
  }

  const pick = (arr) => arr.filter(v => v != null);
  const avg  = (arr) => { const a = pick(arr); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
  const sum  = (arr) => { const a = pick(arr); return a.length ? a.reduce((s, v) => s + v, 0) : null; };
  const fmt  = (v, d = 2) => v != null ? parseFloat(v.toFixed(d)) : null;

  const mfes      = closed.map(r => r.mfe);
  const maes      = closed.map(r => r.mae);
  const durations = closed.map(r => r.duration_min);
  const profits   = closed.map(r => r.profit_live);
  const saved     = closed.map(r => r.profit_saved ?? 0);
  const given     = closed.map(r => r.profit_given_back ?? 0);

  const strategyWins = {};
  for (const row of closed) {
    const bs = row.best_strategy;
    if (bs && bs !== "Live (no improvement)") {
      strategyWins[bs] = (strategyWins[bs] || 0) + 1;
    }
  }
  const bestStrategyOverall = Object.entries(strategyWins)
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Live (no improvement)";

  const cols = {
    "ATR Trailing":       "ex_atr_trail",
    "Profit Protection":  "ex_profit_protect",
    "Time Exit 1h":       "ex_time_1h",
    "Time Exit 2h":       "ex_time_2h",
    "Time Exit 4h":       "ex_time_4h",
    "Breakeven Guard":    "ex_breakeven",
    "TP Extended (1.5×)": "ex_tp_ext",
    "Live (baseline)":    "profit_live",
  };
  const strategyRankingOverall = Object.entries(cols)
    .map(([label, col]) => {
      const vals = pick(closed.map(r => r[col]));
      return {
        strategy: label,
        avgPips:  vals.length ? fmt(avg(vals)) : null,
        count:    vals.length,
        triggered: label === "Live (baseline)"
          ? n
          : closed.filter(r => r[col] !== null).length,
      };
    })
    .sort((a, b) => (b.avgPips ?? -9999) - (a.avgPips ?? -9999));

  const avgProfitLive = avg(profits);
  const avgMfe        = avg(mfes);
  const exitEfficiency = avgProfitLive != null && avgMfe > 0
    ? parseFloat(((avgProfitLive / avgMfe) * 100).toFixed(1))
    : null;

  return {
    tradesObserved:         n,
    activeNow:              activeCount,
    avgMfe:                 fmt(avg(mfes)),
    avgMae:                 fmt(avg(maes)),
    avgDuration:            fmt(avg(durations), 1),
    avgProfitLive:          fmt(avgProfitLive),
    avgProfitSaved:         fmt(avg(saved)),
    totalProfitSaved:       fmt(sum(saved)),
    avgGivenBack:           fmt(avg(given)),
    exitEfficiency,
    bestStrategyOverall,
    strategyWins,
    strategyRankingOverall,
  };
}

async function getShadowMTrades({ limit = 50, offset = 0, openOnly = false } = {}) {
  const where = openOnly ? "WHERE exit_time IS NULL" : "";
  const rows  = await db.all(
    `SELECT * FROM shadowm_trades ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    limit, offset
  );

  return rows.map(r => {
    let ranking = [];
    try { ranking = r.data ? JSON.parse(r.data).strategyRanking || [] : []; } catch (_) {}
    return {
      signalId:        r.signal_id,
      symbol:          r.symbol,
      side:            r.side,
      entryTime:       r.entry_time,
      exitTime:        r.exit_time,
      profitLive:      r.profit_live,
      mfe:             r.mfe,
      mae:             r.mae,
      durationMin:     r.duration_min,
      profitGivenBack: r.profit_given_back,
      bestStrategy:    r.best_strategy,
      bestProfit:      r.best_profit,
      profitSaved:     r.profit_saved,
      strategies: {
        "ATR Trailing":       r.ex_atr_trail,
        "Profit Protection":  r.ex_profit_protect,
        "Time Exit 1h":       r.ex_time_1h,
        "Time Exit 2h":       r.ex_time_2h,
        "Time Exit 4h":       r.ex_time_4h,
        "Breakeven Guard":    r.ex_breakeven,
        "TP Extended (1.5×)": r.ex_tp_ext,
      },
      strategyRanking: ranking,
    };
  });
}

async function getShadowMTimeline(signalId, limit = 200) {
  return await db.all(
    "SELECT ts, pips, mfe, mae, minutes FROM shadowm_timeline WHERE signal_id = ? ORDER BY id ASC LIMIT ?",
    signalId, limit
  );
}

module.exports = { shadowM, getShadowMStats, getShadowMTrades, getShadowMTimeline };
