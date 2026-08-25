"use strict";
/**
 * SHADOW OS v2 — Sprint 7.2: TelemetryReconciler (TELEMETRY-ONLY close capture)
 *
 * PROBLEM (confirmed Sprint 7.2 audit): index.js emits trade_close ONLY at its
 * 5 SOFTWARE exit points (PROFIT PROTECTION, MOMENTUM LOST, EXIT_FLOOR_TRIGGERED,
 * EARLY EXIT, TIME EXIT). Trades closed ON THE OANDA SIDE — take-profit fills,
 * stop-loss fills (including the v39.4 MFE-floor SL, whose DESIGNED mechanism is
 * an OANDA SL fill), manual closes, margin closeouts, and any close that happens
 * while the bot/server is down — NEVER produced a trade_close event. That was
 * the largest telemetry blind spot (server.js pipeline audit finding).
 *
 * SOLUTION: this manager polls OANDA's read-only closed-trades endpoint
 * (GET /v3/accounts/{id}/trades?state=CLOSED) on an unref'd 60s timer and, for
 * every OANDA-closed trade that has NO corresponding trade_close event, emits a
 * SYNTHETIC trade_close (marked synthetic:true, captureMethod:"oanda_reconciler",
 * oandaTradeId) so ShadowM / Knowledge / AI Report v2 finally see 100% of closes.
 *
 * SAFETY INVARIANTS (READ-ONLY vs trading):
 *  - NEVER calls a mutating OANDA endpoint — GET only.
 *  - NEVER touches the trading path; index.js is FROZEN and unaware of this.
 *  - Writes ONLY events rows (synthetic trade_close + its own cursor marker).
 *  - Poll loop never throws; every OANDA/DB error is caught → lastError only.
 *  - Kill switch: TELEMETRY_RECONCILER=off → complete no-op (default ON, like
 *    SELECTED_ADVISOR — the blind spot is the sprint objective).
 *
 * DEDUPE STRATEGY (per OANDA-closed trade, in priority order):
 *  1. oandaTradeId exact match — a synthetic close for this trade already exists.
 *  2. signalId match — recover signalId from trade_open (symbol + openTime
 *     proximity), then look for ANY existing trade_close carrying that signalId
 *     (native software closes always carry signalId unless the bot restarted).
 *  3. symbol + close-time window fallback (±NATIVE_MATCH_WINDOW_MS, consumed
 *     one-to-one within a poll) — covers native closes with null signalId.
 *  4. No match → the close was MISSED → emit synthetic trade_close.
 *
 * REGRESSION-CRITICAL GUARDS (architect-mandated):
 *  - GRACE DELAY: logEvent() is fire-and-forget async, so a native trade_close
 *    row may not exist yet when the trade first appears in state=CLOSED. Only
 *    trades whose closeTime is older than GRACE_MS (default 3 min) are eligible;
 *    younger ones are counted as pendingWithinGrace, never as missing.
 *  - FIRST-RUN BASELINE: with no persisted cursor, the baseline initializes to
 *    NOW — the reconciler never backfills the account's entire historical
 *    closed-trade list as synthetic events (that would flood ShadowM/winrate).
 *
 * HONEST NULLS: fields only the live bot can know (mfe, mae, peak, exit
 *  efficiency, MFE time snapshots, …) are null on synthetic closes — never 0
 *  (Number(null)===0 fabrication gotcha). ShadowM._onClose typeof-guards all of
 *  them, so nulls flow through safely.
 *
 * PARTIAL CLOSES: OANDA keeps a partially-closed trade in state=OPEN; only the
 *  final full close moves it to CLOSED, with realizedPL / averageClosePrice
 *  aggregated over the whole trade. The reconciler therefore emits exactly ONE
 *  synthetic trade_close per trade (the final aggregate) — no per-partial
 *  events, so no downstream winrate double-counting.
 */

const CURSOR_TYPE = "telemetry_reconciler_cursor";

