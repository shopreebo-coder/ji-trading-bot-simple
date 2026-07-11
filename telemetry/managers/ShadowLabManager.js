"use strict";
/**
 * ShadowLabManager — SHADOW OS v2, Sprint 5: Shadow LAB Foundation
 *
 * A RESEARCH-ONLY measurement layer over the existing event-sourced Shadow LAB.
 *
 * What it does:
 *   Reconciles the append-only `events` stream (trade_open, lab_shadow_a/b/c/d,
 *   trade_close) into the structured research tables created by migration 005:
 *
 *     trade_open      → shadow_signals        (one row per observed signal)
 *     lab_shadow_a..d → shadow_engine_evals   (one row per signal × engine)
 *     trade_close     → shadow_outcomes       (one row per resolved signal)
 *
 *   Expectancy snapshots (shadow_expectancy_snapshots) are computed by the
 *   snapshot layer (Sprint 5 F4), not here.
 *
 * What it NEVER does (binding constraints):
 *   • It NEVER writes to, reads decisions from, or influences live trading.
 *     No engine (A/B/C/D) output is fed back anywhere. This is a pure sink.
 *   • It NEVER mutates the source `events` stream (it only appends its own
 *     cursor rows) and NEVER deletes/updates/truncates anything.
 *
 * Design guarantees:
 *   • Append-first + idempotent — every research row carries a deterministic
 *     dedupe_key; writes use `ON CONFLICT (dedupe_key) DO NOTHING`, so
 *     re-reconciling the same events is a no-op (safe after restart/redeploy).
 *   • Provenance on every row — run_id + build_id + config_hash (see
 *     shadowLabProvenance.js), so every measurement is reproducible.
 *   • Cursor-based, resumable — the highest processed events.id is persisted as
 *     an events row of type 'shadowlab_research_cursor'; on start it resumes
 *     from there (first boot → full historical catch-up from id 0).
 *   • Best-effort — all DB access is guarded; a research failure can NEVER
 *     throw into or block the live bot. Failures are logged and skipped.
 *   • events.data agnostic — parses BOTH TEXT (JSON string) and JSONB (object),
 *     since the `events.data` column has two historical definers.
 *
 * Usage:
 *   const { ShadowLabManager } = require('./managers/ShadowLabManager');
 *   const slm = new ShadowLabManager();       // uses shared db-adapter
 *   await slm.start();                          // resume + poll every 5s
 *   ...
 *   slm.stop();
 */

const { db: sharedDb } = require("../db-adapter");
const { createProvenance, confidenceLevel } = require("./shadowLabProvenance");

// Source event types the research layer consumes (read-only).
const SOURCE_EVENT_TYPES = [
  "trade_open",
  "lab_shadow_a", "lab_shadow_b", "lab_shadow_c", "lab_shadow_d",
  "trade_close",
];
// Map lab_shadow_* event type → engine id.
const ENGINE_BY_TYPE = {
  lab_shadow_a: "A",
  lab_shadow_b: "B",
  lab_shadow_c: "C",
  lab_shadow_d: "D",
};
// Our resumable cursor is stored as an events row of this type. DISTINCT from
// Shadow M's 'shadowm_cursor' so the two reconcilers never collide.
const CURSOR_TYPE = "shadowlab_research_cursor";

const DEFAULT_BATCH_LIMIT = 500;
const DEFAULT_POLL_MS = 5000;

