"use strict";
/**
 * SelectedAdvisor — ADVISOR-ONLY bridge: Live Bot telemetry → Selected Engine
 * ============================================================================
 * Connects the (already existing, already read-only) SelectedEngineManager to
 * the live trade stream as a PURE ADVISORY layer. When server.js observes a
 * live trade open (stdout line "Trade -> SYMBOL SIDE"), this class — on a
 * detached, unref'd timer — recovers the trade's signalId from the append-only
 * `events` table (READ-only SELECT), asks SelectedEngineManager to build its
 * DecisionContext for that exact signal, and attaches the resulting OPINION to
 * an in-memory advisory ring.
 *
 * ABSOLUTE CONTRACT (advisor mode):
 *   1. NEVER throws to the caller — every public method is fully try/catch
 *      wrapped. A failure here can NEVER affect trading. If the Selected
 *      Engine throws, the Live Bot behaves exactly as before.
 *   2. NEVER blocks, alters, delays, or influences any trade, signal, score,
 *      confidence, or execution step. It runs strictly AFTER the trade-open
 *      fact has been observed, on its own unref'd timers.
 *   3. NEVER writes to the database. Uses ONLY db.get (read-only SELECT).
 *      The advisory lives in a bounded in-memory ring — nothing is persisted.
 *   4. Kill switch: enabled=false makes every method a complete no-op
 *      (SELECTED_ADVISOR=off in server.js restores prior behavior exactly).
 *   5. Entry handshake: when Live supplies the current Shadow A/B/C advisory,
 *      this bridge passes the same signal plus those outputs to Selected Engine,
 *      aggregates both layers, and returns the resulting read-only context.
 *
 * Timing: shadow_signals rows (required for a non-empty DecisionContext) are
 * created asynchronously by the ShadowLab research reconciler (~5s poll,
 * SHADOW_LAB_RESEARCH flag). The advisor therefore retries on a short backoff
 * schedule; if the signal never materializes (e.g. research flag off), it
 * records a stub advisory carrying the reason instead of failing.
 */

// Attempt delays after the trade-open observation (ms). The reconciler polls
// every ~5s, so the first attempt at 10s normally already finds the signal.
const DEFAULT_ATTEMPT_DELAYS_MS = [10_000, 25_000, 60_000];

// Reject a recovered trade_open event older than this — guards against
// attaching a stale signalId from a previous trade on the same symbol.
const DEFAULT_STALE_MS = 120_000;

// Bounded advisory ring size.
const DEFAULT_RING_SIZE = 100;

class SelectedAdvisor {
  /**
   * @param {object}   options
   * @param {boolean}  [options.enabled=true]   Kill switch — false = complete no-op
   * @param {object}   options.db               db-adapter (ONLY db.get is used)
   * @param {object}   options.selectedEngine   SelectedEngineManager instance (read-only)
   * @param {object}   [options.logger]         { info, error } (defaults to console)
   * @param {number[]} [options.attemptDelaysMs] Retry schedule (tests use short delays)
   * @param {number}   [options.staleMs]        Max trade_open event age for signalId recovery
   * @param {number}   [options.ringSize]       Advisory ring capacity
   */
  constructor(options = {}) {
    this._enabled        = options.enabled !== false;
    this._db             = options.db || null;
    this._selectedEngine = options.selectedEngine || null;
    this._log            = options.logger || { info: () => {}, error: (m) => console.warn(m) };
    this._delays         = Array.isArray(options.attemptDelaysMs) && options.attemptDelaysMs.length
      ? options.attemptDelaysMs.slice()
      : DEFAULT_ATTEMPT_DELAYS_MS.slice();
    this._staleMs        = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_MS;
    this._ringSize       = Number.isFinite(options.ringSize) ? options.ringSize : DEFAULT_RING_SIZE;

    this._ring     = [];          // newest last
    this._timers   = new Set();   // pending unref'd timers (cleared by stop())
    this._stopped  = false;
    this._counters = {
      observed:  0,   // trade opens seen
      advisories: 0,  // full advisories recorded (non-empty context)
      stubs:     0,   // stub advisories (signal never found / empty context)
      errors:    0,   // swallowed errors
      entryContexts: 0,   // live entry contexts received
      entryAdvisories: 0, // A/B/C + Selected context assembled
      entryErrors: 0,     // entry handshake errors swallowed
    };
  }