const DEFAULT_POLL_MS          = 60_000;      // 60s between OANDA polls
const DEFAULT_GRACE_MS         = 180_000;     // 3 min settle window for native logEvent
const DEFAULT_SIGNAL_WINDOW_MS = 180_000;     // trade_open ts vs OANDA openTime tolerance
const DEFAULT_NATIVE_WINDOW_MS = 90_000;      // native trade_close ts vs closeTime tolerance
const DEFAULT_CLOSED_COUNT     = 50;          // trades per poll (covers MAX_DAILY_TRADES=50)

// OANDA ORDER_FILL transaction `reason` → human-readable close reason.
// NOTE: the bot's own closeTrade() also produces MARKET_ORDER_TRADE_CLOSE, but
// those trades are native-matched in steps 1-3 and never reach reason mapping.
const REASON_MAP = Object.freeze({
  STOP_LOSS_ORDER:               "STOP LOSS (OANDA)",
  TAKE_PROFIT_ORDER:             "TAKE PROFIT (OANDA)",
  TRAILING_STOP_LOSS_ORDER:      "TRAILING STOP (OANDA)",
  MARKET_ORDER_TRADE_CLOSE:      "MANUAL/BROKER CLOSE (OANDA)",
  MARKET_ORDER_POSITION_CLOSEOUT:"POSITION CLOSEOUT (OANDA)",
  MARKET_ORDER_MARGIN_CLOSEOUT:  "MARGIN CLOSEOUT (OANDA)",
  MARGIN_CLOSEOUT:               "MARGIN CLOSEOUT (OANDA)",
});

// Same session buckets as index.js classifySession (kept in sync — telemetry only)
function classifySession(hourUTC) {
  if (hourUTC >= 21 || hourUTC < 3)  return "DEAD_ZONE";
  if (hourUTC >= 3  && hourUTC < 7)  return "ASIA";
  if (hourUTC >= 7  && hourUTC < 12) return "LONDON";
  if (hourUTC >= 12 && hourUTC < 17) return "OVERLAP";
  return "NEW_YORK";
}

// Same outcome rule as server.js classifyOutcome / index.js stats
function classifyOutcome(pips) {
  if (pips === null || pips === undefined || Number.isNaN(pips)) return null;
  if (pips < 0)    return "LOSS";
  if (pips <= 1.0) return "BREAKEVEN";
  return "WIN";
}

// Null-safe numeric coercion — NEVER turns null/undefined/"" into 0 (project gotcha)
function num(x) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isNaN(n) ? null : n;
}

// Pip multiplier: quote-currency JPY pairs use 0.01, everything else 0.0001
function pipMult(instrument) {
  return String(instrument || "").split("_")[1] === "JPY" ? 0.01 : 0.0001;
}

/**
 * Default OANDA read-only client (GET only) built from env. Returns null when
 * credentials are absent — the reconciler then stays dormant (credsPresent=false).
 */
function buildDefaultOandaClient(env = process.env, fetchImpl = globalThis.fetch) {
  const apiKey    = env.OANDA_API_KEY;
  const accountId = env.OANDA_ACCOUNT_ID;
  if (!apiKey || !accountId || typeof fetchImpl !== "function") return null;

  const oandaEnv = String(env.OANDA_ENV || env.OANDA_ENVIRONMENT || "practice")
    .trim().toLowerCase();
  const baseUrl = oandaEnv === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";
  const headers = { Authorization: `Bearer ${apiKey}` };

  async function getJson(url) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`OANDA ${res.status} ${url.replace(baseUrl, "")}`);
    return res.json();
  }

  return {
    // Most recently closed trades, OANDA returns newest-first
    async getClosedTrades(count = DEFAULT_CLOSED_COUNT) {
      const j = await getJson(`${baseUrl}/v3/accounts/${accountId}/trades?state=CLOSED&count=${count}`);
      return Array.isArray(j.trades) ? j.trades : [];
    },
    // Single transaction lookup — used to read the ORDER_FILL `reason`
    async getTransaction(txnId) {
      const j = await getJson(`${baseUrl}/v3/accounts/${accountId}/transactions/${txnId}`);
      return j.transaction || null;
    },
  };
}