// ── Coercion helpers ──────────────────────────────────────────────────────────
function numOrNull(v) {
  // Preserve "no data" as NULL. Note: Number(null) === 0 and Number("") === 0,
  // so guard those explicitly — an abstaining engine's null winrate must NOT
  // become a real 0 (0% ≠ "no measurement").
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function boolOrNull(v) {
  if (v === true) return true;
  if (v === false) return false;
  return null; // engines may abstain (null/undefined)
}

class ShadowLabManager {
  /**
   * @param {object}   [options]
   * @param {object}   [options.db]            db-adapter-shaped { all, get, run } (default: shared adapter)
   * @param {object}   [options.provenance]    provenance context (default: createProvenance())
   * @param {NodeJS.ProcessEnv} [options.env]  env for provenance (when provenance not supplied)
   * @param {number}   [options.batchLimit]    rows scanned per cycle (default 500)
   * @param {number}   [options.pollIntervalMs] polling cadence (default 5000)
   * @param {object}   [options.logger]        { info(), error() } (optional)
   */
  constructor(options = {}) {
    this.db = options.db || sharedDb;
    this.provenance = options.provenance || createProvenance({ env: options.env });
    this.batchLimit = options.batchLimit || DEFAULT_BATCH_LIMIT;
    this.pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_MS;
    this.logger = options.logger || null;

    this._lastId = 0;
    this._timer = null;
    this._reconciling = false;
    this._started = false;
    this._stats = { signals: 0, evals: 0, outcomes: 0, cycles: 0, lastCycleAt: null };
  }

  _info(msg) { if (this.logger && typeof this.logger.info === "function") this.logger.info(msg); }
  _error(msg) { if (this.logger && typeof this.logger.error === "function") this.logger.error(msg); }

  /** Parse an events.data value that may be a JSON string (TEXT) or an object (JSONB). */
  static parseData(data) {
    if (data == null) return {};
    if (typeof data === "object") return data;
    if (typeof data === "string") {
      try { return JSON.parse(data); } catch (_) { return {}; }
    }
    return {};
  }

  // ── Cursor ────────────────────────────────────────────────────────────────

  /** Resume the cursor from the latest persisted cursor row (0 on first boot). */
  async recoverCursor() {
    try {
      const row = await this.db.get(
        "SELECT data FROM events WHERE type = ? ORDER BY id DESC LIMIT 1",
        CURSOR_TYPE
      );
      if (row) {
        const d = ShadowLabManager.parseData(row.data);
        const n = Number(d && d.lastId);
        this._lastId = Number.isFinite(n) && n >= 0 ? n : 0;
      }
    } catch (err) {
      this._error(`[SHADOWLAB-RESEARCH] recoverCursor: ${err.message}`);
    }
    return this._lastId;
  }

  /** Persist the current cursor as an append-only events row (best-effort). */
  async _persistCursor() {
    try {
      const ts = new Date().toISOString();
      const botId = process.env.BOT_ID || "shadowlab-research";
      const payload = JSON.stringify({ type: CURSOR_TYPE, lastId: this._lastId, ts, botId });
      await this.db.run(
        "INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)",
        ts, botId, CURSOR_TYPE, null, payload
      );
    } catch (err) {
      this._error(`[SHADOWLAB-RESEARCH] _persistCursor: ${err.message}`);
    }
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────

  /**
   * Read one batch of new source events (id > cursor) and project them into the
   * research tables. Idempotent and best-effort. Returns per-cycle counts.
   * @returns {{signals:number, evals:number, outcomes:number, scanned:number, maxId:number, skipped?:boolean}}
   */
  async reconcileOnce() {
    if (this._reconciling) return { signals: 0, evals: 0, outcomes: 0, scanned: 0, maxId: this._lastId, skipped: true };
    this._reconciling = true;
    const result = { signals: 0, evals: 0, outcomes: 0, scanned: 0, maxId: this._lastId };
    try {
      let rows;
      try {
        rows = await this.db.all(
          `SELECT id, type, data FROM events
           WHERE id > ?
             AND type IN ('trade_open','lab_shadow_a','lab_shadow_b','lab_shadow_c','lab_shadow_d','trade_close')
           ORDER BY id ASC
           LIMIT ?`,
          this._lastId, this.batchLimit
        );
      } catch (err) {
        this._error(`[SHADOWLAB-RESEARCH] reconcileOnce read: ${err.message}`);
        return result;
      }

      for (const row of rows) {
        const data = ShadowLabManager.parseData(row.data);
        try {
          if (row.type === "trade_open") {
            if (await this._recordSignal(data, row)) result.signals++;
          } else if (ENGINE_BY_TYPE[row.type]) {
            if (await this._recordEval(ENGINE_BY_TYPE[row.type], data, row)) result.evals++;
          } else if (row.type === "trade_close") {
            if (await this._recordOutcome(data, row)) result.outcomes++;
          }
        } catch (err) {
          // Never let one bad row stall the cursor or throw into the caller.
          this._error(`[SHADOWLAB-RESEARCH] reconcile row ${row.id} (${row.type}): ${err.message}`);
        }
        this._lastId = row.id;
        result.scanned++;
      }

      result.maxId = this._lastId;
      if (result.scanned > 0) {
        await this._persistCursor();
        this._stats.signals += result.signals;
        this._stats.evals += result.evals;
        this._stats.outcomes += result.outcomes;
        // Append an expectancy time-series point whenever new trades resolved.
        // Idempotent (dedupe on resolved_trades), best-effort — never throws.
        if (result.outcomes > 0) {
          try { await this.snapshotExpectancy("ALL"); }
          catch (err) { this._error(`[SHADOWLAB-RESEARCH] snapshot on reconcile: ${err.message}`); }
        }
      }
      this._stats.cycles++;
      this._stats.lastCycleAt = new Date().toISOString();
    } finally {
      this._reconciling = false;
    }
    return result;
  }

  /** Drain the entire backlog in batches (used on boot / by tests). */
  async reconcileAll(maxCycles = 100000) {
    let total = { signals: 0, evals: 0, outcomes: 0, scanned: 0, cycles: 0 };
    for (let i = 0; i < maxCycles; i++) {
      const r = await this.reconcileOnce();
      total.signals += r.signals;
      total.evals += r.evals;
      total.outcomes += r.outcomes;
      total.scanned += r.scanned;
      total.cycles++;
      if (r.scanned === 0) break;
    }
    total.maxId = this._lastId;
    return total;
  }

  // ── Row projectors ──────────────────────────────────────────────────────────

  async _recordSignal(d, row) {
    const signalId = d.signalId;
    if (!signalId) return false;
    const values = this.provenance.stamp({
      signal_id: signalId,
      symbol: d.symbol ?? row.symbol ?? null,
      session: d.session ?? null,
      side: d.side ?? null,
      fingerprint: d.fingerprint ?? null,
      entry_gate: d.entryGate ?? null,
      pass_count: numOrNull(d.passCount),
      spread: numOrNull(d.spread),
      atr_pips: numOrNull(d.atrPips),
      ema_distance: numOrNull(d.emaDistance),
      candle_strength: numOrNull(d.candleStrength),
      trend_bucket: d.trendBucket ?? null,
      volatility_bucket: d.volatilityBucket ?? null,
      spread_bucket: d.spreadBucket ?? null,
      live_would_trade: true, // a real trade_open means the live bot decided to trade
      features: JSON.stringify(d),
      source_ts: d.ts ?? null,
      source_event_id: row.id,
      dedupe_key: `sig:${signalId}`,
    });
    const res = await this.db.run(
      `INSERT INTO shadow_signals
         (signal_id, symbol, session, side, fingerprint, entry_gate, pass_count,
          spread, atr_pips, ema_distance, candle_strength,
          trend_bucket, volatility_bucket, spread_bucket, live_would_trade,
          features, source_ts, source_event_id,
          run_id, build_id, config_hash, dedupe_key)
       VALUES
         (@signal_id, @symbol, @session, @side, @fingerprint, @entry_gate, @pass_count,
          @spread, @atr_pips, @ema_distance, @candle_strength,
          @trend_bucket, @volatility_bucket, @spread_bucket, @live_would_trade,
          @features, @source_ts, @source_event_id,
          @run_id, @build_id, @config_hash, @dedupe_key)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      values
    );
    return (res.changes || 0) > 0;
  }

  async _recordEval(engineId, d, row) {
    const signalId = d.signalId;
    if (!signalId) return false;
    const score =
      engineId === "A" ? numOrNull(d.score) :
      engineId === "D" ? numOrNull(d.metaVoteScore) :
      null;
    const values = this.provenance.stamp({
      signal_id: signalId,
      engine_id: engineId,
      engine_version: d.engineVersion ?? "unknown",
      would_trade: boolOrNull(d.wouldTrade),
      score,
      confidence: d.confidence ?? null,
      market_state: d.marketState ?? null,
      historical_winrate: numOrNull(d.historicalWinrate),
      eval: JSON.stringify(d),
      source_ts: d.sourceTs ?? d.ts ?? null,
      source_event_id: row.id,
      dedupe_key: `eval:${signalId}:${engineId}`,
    });
    const res = await this.db.run(
      `INSERT INTO shadow_engine_evals
         (signal_id, engine_id, engine_version, would_trade, score, confidence,
          market_state, historical_winrate, eval, source_ts, source_event_id,
          run_id, build_id, config_hash, dedupe_key)
       VALUES
         (@signal_id, @engine_id, @engine_version, @would_trade, @score, @confidence,
          @market_state, @historical_winrate, @eval, @source_ts, @source_event_id,
          @run_id, @build_id, @config_hash, @dedupe_key)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      values
    );
    return (res.changes || 0) > 0;
  }

  async _recordOutcome(d, row) {
    const signalId = d.signalId;
    if (!signalId) return false; // close without an attributable signal — skip
    const values = this.provenance.stamp({
      signal_id: signalId,
      symbol: d.symbol ?? row.symbol ?? null,
      profit_pips: numOrNull(d.profitPips),
      mfe: numOrNull(d.mfe),
      mae: numOrNull(d.mae),
      duration_min: numOrNull(d.duration),
      profit_given_back: numOrNull(d.profitGivenBackPips),
      outcome: JSON.stringify(d),
      source_ts: d.ts ?? null,
      source_event_id: row.id,
      dedupe_key: `out:${signalId}`,
    });
    const res = await this.db.run(
      `INSERT INTO shadow_outcomes
         (signal_id, symbol, profit_pips, mfe, mae, duration_min, profit_given_back,
          outcome, source_ts, source_event_id,
          run_id, build_id, config_hash, dedupe_key)
       VALUES
         (@signal_id, @symbol, @profit_pips, @mfe, @mae, @duration_min, @profit_given_back,
          @outcome, @source_ts, @source_event_id,
          @run_id, @build_id, @config_hash, @dedupe_key)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      values
    );
    return (res.changes || 0) > 0;
  }

  // ── Expectancy (research aggregates) ────────────────────────────────────────

  /**
   * Compute expectancy aggregates over resolved outcomes, WITHOUT writing.
   * scope 'ALL' = every symbol; otherwise a specific symbol.
   *
   * Definitions (documented on the schema):
   *   sample_count     = signals observed in scope
   *   resolved_trades  = signals with a recorded outcome
   *   win  = profit_pips > 0   loss = profit_pips < 0   (0 = breakeven; counted
   *          in resolved_trades + total but in neither wins nor losses)
   *   expectancy_pips  = total_profit_pips / resolved_trades
   *   profit_factor    = gross_profit / gross_loss  (null if there are no losses)
   *   confidence_level = confidenceLevel(resolved_trades)  ← the sample expectancy
   *          rests on. Tied to resolved_trades (NOT sample_count) so it stays in
   *          lockstep with the snapshot dedupe key (config_hash, scope,
   *          resolved_trades) — same resolved_trades ⇒ identical snapshot.
   */
  async computeExpectancy(scope = "ALL") {
    const isAll = !scope || scope === "ALL";

    let sampleCount = 0;
    try {
      const sigRow = isAll
        ? await this.db.get("SELECT COUNT(*) AS n FROM shadow_signals")
        : await this.db.get("SELECT COUNT(*) AS n FROM shadow_signals WHERE symbol = ?", scope);
      sampleCount = Number((sigRow && sigRow.n) || 0);
    } catch (err) {
      this._error(`[SHADOWLAB-RESEARCH] computeExpectancy signals: ${err.message}`);
    }

    let rows = [];
    try {
      rows = isAll
        ? await this.db.all("SELECT profit_pips AS p, source_ts AS ts FROM shadow_outcomes")
        : await this.db.all("SELECT profit_pips AS p, source_ts AS ts FROM shadow_outcomes WHERE symbol = ?", scope);
    } catch (err) {
      this._error(`[SHADOWLAB-RESEARCH] computeExpectancy outcomes: ${err.message}`);
    }

    let resolvedTrades = 0;
    let wins = 0, losses = 0;
    let total = 0, grossProfit = 0, grossLoss = 0;
    let windowFrom = null, windowTo = null;
    for (const r of rows) {
      const p = numOrNull(r.p);
      if (p === null) continue; // outcome without a numeric pip result — not resolved
      resolvedTrades++;
      total += p;
      if (p > 0) { wins++; grossProfit += p; }
      else if (p < 0) { losses++; grossLoss += Math.abs(p); }
      if (r.ts) {
        if (windowFrom === null || r.ts < windowFrom) windowFrom = r.ts;
        if (windowTo === null || r.ts > windowTo) windowTo = r.ts;
      }
    }

    const round = (v) => (v === null ? null : Math.round(v * 1e6) / 1e6);
    const expectancyPips = resolvedTrades > 0 ? round(total / resolvedTrades) : null;
    const profitFactor = grossLoss > 0 ? round(grossProfit / grossLoss) : null;

    return {
      scope: isAll ? "ALL" : scope,
      sampleCount,
      resolvedTrades,
      wins,
      losses,
      breakevens: resolvedTrades - wins - losses,
      totalProfitPips: round(total),
      grossProfitPips: round(grossProfit),
      grossLossPips: round(grossLoss),
      expectancyPips,
      profitFactor,
      confidenceLevel: confidenceLevel(resolvedTrades),
      windowFrom,
      windowTo,
    };
  }

  /**
   * Compute + append an expectancy snapshot (idempotent). One row per distinct
   * (config_hash, scope, resolved_trades) — re-computation with unchanged data
   * is a no-op; each newly resolved trade yields a new time-series point.
   * @returns {{inserted:boolean, dedupeKey:string, ...aggregates}}
   */
  async snapshotExpectancy(scope = "ALL") {
    const agg = await this.computeExpectancy(scope);
    const dedupe = `exp:${this.provenance.configHash}:${agg.scope}:${agg.resolvedTrades}`;
    const values = this.provenance.stamp({
      scope: agg.scope,
      sample_count: agg.sampleCount,
      resolved_trades: agg.resolvedTrades,
      wins: agg.wins,
      losses: agg.losses,
      total_profit_pips: agg.totalProfitPips ?? 0,
      gross_profit_pips: agg.grossProfitPips ?? 0,
      gross_loss_pips: agg.grossLossPips ?? 0,
      expectancy_pips: agg.expectancyPips,
      profit_factor: agg.profitFactor,
      confidence_level: agg.confidenceLevel,
      window_from: agg.windowFrom,
      window_to: agg.windowTo,
      detail: JSON.stringify({ breakevens: agg.breakevens }),
      dedupe_key: dedupe,
    });
    let res = { changes: 0 };
    try {
      res = await this.db.run(
        `INSERT INTO shadow_expectancy_snapshots
           (scope, sample_count, resolved_trades, wins, losses,
            total_profit_pips, gross_profit_pips, gross_loss_pips,
            expectancy_pips, profit_factor, confidence_level,
            window_from, window_to, detail,
            run_id, build_id, config_hash, dedupe_key)
         VALUES
           (@scope, @sample_count, @resolved_trades, @wins, @losses,
            @total_profit_pips, @gross_profit_pips, @gross_loss_pips,
            @expectancy_pips, @profit_factor, @confidence_level,
            @window_from, @window_to, @detail,
            @run_id, @build_id, @config_hash, @dedupe_key)
         ON CONFLICT (dedupe_key) DO NOTHING`,
        values
      );
    } catch (err) {
      this._error(`[SHADOWLAB-RESEARCH] snapshotExpectancy: ${err.message}`);
    }
    return { inserted: (res.changes || 0) > 0, dedupeKey: dedupe, ...agg };
  }

  // ── Read APIs (for the read-only /api/lab/* endpoints) ──────────────────────

  /** Live expectancy for a scope (computed on demand). */
  async getExpectancy(scope = "ALL") {
    return this.computeExpectancy(scope);
  }

  /** High-level research dashboard: counts, per-engine behaviour, ALL expectancy. */
  async getResearchSummary() {
    const count = async (sql) => {
      try { const r = await this.db.get(sql); return Number((r && r.n) || 0); }
      catch (_) { return 0; }
    };
    const signals = await count("SELECT COUNT(*) AS n FROM shadow_signals");
    const engineEvals = await count("SELECT COUNT(*) AS n FROM shadow_engine_evals");
    const outcomes = await count("SELECT COUNT(*) AS n FROM shadow_outcomes");

    let engines = [];
    try {
      engines = await this.db.all(
        `SELECT engine_id,
                COUNT(*)                                        AS total,
                SUM(CASE WHEN would_trade = TRUE  THEN 1 ELSE 0 END) AS would_trade,
                SUM(CASE WHEN would_trade IS NULL THEN 1 ELSE 0 END) AS abstain
         FROM shadow_engine_evals
         GROUP BY engine_id
         ORDER BY engine_id ASC`
      );
    } catch (err) {
      this._error(`[SHADOWLAB-RESEARCH] getResearchSummary engines: ${err.message}`);
    }

    return {
      generated: new Date().toISOString(),
      counts: { signals, engineEvals, outcomes },
      expectancy: await this.computeExpectancy("ALL"),
      engines: engines.map((e) => ({
        engineId: e.engine_id,
        total: Number(e.total || 0),
        wouldTrade: Number(e.would_trade || 0),
        abstain: Number(e.abstain || 0),
      })),
      provenance: {
        runId: this.provenance.runId,
        buildId: this.provenance.buildId,
        configHash: this.provenance.configHash,
      },
    };
  }

  /** Persisted expectancy time series for a scope (oldest → newest). */
  async getTimeseries(scope = "ALL", limit = 500) {
    try {
      return await this.db.all(
        `SELECT scope, sample_count, resolved_trades, wins, losses,
                total_profit_pips, expectancy_pips, profit_factor,
                confidence_level, window_from, window_to, created_at
         FROM shadow_expectancy_snapshots
         WHERE scope = ?
         ORDER BY resolved_trades ASC, id ASC
         LIMIT ?`,
        scope, limit
      );
    } catch (err) {
      this._error(`[SHADOWLAB-RESEARCH] getTimeseries: ${err.message}`);
      return [];
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Resume the cursor, do one immediate pass, then poll on an interval. */
  async start() {
    if (this._started) return this;
    this._started = true;
    await this.recoverCursor();
    await this.reconcileOnce();
    this._timer = setInterval(() => {
      this.reconcileOnce().catch((err) =>
        this._error(`[SHADOWLAB-RESEARCH] poll: ${err && err.message}`)
      );
    }, this.pollIntervalMs);
    if (this._timer.unref) this._timer.unref(); // never keep the process alive
    this._info(
      `[SHADOWLAB-RESEARCH] online — run_id=${this.provenance.runId} ` +
      `build_id=${this.provenance.buildId} lastId=${this._lastId}`
    );
    return this;
  }

  /** Stop polling. Idempotent. Does not close the shared pool. */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._started = false;
  }

  getStats() {
    return {
      ...this._stats,
      lastId: this._lastId,
      started: this._started,
      provenance: {
        runId: this.provenance.runId,
        buildId: this.provenance.buildId,
        configHash: this.provenance.configHash,
      },
    };
  }
}

module.exports = {
  ShadowLabManager,
  SOURCE_EVENT_TYPES,
  ENGINE_BY_TYPE,
  CURSOR_TYPE,
};