  // ── Dual TEXT/JSONB events.data parser (same contract as ShadowLabManager) ──
  static parseData(data) {
    if (data == null) return {};
    if (typeof data === "object") return data;
    try { return JSON.parse(data); } catch (_) { return {}; }
  }

  /**
   * Build the two receipt events emitted by the Live Bot after it receives the
   * Selected Advisor context. Pure helper: it performs no I/O.
   */
  static buildLiveReceiptEvents(responseData = {}, signal = {}) {
    const context = responseData && responseData.selectedAdvisorContext;
    if (!context) return [];
    const base = {
      advisoryId: context.advisoryId || null,
      signalId: signal.signalId || null,
      symbol: signal.symbol || null,
      side: signal.side || null,
      advisoryOnly: true,
      authoritativeLayer: "live_bot",
      channel: "live_entry_decision_context",
      cooperationPath: "shadow_abc_selected_live",
      deliveredTo: "live_bot",
      readBy: "live_bot",
      accepted: true,
      usedForDecision: false,
      selectedDecision: context.selected?.decision || "ABSTAIN",
      selectedContextId: context.selected?.contextId || null,
    };
    return [
      { type: "selected_advisor_advisory_delivered", ...base },
      { type: "selected_advisor_advisory_read", ...base },
    ];
  }

  static aggregateShadowOutputs(outputs = {}) {
    const recommendations = Object.fromEntries(
      Object.entries(outputs).map(([letter, output]) => [letter, output.recommendation || "ABSTAIN"])
    );
    const votesFor = Object.values(recommendations).filter((value) => value === "TRADE").length;
    const votesAgainst = Object.values(recommendations).filter((value) => value === "NO_TRADE").length;
    const decided = votesFor + votesAgainst;
    return {
      consensus: decided === 0
        ? "ABSTAIN"
        : votesFor === votesAgainst
          ? "SPLIT"
          : votesFor > votesAgainst ? "TRADE" : "NO_TRADE",
      votesFor,
      votesAgainst,
      abstain: Object.values(recommendations).filter((value) => value === "ABSTAIN").length,
      decided,
      recommendations,
    };
  }

  static buildEntryLifecycleEvents({ handoff = null, signal = {}, shadowAdvisory = null } = {}) {
    if (!handoff || handoff.accepted !== true) return [];
    const lifecycleBase = {
      advisoryId: shadowAdvisory?.advisoryId || handoff.advisoryId || null,
      signalId: signal.signalId || signal.signal_id || null,
      symbol: signal.symbol || null,
      side: signal.side || null,
      advisoryOnly: true,
      authoritativeLayer: "live_bot",
      channel: "live_entry_decision_context",
      cooperationPath: "shadow_abc_selected_live",
      acceptedBy: "selected_advisor",
      usedForDecision: false,
    };
    const events = [];
    for (const [letter, output] of Object.entries(handoff.shadowOutputs || {})) {
      const base = {
        ...lifecycleBase,
        advisoryId: output.advisoryId || lifecycleBase.advisoryId,
        engineId: output.engineId || null,
        recommendation: output.recommendation || "ABSTAIN",
        confidence: output.confidence ?? null,
      };
      events.push(
        {
          type: `shadow_${letter.toLowerCase()}_advisory_delivered`,
          ...base,
          deliveredTo: "selected_advisor",
        },
        {
          type: `shadow_${letter.toLowerCase()}_advisory_read`,
          ...base,
          readBy: "selected_advisor",
          accepted: true,
        },
      );
    }
    events.push({
      type: "selected_advisor_advisory_generated",
      ...lifecycleBase,
      selectedDecision: handoff.selected?.decision || "ABSTAIN",
      selectedContextId: handoff.selected?.contextId || null,
      shadowEngineCount: Object.keys(handoff.shadowOutputs || {}).length,
    });
    return events;
  }

  /**
   * Observe a live trade open. Fire-and-forget: schedules detached, unref'd
   * attempts and returns immediately. NEVER throws.
   *
   * @param {object} args
   * @param {string} args.symbol  e.g. "EUR_USD"
   * @param {string} args.side    e.g. "buy"
   */
  onTradeOpen(args = {}) {
    try {
      if (!this._enabled || this._stopped) return;
      const symbol = args.symbol || null;
      if (!symbol) return;
      this._counters.observed++;
      const job = {
        symbol,
        side: args.side || null,
        observedAt: Date.now(),
        signalId: null,
      };
      this._schedule(job, 0);
    } catch (err) {
      this._counters.errors++;
      try { this._log.error(`[SELECTED ADVISOR] onTradeOpen: ${err.message}`); } catch (_) {}
    }
  }