class TelemetryReconciler {
  /**
   * @param {object} opts
   * @param {object} opts.db          db-adapter (get/all/run/exec)
   * @param {function} opts.logEvent  fire-and-forget event writer (telemetry/index.js)
   * @param {object|null} [opts.oanda]  injectable read-only OANDA client
   *                                    { getClosedTrades(count), getTransaction(id) }
   *                                    default: built from env (null if creds absent)
   * @param {object} [opts.logger]
   * @param {number} [opts.pollIntervalMs]
   * @param {number} [opts.graceMs]
   * @param {number} [opts.signalMatchWindowMs]
   * @param {number} [opts.nativeMatchWindowMs]
   * @param {number} [opts.closedTradeCount]
   * @param {function} [opts.now]     ()=>ms — injectable clock for tests
   */
  constructor({
    db,
    logEvent,
    oanda,
    logger = console,
    pollIntervalMs      = DEFAULT_POLL_MS,
    graceMs             = DEFAULT_GRACE_MS,
    signalMatchWindowMs = DEFAULT_SIGNAL_WINDOW_MS,
    nativeMatchWindowMs = DEFAULT_NATIVE_WINDOW_MS,
    closedTradeCount    = DEFAULT_CLOSED_COUNT,
    now = () => Date.now(),
  } = {}) {
    if (!db) throw new Error("TelemetryReconciler: db is required");
    if (typeof logEvent !== "function") throw new Error("TelemetryReconciler: logEvent is required");

    this.db       = db;
    this.logEvent = logEvent;
    this.oanda    = oanda === undefined ? buildDefaultOandaClient() : oanda;
    this.log      = logger;
    this.now      = now;

    this.pollIntervalMs      = pollIntervalMs;
    this.graceMs             = graceMs;
    this.signalMatchWindowMs = signalMatchWindowMs;
    this.nativeMatchWindowMs = nativeMatchWindowMs;
    this.closedTradeCount    = closedTradeCount;

    this._timer      = null;
    this._polling    = false;
    this._started    = false;
    this._baselineMs = null;            // never reconcile closes at/before this
    this._reconciled = new Set();       // oandaTradeId (string) — handled this lifetime + restored
    // Native trade_close event ids consumed by the time-window fallback.
    // INSTANCE-level (survives across polls) + restored from cursor rows, so a
    // native close matched to trade A in poll N can never also absorb trade B
    // in poll N+1 or after a restart (architect: cross-poll re-consumption gap).
    this._consumedNative = new Set();

    this.stats = {
      pollCount:          0,
      oandaClosesSeen:    0,   // distinct closed trades inspected past baseline
      nativeMatched:      0,   // captured by the live bot itself
      syntheticWritten:   0,   // missed closes recovered by the reconciler
      pendingWithinGrace: 0,   // closed at OANDA but still inside grace window (snapshot)
      pendingRetry:       0,   // eligible trades whose reconcile FAILED this poll (retry next poll)
      reconcileErrors:    0,
      lastPollAt:         null,
      lastError:          null,
      baseline:           null,
    };
  }

  get credsPresent() { return !!this.oanda; }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  async start() {
    if (this._started) return;
    this._started = true;

    await this._restore();

    if (!this.oanda) {
      this.log.info?.("[TELEMETRY RECONCILER] OANDA credentials absent — dormant (DB-only health still available)");
      return;
    }

    // Immediate first poll (best-effort), then unref'd interval — never keeps process alive
    this._poll().catch(() => {});
    this._timer = setInterval(
      () => this._poll().catch((err) => { this.stats.lastError = String(err && err.message || err); }),
      this.pollIntervalMs,
    );
    if (typeof this._timer.unref === "function") this._timer.unref();

    this.log.info?.(
      `[TELEMETRY RECONCILER] online — poll=${this.pollIntervalMs}ms grace=${this.graceMs}ms ` +
      `baseline=${this.stats.baseline} restoredDedupe=${this._reconciled.size}`
    );
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._started = false;
  }

  // ── restore: baseline + dedupe set ─────────────────────────────────────────
  async _restore() {
    try {
      // 1. Cursor (baseline) — FIRST-RUN: initialize to NOW so we never backfill
      //    the account's entire closed-trade history as synthetic events.
      //    Recent cursor rows also carry consumedEventIds (native closes matched
      //    by the time-window fallback) — union them so consumption survives
      //    restarts (cross-poll re-consumption fix).
      const cursorRows = (await this.db.all(
        `SELECT data FROM events WHERE type='${CURSOR_TYPE}' ORDER BY id DESC LIMIT 50`
      )) || [];
      if (cursorRows.length > 0) {
        const d = typeof cursorRows[0].data === "string" ? JSON.parse(cursorRows[0].data) : cursorRows[0].data;
        const t = Date.parse(d && d.baseline);
        this._baselineMs = Number.isNaN(t) ? this.now() : t;
      } else {
        this._baselineMs = this.now();
        // Persist immediately so a crash before first poll still pins the baseline
        this.logEvent({ type: CURSOR_TYPE, baseline: new Date(this._baselineMs).toISOString(), firstRun: true });
      }
      this.stats.baseline = new Date(this._baselineMs).toISOString();
      for (const r of cursorRows) {
        try {
          const d = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
          if (Array.isArray(d && d.consumedEventIds)) {
            for (const id of d.consumedEventIds) this._consumedNative.add(id);
          }
        } catch (_) {}
      }

      // 2. Rebuild dedupe set from previously-written synthetic closes
      //    (events.data is TEXT on prod — LIKE match, parse in JS)
      const rows = await this.db.all(
        `SELECT data FROM events WHERE type='trade_close' AND data LIKE '%oanda_reconciler%' ORDER BY id DESC LIMIT 500`
      );
      for (const r of rows || []) {
        try {
          const d = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
          if (d && d.oandaTradeId) this._reconciled.add(String(d.oandaTradeId));
        } catch (_) {}
      }
    } catch (err) {
      // Restore failure must never block startup — fall back to NOW baseline
      this._baselineMs = this._baselineMs ?? this.now();
      this.stats.baseline = new Date(this._baselineMs).toISOString();
      this.stats.lastError = `restore: ${err.message}`;
      this.log.error?.(`[TELEMETRY RECONCILER] restore error (non-fatal): ${err.message}`);
    }
  }

  // ── poll tick — NEVER throws ────────────────────────────────────────────────
  async _poll() {
    if (this._polling || !this.oanda) return;
    this._polling = true;
    this.stats.pollCount++;
    this.stats.lastPollAt = new Date(this.now()).toISOString();

    try {
      const closed = await this.oanda.getClosedTrades(this.closedTradeCount);
      const nowMs  = this.now();

      // Ascending closeTime so the watermark/dedupe grows monotonically
      const eligible = [];
      let pendingWithinGrace = 0;

      for (const t of closed) {
        const closeMs = Date.parse(t.closeTime);
        if (Number.isNaN(closeMs)) continue;
        if (closeMs <= this._baselineMs) continue;                 // before baseline — out of scope
        if (this._reconciled.has(String(t.id))) continue;          // already handled
        if (nowMs - closeMs < this.graceMs) { pendingWithinGrace++; continue; } // settle window
        eligible.push({ trade: t, closeMs });
      }
      this.stats.pendingWithinGrace = pendingWithinGrace;
      eligible.sort((a, b) => a.closeMs - b.closeMs);

      // one-to-one native-close consumption — INSTANCE-level set (survives
      // across polls and restarts via cursor rows), see constructor note
      const newlyConsumed  = [];
      const errorsBefore   = this.stats.reconcileErrors;
      let   failedThisPoll = 0;

      for (const { trade } of eligible) {
        try {
          const r = await this._reconcileTrade(trade, this._consumedNative);
          if (r && r.consumedEventId != null) newlyConsumed.push(r.consumedEventId);
          this.stats.oandaClosesSeen++;
          this._reconciled.add(String(trade.id));
        } catch (err) {
          // leave un-reconciled → retried next poll
          failedThisPoll++;
          this.stats.reconcileErrors++;
          this.stats.lastError = `reconcile ${trade.id}: ${err.message}`;
          this.log.error?.(`[TELEMETRY RECONCILER] reconcile error trade=${trade.id}: ${err.message}`);
        }
      }
      this.stats.pendingRetry = failedThisPoll;

      if (eligible.length > 0) {
        // Persist progress marker (baseline unchanged — it only pins first-run
        // scope) + the native-close event ids consumed by this poll's
        // time-window matches (restored on restart)
        this.logEvent({
          type: CURSOR_TYPE,
          baseline:         this.stats.baseline,
          oandaClosesSeen:  this.stats.oandaClosesSeen,
          nativeMatched:    this.stats.nativeMatched,
          syntheticWritten: this.stats.syntheticWritten,
          consumedEventIds: newlyConsumed,
        });
      }
      // Clear lastError ONLY when this poll had zero per-trade reconcile errors —
      // a successful fetch must not mask reconcile failures set moments earlier
      if (this.stats.reconcileErrors === errorsBefore) this.stats.lastError = null;
    } catch (err) {
      this.stats.lastError = String(err && err.message || err);
      this.log.error?.(`[TELEMETRY RECONCILER] poll error: ${this.stats.lastError}`);
    } finally {
      this._polling = false;
    }
  }