  /**
   * Receive the current Live entry context after Shadow A/B/C evaluation.
   * This is the real cooperative path:
   *   Live setup → Shadow A/B/C → Selected Advisor → Live decision context.
   *
   * It remains advisory-only: the returned context is information for Live and
   * never contains an execution instruction or broker operation.
   */
  async receiveEntryContext({
    signal = {},
    shadowAdvisory = null,
    selectedResult: providedSelectedResult = null,
  } = {}) {
    try {
      if (!this._enabled || this._stopped) {
        return {
          accepted: false,
          enabled: false,
          advisoryOnly: true,
          reason: "selected_advisor_runtime_off",
        };
      }
      const outputs = shadowAdvisory && shadowAdvisory.outputs &&
        typeof shadowAdvisory.outputs === "object"
        ? Object.fromEntries(Object.entries(shadowAdvisory.outputs)
          .filter(([, output]) => output && output.advisoryId && output.engineId)
          .map(([letter, output]) => [letter, {
            advisoryId: output.advisoryId,
            engineId: output.engineId,
            recommendation: output.recommendation || "ABSTAIN",
            confidence: output.confidence ?? null,
            evaluation: output.evaluation || null,
          }]))
        : {};
      const requiredLetters = ["A", "B", "C"]
        .filter((letter) => shadowAdvisory?.runtime?.[letter] !== false);
      const missingLetters = requiredLetters.filter((letter) => !outputs[letter]);
      if (!shadowAdvisory || !Object.keys(outputs).length || missingLetters.length) {
        return {
          accepted: false,
          enabled: true,
          advisoryOnly: true,
          reason: missingLetters.length
            ? `shadow_advisory_outputs_missing:${missingLetters.join(",")}`
            : "shadow_advisory_context_missing",
        };
      }

      this._counters.entryContexts++;
      const selectedResult = providedSelectedResult || (this._selectedEngine &&
        typeof this._selectedEngine.evaluateEntry === "function"
        ? await this._selectedEngine.evaluateEntry({
            ...signal,
            advisoryOutputs: outputs,
            shadowAdvisory,
          })
        : {
          decision: "ABSTAIN",
          contextId: null,
          confidenceScore: null,
          confidenceTier: null,
          explanation: "selected engine unavailable",
        });
      const context = {
        advisoryId: shadowAdvisory.advisoryId || null,
        signalId: signal.signalId || signal.signal_id || null,
        symbol: signal.symbol || null,
        side: signal.side || null,
        advisoryOnly: true,
        authoritativeLayer: "live_bot",
        channel: "live_entry_decision_context",
        shadowOutputs: outputs,
        shadowConsensus: SelectedAdvisor.aggregateShadowOutputs(outputs),
        selected: selectedResult || {
          decision: "ABSTAIN",
          contextId: null,
          explanation: "selected engine returned no result",
        },
        usedForDecision: false,
        generatedAt: new Date().toISOString(),
      };
      this._counters.entryAdvisories++;
      this._recordEntry(context);
      return { accepted: true, enabled: true, ...context };
    } catch (err) {
      this._counters.entryErrors++;
      try { this._log.error(`[SELECTED ADVISOR] entry handshake: ${err.message}`); } catch (_) {}
      return {
        accepted: false,
        enabled: true,
        advisoryOnly: true,
        reason: "selected_advisor_error",
      };
    }
  }

  _schedule(job, attemptIdx) {
    if (this._stopped || attemptIdx >= this._delays.length) return;
    const t = setTimeout(() => {
      this._timers.delete(t);
      this._attempt(job, attemptIdx).catch((err) => {
        // _attempt already swallows everything; this is belt-and-braces.
        this._counters.errors++;
        try { this._log.error(`[SELECTED ADVISOR] attempt: ${err.message}`); } catch (_) {}
      });
    }, this._delays[attemptIdx]);
    if (typeof t.unref === "function") t.unref(); // NEVER keeps the process alive
    this._timers.add(t);
  }