  // ── per-trade reconciliation ────────────────────────────────────────────────
  async _reconcileTrade(trade, consumedEventIds) {
    const tradeId = String(trade.id);

    // 1. Exact dedupe — synthetic close already written for this OANDA trade
    const dupe = await this.db.get(
      "SELECT id FROM events WHERE type='trade_close' AND data LIKE ? LIMIT 1",
      `%"oandaTradeId":"${tradeId}"%`
    );
    if (dupe) return { status: "already_synthetic" };

    // 2. signalId recovery from trade_open (symbol + openTime proximity)
    const signalId = await this._recoverSignalId(trade);

    // 3. signalId-first native match — exact, immune to timing
    if (signalId) {
      const bySignal = await this.db.get(
        "SELECT id FROM events WHERE type='trade_close' AND data LIKE ? LIMIT 1",
        `%"signalId":"${signalId}"%`
      );
      if (bySignal) {
        this.stats.nativeMatched++;
        return { status: "native", via: "signalId" };
      }
    }

    // 4. Fallback: symbol + closeTime window, consumed one-to-one per poll
    const closeMs  = Date.parse(trade.closeTime);
    const winStart = new Date(closeMs - this.nativeMatchWindowMs).toISOString();
    const winEnd   = new Date(closeMs + this.nativeMatchWindowMs).toISOString();
    const nearby = await this.db.all(
      "SELECT id, data FROM events WHERE type='trade_close' AND symbol=? AND ts>=? AND ts<=? ORDER BY id ASC",
      trade.instrument, winStart, winEnd
    );
    for (const r of nearby || []) {
      if (consumedEventIds.has(r.id)) continue;
      let d = null;
      try { d = typeof r.data === "string" ? JSON.parse(r.data) : r.data; } catch (_) {}
      // A synthetic close for a DIFFERENT OANDA trade must not absorb this one
      if (d && d.oandaTradeId && String(d.oandaTradeId) !== tradeId) continue;
      consumedEventIds.add(r.id);
      this.stats.nativeMatched++;
      return { status: "native", via: "time_window", consumedEventId: r.id };
    }

    // 5. MISSED close → emit synthetic trade_close
    await this._emitSyntheticClose(trade, signalId);
    this.stats.syntheticWritten++;
    return { status: "synthetic", signalId };
  }

  async _recoverSignalId(trade) {
    try {
      const openMs = Date.parse(trade.openTime);
      if (Number.isNaN(openMs)) return null;
      const winStart = new Date(openMs - this.signalMatchWindowMs).toISOString();
      const winEnd   = new Date(openMs + this.signalMatchWindowMs).toISOString();
      const rows = await this.db.all(
        "SELECT id, ts, data FROM events WHERE type='trade_open' AND symbol=? AND ts>=? AND ts<=? ORDER BY id ASC",
        trade.instrument, winStart, winEnd
      );
      let best = null, bestDist = Infinity;
      for (const r of rows || []) {
        const dist = Math.abs(Date.parse(r.ts) - openMs);
        if (dist < bestDist) { bestDist = dist; best = r; }
      }
      if (!best) return null;
      const d = typeof best.data === "string" ? JSON.parse(best.data) : best.data;
      return (d && d.signalId) || null;
    } catch (_) {
      return null; // signalId recovery is best-effort — null is a valid outcome
    }
  }