  async _attempt(job, attemptIdx) {
    if (this._stopped) return;
    const isLast = attemptIdx >= this._delays.length - 1;
    try {
      // 1) Recover the signalId from the trade_open event (READ-only SELECT).
      if (!job.signalId) {
        job.signalId = await this._recoverSignalId(job);
      }
      if (!job.signalId) {
        if (isLast) this._record(job, null, attemptIdx, "NO_SIGNAL_ID",
          "no recent trade_open event with a signalId was found for this symbol");
        else this._schedule(job, attemptIdx + 1);
        return;
      }

      // 2) Ask the (read-only) Selected Engine for its opinion on THIS signal.
      const ctx = await this._selectedEngine.buildDecisionContext({ signalId: job.signalId });

      // 3) Empty context ⇒ the research layer has not recorded the signal
      //    (reconciler not yet polled, or SHADOW_LAB_RESEARCH=off). Retry.
      if (!ctx || ctx.id == null || ctx.consensus === "NO_DATA") {
        if (isLast) this._record(job, ctx || null, attemptIdx, "EMPTY_CONTEXT",
          (ctx && ctx.selectedReason) || "selected engine returned no context");
        else this._schedule(job, attemptIdx + 1);
        return;
      }

      // 4) Success — attach the opinion (in memory only).
      this._record(job, ctx, attemptIdx, "OK", null);
    } catch (err) {
      this._counters.errors++;
      try { this._log.error(`[SELECTED ADVISOR] ${job.symbol}: ${err.message}`); } catch (_) {}
      if (isLast) {
        try { this._record(job, null, attemptIdx, "ERROR", err.message); } catch (_) {}
      } else {
        this._schedule(job, attemptIdx + 1);
      }
    }
  }

  // READ-only: newest trade_open event for the symbol, fresh enough to belong
  // to the observed open. Uses db.get ONLY (db.run/db.exec are never touched).
  async _recoverSignalId(job) {
    const row = await this._db.get(
      "SELECT ts, data FROM events WHERE type='trade_open' AND symbol=? ORDER BY id DESC LIMIT 1",
      job.symbol
    );
    if (!row) return null;
    const evTs = Date.parse(row.ts);
    if (Number.isFinite(evTs) && Math.abs(job.observedAt - evTs) > this._staleMs) return null; // stale guard
    const data = SelectedAdvisor.parseData(row.data);
    return data.signalId || null;
  }

  _record(job, ctx, attemptIdx, status, note) {
    const now = new Date();
    // Sprint 7 Phase 1 — normalized OBSERVATIONAL status (purely additive):
    //   OK            — a DecisionContext existed and its opinion was attached
    //   NOT_AVAILABLE — no DecisionContext could be built for this trade
    //                   (no signalId recovered, or the context came back empty)
    //   ERROR         — an exception occurred (swallowed; trading unaffected)
    const normalizedStatus =
      status === "OK" ? "OK" : status === "ERROR" ? "ERROR" : "NOT_AVAILABLE";
    const rankingTop3 = ctx && Array.isArray(ctx.ranking)
      ? ctx.ranking.slice(0, 3).map((r) => ({
          source: r.source, kind: r.kind,
          confidence: r.confidence ?? null, expectancy: r.expectancy ?? null,
        }))
      : [];
    const advisory = {
      // ── identity ──
      signalId:   job.signalId || null,
      symbol:     job.symbol,
      side:       job.side,
      observedAt: new Date(job.observedAt).toISOString(),
      generatedAt: now.toISOString(),
      attempt:    attemptIdx + 1,
      // ── Sprint 7 Phase 1: normalized observational status ──
      status: normalizedStatus,
      // ── the Selected Engine's OPINION (advisory only — never acted upon) ──
      selectedDecision:  ctx ? ctx.consensus : null,          // TRADE / NO_TRADE / SPLIT / ABSTAIN / NO_DATA
      selectedConsensus: ctx ? {
        agreementScore:    ctx.agreementScore ?? null,
        disagreementScore: ctx.disagreementScore ?? null,
        agreeing:   (ctx.consensusDetail && ctx.consensusDetail.agreeing)   || [],
        dissenting: (ctx.consensusDetail && ctx.consensusDetail.dissenting) || [],
        abstaining: (ctx.consensusDetail && ctx.consensusDetail.abstaining) || [],
        decided:    (ctx.consensusDetail && ctx.consensusDetail.decided)    ?? 0,
      } : null,
      selectedConfidence: ctx && ctx.confidence ? {
        tier:    ctx.confidence.tier    ?? null,
        average: ctx.confidence.average ?? null,
      } : null,
      selectedRanking: rankingTop3,
      // Sprint 7 Phase 1 explicit field name (same content as selectedRanking,
      // which is kept for backward compatibility of the advisories payload):
      selectedRankingTop3: rankingTop3,
      selectedEvidenceId: ctx && ctx.evidenceTrace ? (ctx.evidenceTrace.checksum || null) : null,
      selectedReason:     ctx ? (ctx.selectedReason || null) : null,
      contextId:          ctx ? (ctx.id || null) : null,
      // ── Sprint 7 Phase 1: knowledge/market provenance of the opinion ──
      knowledgeVersion: ctx
        ? ((ctx.metadata && ctx.metadata.knowledgeVersion != null ? ctx.metadata.knowledgeVersion : null)
           ?? (ctx.explainability && ctx.explainability.knowledgeVersions
                ? ctx.explainability.knowledgeVersions.max ?? null : null))
        : null,
      knowledgeSnapshot: ctx
        ? ((ctx.metadata && ctx.metadata.snapshotVersion != null ? ctx.metadata.snapshotVersion : null)
           ?? (ctx.explainability && ctx.explainability.knowledgeVersions
                ? ctx.explainability.knowledgeVersions.snapshot ?? null : null))
        : null,
      marketFingerprint: ctx && ctx.explainability && ctx.explainability.evidenceSummary
        ? (ctx.explainability.evidenceSummary.marketFingerprint ?? null)
        : null,
      // When the Selected opinion was captured (strictly AFTER the live trade
      // decision — never on the trading path) + how long after the open.
      selectedDecisionTime: now.toISOString(),
      decisionLatencyMs: now.getTime() - job.observedAt,
      // ── advisor bookkeeping ──
      advisor: { status, note: note || null },
    };
    this._ring.push(advisory);
    while (this._ring.length > this._ringSize) this._ring.shift();
    if (status === "OK") this._counters.advisories++;
    else this._counters.stubs++;
    try {
      this._log.info(
        `[SELECTED ADVISOR] ${job.symbol} ${job.side || ""} → ${advisory.selectedDecision || status}` +
        (advisory.selectedConfidence && advisory.selectedConfidence.tier ? ` (${advisory.selectedConfidence.tier})` : "")
      );
    } catch (_) {}
  }

  _recordEntry(context) {
    const advisory = {
      kind: "entry_handshake",
      signalId: context.signalId,
      symbol: context.symbol,
      side: context.side,
      generatedAt: context.generatedAt,
      status: "OK",
      advisoryOnly: true,
      authoritativeLayer: "live_bot",
      channel: context.channel,
      advisoryId: context.advisoryId,
      shadowOutputs: context.shadowOutputs,
      selected: context.selected,
      usedForDecision: false,
    };
    this._ring.push(advisory);
    while (this._ring.length > this._ringSize) this._ring.shift();
    try {
      this._log.info(
        `[SELECTED ADVISOR] entry ${context.symbol || ""} ${context.side || ""} → ` +
        `${context.selected?.decision || "ABSTAIN"}`
      );
    } catch (_) {}
  }

  // ── Read APIs (in-memory only) ───────────────────────────────────────────────

  /** Newest-first advisory list. */
  getAdvisories(limit = 50) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 50, 1), this._ringSize);
    return this._ring.slice(-n).reverse();
  }

  getStatus() {
    return {
      enabled:  this._enabled,
      stopped:  this._stopped,
      pending:  this._timers.size,
      ring:     { size: this._ring.length, capacity: this._ringSize },
      counters: { ...this._counters },
      attemptDelaysMs: this._delays.slice(),
    };
  }

  /** Resume detached advisory work after a runtime toggle. */
  start() {
    this._enabled = true;
    this._stopped = false;
  }

  /** Clears all pending timers. Idempotent. NEVER throws. */
  stop() {
    try {
      this._enabled = false;
      this._stopped = true;
      for (const t of this._timers) clearTimeout(t);
      this._timers.clear();
    } catch (_) {}
  }
}

module.exports = {
  SelectedAdvisor,
  DEFAULT_ATTEMPT_DELAYS_MS,
  DEFAULT_STALE_MS,
  DEFAULT_RING_SIZE,
};