  async _emitSyntheticClose(trade, signalId) {
    const openMs  = Date.parse(trade.openTime);
    const closeMs = Date.parse(trade.closeTime);
    const mult    = pipMult(trade.instrument);

    const openPrice  = num(trade.price);
    const closePrice = num(trade.averageClosePrice);
    const units      = num(trade.initialUnits);
    const direction  = units === null ? null : (units > 0 ? 1 : -1);

    let profitPips = null;
    if (openPrice !== null && closePrice !== null && direction !== null) {
      profitPips = parseFloat((((closePrice - openPrice) / mult) * direction).toFixed(2));
    }

    const duration = (!Number.isNaN(openMs) && !Number.isNaN(closeMs))
      ? parseFloat(((closeMs - openMs) / 60000).toFixed(2))
      : null;

    // Close reason — from the ORDER_FILL transaction's `reason` field
    let rawReason = null;
    try {
      const txnIds = Array.isArray(trade.closingTransactionIDs) ? trade.closingTransactionIDs : [];
      if (txnIds.length > 0) {
        const txn = await this.oanda.getTransaction(txnIds[txnIds.length - 1]);
        rawReason = (txn && txn.reason) || null;
      }
    } catch (err) {
      // reason fetch is best-effort — a synthetic close with UNKNOWN reason
      // still beats a silently missing close
      this.log.error?.(`[TELEMETRY RECONCILER] reason fetch failed trade=${trade.id}: ${err.message}`);
    }
    const reason = REASON_MAP[rawReason] || `OANDA CLOSE (${rawReason || "UNKNOWN"})`;

    const closeDate = Number.isNaN(closeMs) ? new Date(this.now()) : new Date(closeMs);

    // Field names match buildClosePayload (index.js) exactly; bot-only fields are
    // HONEST NULLS — never 0 (Number(null)===0 fabrication gotcha).
    this.logEvent({
      type:      "trade_close",
      timestamp: closeDate.toISOString(),      // event ts = actual OANDA close time
      signalId:  signalId || null,
      symbol:    trade.instrument,
      session:   classifySession(closeDate.getUTCHours()),
      reason,
      profitPips,
      duration,
      outcome:   classifyOutcome(profitPips),
      peak: null, mfe: null, mae: null,
      timeToProfitMin: null, timeToDrawdownMin: null, beTimeMin: null,
      exitEfficiency: null, retainedProfitPercent: null, profitGivenBackPips: null,
      entryEfficiencyPips: null,
      mfe30s: null, mfe60s: null, mfe120s: null,
      // ── reconciler provenance ──
      synthetic:       true,
      captureMethod:   "oanda_reconciler",
      oandaTradeId:    String(trade.id),
      oandaCloseReason: rawReason,
      realizedPL:      num(trade.realizedPL),
      oandaOpenTime:   trade.openTime  || null,
      oandaCloseTime:  trade.closeTime || null,
    });

    this.log.info?.(
      `[TELEMETRY RECONCILER] SYNTHETIC trade_close: ${trade.instrument} oandaTradeId=${trade.id} ` +
      `reason="${reason}" pips=${profitPips} signalId=${signalId || "null"}`
    );
  }

  // ── health / stats ──────────────────────────────────────────────────────────
  getStats() {
    return {
      enabled:      this._started,
      credsPresent: this.credsPresent,
      config: {
        pollIntervalMs:      this.pollIntervalMs,
        graceMs:             this.graceMs,
        signalMatchWindowMs: this.signalMatchWindowMs,
        nativeMatchWindowMs: this.nativeMatchWindowMs,
        closedTradeCount:    this.closedTradeCount,
      },
      ...this.stats,
      dedupeSetSize: this._reconciled.size,
    };
  }
}

module.exports = {
  TelemetryReconciler,
  buildDefaultOandaClient,
  CURSOR_TYPE,
  REASON_MAP,
  DEFAULT_POLL_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_SIGNAL_WINDOW_MS,
  DEFAULT_NATIVE_WINDOW_MS,
};
