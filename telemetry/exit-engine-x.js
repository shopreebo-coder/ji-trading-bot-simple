"use strict";

/**
 * EXIT ENGINE X
 * ─────────────────────────────────────────────────────────────────────────────
 * Shadow-only intelligent exit decision engine.
 *
 * This module is deliberately isolated from the broker and the live exit
 * executor. It calculates, votes, and records observations only. It cannot
 * close a trade or modify an order.
 */

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = (value, digits = 2) => Number(finite(value).toFixed(digits));
const KNOWLEDGE_MIN_SAMPLE = 30;
const EXIT_ENGINE_X_SCHEMA_VERSION = "1.0";

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedDistance(value, scale) {
  return clamp(1 - Math.abs(finite(value)) / Math.max(scale, 0.0001), 0, 1);
}

function stageFor({ minutesOpen = 0, pips = 0, mfe = 0, closed = false } = {}) {
  if (closed) return "DEATH";
  if (minutesOpen < 0.5) return "BIRTH";
  if (minutesOpen < 1.5) return "DISCOVERY";
  if (mfe > 0 && pips >= mfe * 0.65) return "HARVEST";
  return "EXPANSION";
}

function calculateTradeHealth({
  pips = 0,
  mfe = 0,
  mae = 0,
  atrPips = 0,
  spreadPips = 0,
  minutesOpen = 0,
  trendStrength = 0,
  entryQuality = 0,
  volatilityBucket = null,
} = {}) {
  const atr = Math.max(finite(atrPips), 1);
  const ageScore = clamp(100 - (finite(minutesOpen) / 30) * 100);
  const excursionScore = clamp(50 + (finite(mfe) / atr) * 30 + (finite(mae) / atr) * 20);
  const profitScore = clamp(50 + (finite(pips) / atr) * 35);
  const trendScore = clamp((finite(trendStrength) / 8) * 100);
  const spreadScore = clamp(100 - (Math.max(finite(spreadPips), 0) / atr) * 100);
  const entryScore = clamp(finite(entryQuality) <= 1 ? finite(entryQuality) * 100 : finite(entryQuality));
  const volatilityScore = volatilityBucket === "LOW_VOL"
    ? 75
    : volatilityBucket === "HIGH_VOL"
      ? 45
      : 60;

  const score = (
    excursionScore * 0.22 +
    profitScore * 0.18 +
    ageScore * 0.08 +
    trendScore * 0.16 +
    spreadScore * 0.10 +
    entryScore * 0.14 +
    volatilityScore * 0.12
  );

  return {
    score: round(clamp(score)),
    components: {
      excursion: round(excursionScore),
      profit: round(profitScore),
      age: round(ageScore),
      trend: round(trendScore),
      spread: round(spreadScore),
      entryQuality: round(entryScore),
      volatility: round(volatilityScore),
    },
  };
}

function calculateMomentum({ pips = 0, previousPips = null, previousDelta = null, minutesOpen = 0 } = {}) {
  const current = finite(pips);
  const delta = previousPips === null || previousPips === undefined
    ? 0
    : current - finite(previousPips);
  const acceleration = previousDelta === null || previousDelta === undefined
    ? 0
    : delta - finite(previousDelta);
  const continuation = delta > 0.02 || (delta >= 0 && acceleration >= 0);
  const exhaustion = acceleration < -0.05 || (delta < -0.05 && finite(minutesOpen) > 1);
  const deceleration = acceleration < 0;

  let state = "NEUTRAL";
  if (exhaustion) state = "EXHAUSTION";
  else if (continuation && acceleration > 0.02) state = "ACCELERATION";
  else if (deceleration) state = "DECELERATION";
  else if (continuation) state = "CONTINUATION";

  return {
    state,
    delta: round(delta, 4),
    acceleration: round(acceleration, 4),
    continuation,
    deceleration,
    exhaustion,
  };
}

function calculateExpectedFutureValue({
  pips = 0,
  mfe = 0,
  atrPips = 0,
  minutesOpen = 0,
  momentum = {},
  historicalExpectancy = null,
  knowledgeExpectancy = null,
} = {}) {
  const atr = Math.max(finite(atrPips), 1);
  const roomFromCurrent = Math.max(0, atr * (momentum.continuation ? 0.85 : 0.35));
  const observedGiveback = Math.max(0, finite(mfe) - finite(pips));
  const momentumAdjustment = momentum.exhaustion ? -atr * 0.45 : momentum.deceleration ? -atr * 0.18 : 0;
  const historicalAdjustment = historicalExpectancy === null ? 0 : finite(historicalExpectancy) * 0.35;
  const knowledgeAdjustment = knowledgeExpectancy === null ? 0 : finite(knowledgeExpectancy) * 0.35;
  const ageAdjustment = finite(minutesOpen) > 15 ? -atr * 0.2 : 0;
  const expected = roomFromCurrent - observedGiveback * 0.25 + momentumAdjustment +
    historicalAdjustment + knowledgeAdjustment + ageAdjustment;

  return {
    pips: round(expected),
    range: {
      lower: round(expected - atr * 0.5),
      upper: round(expected + atr * 0.75),
    },
    observedGiveback: round(observedGiveback),
    basis: {
      roomFromCurrent: round(roomFromCurrent),
      momentumAdjustment: round(momentumAdjustment),
      historicalAdjustment: round(historicalAdjustment),
      knowledgeAdjustment: round(knowledgeAdjustment),
      ageAdjustment: round(ageAdjustment),
    },
  };
}

function similarityScore(context, candidate) {
  let score = 0;
  if (context.fingerprint && candidate.fingerprint && context.fingerprint === candidate.fingerprint) score += 0.35;
  if (context.symbol && candidate.symbol && context.symbol === candidate.symbol) score += 0.15;
  if (context.side && candidate.side && context.side === candidate.side) score += 0.10;
  if (context.session && candidate.session && context.session === candidate.session) score += 0.05;
  if (context.trendBucket && candidate.trendBucket && context.trendBucket === candidate.trendBucket) score += 0.10;
  score += normalizedDistance(finite(context.atrPips) - finite(candidate.atrPips), 12) * 0.15;
  score += normalizedDistance(finite(context.spreadPips) - finite(candidate.spreadPips), 2) * 0.10;
  return round(score, 4);
}

function decideExit(votes) {
  const counts = { HOLD: 0, REDUCE: 0, CLOSE: 0 };
  for (const vote of votes) {
    if (counts[vote.decision] !== undefined) counts[vote.decision]++;
  }

  let finalDecision = "HOLD";
  if (counts.CLOSE >= 3 && counts.CLOSE > counts.HOLD) finalDecision = "CLOSE";
  else if (counts.CLOSE + counts.REDUCE >= 3 && counts.CLOSE <= counts.HOLD) finalDecision = "REDUCE";
  else if (counts.REDUCE > counts.HOLD && counts.REDUCE >= 2) finalDecision = "REDUCE";

  return { finalDecision, counts };
}

function calculateExitIQ(bestPossibleExit, actualExit) {
  const best = finite(bestPossibleExit);
  const actual = finite(actualExit);
  if (best <= 0) return actual >= 0 ? 100 : 0;
  return round(clamp((actual / best) * 100));
}

function calculateKnowledgeConfidence({
  sampleSize = 0,
  artifactConfidence = null,
  matched = false,
} = {}) {
  const sample = Math.max(0, Math.trunc(finite(sampleSize)));
  if (!matched || sample < KNOWLEDGE_MIN_SAMPLE) {
    return {
      level: "UNKNOWN",
      score: null,
      sampleSize: sample,
      minimumSample: KNOWLEDGE_MIN_SAMPLE,
      usable: false,
    };
  }
  const raw = artifactConfidence === null || artifactConfidence === undefined
    ? Math.min(100, 40 + Math.log10(Math.max(sample, 1)) * 20)
    : clamp(finite(artifactConfidence) <= 1 ? finite(artifactConfidence) * 100 : finite(artifactConfidence));
  return {
    level: sample >= 300 ? "HIGH" : sample >= 100 ? "MEDIUM" : "LOW",
    score: round(raw),
    sampleSize: sample,
    minimumSample: KNOWLEDGE_MIN_SAMPLE,
    usable: true,
  };
}

function calculateContextMemory({
  context = {},
  similarity = {},
  knowledge = {},
} = {}) {
  const completeness = [
    context.symbol,
    context.side,
    context.session,
    context.trendBucket,
    context.volatilityBucket,
    context.fingerprint,
    context.atrPips,
    context.spreadPips,
  ].filter((value) => value !== null && value !== undefined && value !== "").length / 8;
  const score = clamp(completeness * 55 + finite(similarity.topScore) * 30 +
    (knowledge.matchedFingerprint ? 15 : 0));
  return {
    score: round(score),
    completeness: round(completeness * 100),
    matchedFingerprint: !!knowledge.matchedFingerprint,
    context: {
      symbol: context.symbol || null,
      side: context.side || null,
      session: context.session || null,
      trendBucket: context.trendBucket || null,
      volatilityBucket: context.volatilityBucket || null,
      fingerprint: context.fingerprint || null,
    },
  };
}

function calculateRegretMemory({
  history = [],
  mfe = 0,
  pips = 0,
} = {}) {
  const currentRegret = Math.max(0, finite(mfe) - finite(pips));
  const regrets = history
    .map((item) => finite(item.regretPips, Math.max(0, finite(item.mfe) - finite(item.profitPips))))
    .filter((value) => Number.isFinite(value));
  const averageRegret = regrets.length
    ? regrets.reduce((sum, value) => sum + value, 0) / regrets.length
    : null;
  return {
    score: round(clamp(100 - currentRegret * 10)),
    currentRegret: round(currentRegret),
    averageRegret: averageRegret === null ? null : round(averageRegret),
    historyCount: regrets.length,
    history: regrets.slice(-20).map((value) => round(value)),
  };
}

function calculateOverallConfidence({
  health = {},
  momentum = {},
  efv = {},
  similarity = {},
  knowledgeConfidence = {},
  contextMemory = {},
  regretMemory = {},
  exitIQ = null,
} = {}) {
  const parts = [
    [finite(health.score), 0.30],
    [momentum.exhaustion ? 20 : momentum.continuation ? 85 : 55, 0.15],
    [finite(similarity.topScore) * 100, 0.12],
    [knowledgeConfidence.score === null ? 50 : finite(knowledgeConfidence.score), 0.12],
    [finite(contextMemory.score), 0.10],
    [finite(regretMemory.score), 0.11],
    [exitIQ === null ? 50 : finite(exitIQ), 0.05],
    [clamp(50 + finite(efv.pips) * 10), 0.05],
  ];
  return round(clamp(parts.reduce((sum, [value, weight]) => sum + value * weight, 0)));
}

function normalizeLiveDecision(action) {
  if (action === "REQUEST_CLOSE" || action === "CLOSE") return "CLOSE";
  if (action === "REDUCE") return "REDUCE";
  return "HOLD";
}

function compareWithLiveExit(shadowDecision, liveAction) {
  const liveDecision = normalizeLiveDecision(liveAction);
  return {
    liveAction: liveAction || "HOLD",
    liveDecision,
    shadowDecision,
    same: liveDecision === shadowDecision,
    difference: liveDecision === shadowDecision
      ? "SAME"
      : `${liveDecision}_VS_${shadowDecision}`,
  };
}

class ExitEngineX {
  constructor({ db = null, logEvent = () => {} } = {}) {
    this.db = db;
    this.logEvent = typeof logEvent === "function" ? logEvent : () => {};
    this._states = new Map();
    this._closedKeys = new Set();
    this._history = [];
    this._historyLoadedAt = 0;
    this._knowledge = { activeArtifacts: 0, matches: [], expectancyPips: null };
    this._knowledgeLoadedAt = 0;
  }

  _key(context) {
    return context.signalId || context.tradeId || `${context.symbol || "UNKNOWN"}:${context.entryTime || "UNKNOWN"}`;
  }

  _findState(context) {
    const direct = this._states.get(this._key(context));
    if (direct) return direct;
    for (const state of this._states.values()) {
      if (
        (context.signalId && state.signalId === context.signalId) ||
        (context.tradeId && state.tradeId === context.tradeId)
      ) {
        return state;
      }
    }
    return null;
  }

  async _emit(payload) {
    try {
      await Promise.resolve(this.logEvent({
        engine: "EXIT_ENGINE_X",
        mode: "SHADOW",
        advisoryOnly: true,
        ...payload,
      }));
    } catch (_) {
      // Telemetry failure must never affect the live bot.
    }
  }

  async _loadHistory(now = Date.now()) {
    if (!this.db || now - this._historyLoadedAt < 60000) return;
    this._historyLoadedAt = now;
    try {
      const rows = await this.db.all(
        "SELECT id, type, data FROM events WHERE type IN ('trade_close','trade_forensics','exit_engine_x_close') ORDER BY id DESC LIMIT 2000"
      );
      this._history = (rows || []).map((row) => {
        try {
          const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
          return {
            eventId: row.id,
            eventType: row.type,
            ...data,
            profitPips: finite(data?.profitPips ?? data?.pips),
            mfe: finite(data?.mfe ?? data?.peak),
            mae: finite(data?.mae),
            durationMin: finite(data?.duration ?? data?.minutesOpen),
            atrPips: finite(data?.atrPips ?? data?.entryContext?.atrPips),
            spreadPips: finite(data?.spread ?? data?.entryContext?.spreadPips),
            avgExit: finite(data?.actualExit ?? data?.profitPips ?? data?.pips),
            regretPips: nullableNumber(data?.regretMemory?.difference) ??
              Math.max(
                0,
                finite(data?.mfe ?? data?.peak) -
                finite(data?.profitPips ?? data?.pips)
              ),
          };
        } catch (_) {
          return null;
        }
      }).filter(Boolean);
    } catch (_) {
      this._history = [];
    }
  }

  async _loadKnowledge(now = Date.now()) {
    if (!this.db || now - this._knowledgeLoadedAt < 60000) return;
    this._knowledgeLoadedAt = now;
    try {
      const rows = await this.db.all(
        "SELECT domain, artifact, value, confidence, training_events FROM knowledge_artifacts WHERE superseded_at IS NULL ORDER BY domain, artifact"
      );
      const records = [];
      const walk = (value, metadata = {}) => {
        if (!value || typeof value !== "object") return;
        if (
          value.fingerprint ||
          value.symbol ||
          value.scope ||
          value.expectancyPips !== undefined ||
          value.avgProfitPips !== undefined ||
          value.avgMfe !== undefined ||
          value.avgMfePips !== undefined
        ) {
          records.push({
            ...metadata,
            ...value,
            sampleSize: finite(
              value.sampleSize ??
              value.resolved ??
              value.resolvedTrades ??
              value.signals ??
              metadata.trainingEvents
            ),
            artifactConfidence: metadata.confidence,
          });
        }
        for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, metadata);
      };
      for (const row of rows || []) {
        let value = row.value;
        try { if (typeof value === "string") value = JSON.parse(value); } catch (_) {}
        walk(value, {
          domain: row.domain,
          artifact: row.artifact,
          confidence: row.confidence,
          trainingEvents: row.training_events,
        });
      }
      this._knowledge = {
        activeArtifacts: rows?.length || 0,
        records,
      };
    } catch (_) {
      this._knowledge = { activeArtifacts: 0, records: [] };
    }
  }

  _similarity(context) {
    const ranked = this._history
      .filter((candidate) => !context.signalId || candidate.signalId !== context.signalId)
      .map((candidate) => ({ candidate, score: similarityScore(context, candidate) }))
      .filter((item) => item.score >= 0.45)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    const totalWeight = ranked.reduce((sum, item) => sum + item.score, 0);
    const weighted = (field) => ranked.length
      ? ranked.reduce((sum, item) => sum + finite(item.candidate[field]) * item.score, 0) / totalWeight
      : null;
    return {
      matches: ranked.length,
      topScore: ranked.length ? ranked[0].score : 0,
      similarityScore: ranked.length ? ranked[0].score : 0,
      sampleSize: ranked.length,
      avgMFE: weighted("mfe") === null ? null : round(weighted("mfe")),
      avgMAE: weighted("mae") === null ? null : round(weighted("mae")),
      avgExit: weighted("avgExit") === null ? null : round(weighted("avgExit")),
      expectedOutcome: weighted("profitPips") === null ? null : round(weighted("profitPips")),
      expectancyPips: weighted("profitPips") === null ? null : round(weighted("profitPips")),
      exitHistory: ranked.map(({ candidate, score }) => ({
        signalId: candidate.signalId || null,
        score,
        exitReason: candidate.reason || candidate.liveExitReason || null,
        exitPips: round(candidate.avgExit),
        profitPips: round(candidate.profitPips),
      })),
      examples: ranked.slice(0, 5).map(({ candidate, score }) => ({
        score,
        profitPips: round(candidate.profitPips),
        mfe: round(candidate.mfe),
        mae: round(candidate.mae),
      })),
    };
  }

  _knowledgeResult(context) {
    const matches = (this._knowledge.records || []).filter((item) =>
      (!context.fingerprint || !item.fingerprint || item.fingerprint === context.fingerprint) &&
      (!context.symbol || !item.symbol || item.symbol === context.symbol) &&
      (!context.side || !item.side || item.side === context.side) &&
      (!context.trendBucket || !item.trendBucket || item.trendBucket === context.trendBucket)
    );
    const weighted = (field) => {
      const usable = matches.filter((item) => Number.isFinite(Number(item[field])));
      if (!usable.length) return null;
      const weight = usable.reduce((sum, item) => sum + Math.max(1, finite(item.sampleSize, 1)), 0);
      return usable.reduce((sum, item) =>
        sum + finite(item[field]) * Math.max(1, finite(item.sampleSize, 1)), 0
      ) / weight;
    };
    const sampleSize = matches.reduce((sum, item) => sum + Math.max(0, finite(item.sampleSize)), 0);
    const expectancyPips = weighted("expectancyPips") ??
      weighted("avgProfitPips") ??
      weighted("expectedPips");
    const avgMFE = weighted("avgMfe") ?? weighted("avgMfePips");
    const avgMAE = weighted("avgMae") ?? weighted("avgMaePips");
    const avgExit = weighted("avgExit") ?? expectancyPips;
    const artifactConfidence = matches.length
      ? matches.reduce((sum, item) => sum + finite(item.artifactConfidence), 0) / matches.length
      : null;
    const knowledgeConfidence = calculateKnowledgeConfidence({
      sampleSize,
      artifactConfidence,
      matched: matches.length > 0,
    });
    return {
      activeArtifacts: this._knowledge.activeArtifacts,
      matchedFingerprint: matches.length > 0,
      matches: matches.length,
      sampleSize,
      avgMFE: avgMFE === null ? null : round(avgMFE),
      avgMAE: avgMAE === null ? null : round(avgMAE),
      avgExit: avgExit === null ? null : round(avgExit),
      expectedOutcome: expectancyPips === null ? null : round(expectancyPips),
      expectancyPips: expectancyPips === null ? null : round(expectancyPips),
      exitHistory: matches.slice(0, 20).map((item) => ({
        domain: item.domain || null,
        artifact: item.artifact || null,
        fingerprint: item.fingerprint || null,
        sampleSize: finite(item.sampleSize),
        avgExit: item.avgExit ?? item.avgProfitPips ?? null,
      })),
      regretHistory: this._history
        .filter((item) => item.regretPips !== null && item.regretPips !== undefined)
        .slice(0, 20)
        .map((item) => round(item.regretPips)),
      confidence: knowledgeConfidence,
    };
  }

  _votes({
    health,
    momentum,
    efv,
    similarity,
    knowledge,
    knowledgeConfidence,
    confidence,
    stage,
    contextMemory,
    regretMemory,
    exitIQ,
    pips,
  }) {
    return [
      {
        module: "Trade Health Engine",
        decision: health.score < 25 ? "CLOSE" : health.score < 45 ? "REDUCE" : "HOLD",
        score: health.score,
      },
      {
        module: "Momentum Engine",
        decision: momentum.exhaustion ? (pips > 0 ? "REDUCE" : "CLOSE") : "HOLD",
        score: momentum.exhaustion ? 25 : momentum.continuation ? 80 : 55,
      },
      {
        module: "Expected Future Value Engine",
        decision: efv.pips < -1 ? (pips > 0 ? "REDUCE" : "CLOSE") : efv.pips < 0.25 ? "REDUCE" : "HOLD",
        score: clamp(50 + efv.pips * 10),
      },
      {
        module: "Similarity Engine",
        decision: similarity.expectancyPips !== null && similarity.expectancyPips < -1 ? "REDUCE" : "HOLD",
        score: similarity.topScore * 100,
      },
      {
        module: "Knowledge Engine",
        decision: knowledge.expectancyPips !== null && knowledge.expectancyPips < -1 ? "REDUCE" : "HOLD",
        score: knowledge.expectancyPips === null ? null : clamp(50 + knowledge.expectancyPips * 10),
      },
      {
        module: "Knowledge Confidence Engine",
        decision: knowledgeConfidence.level === "UNKNOWN"
          ? "HOLD"
          : knowledgeConfidence.score < 30 ? "REDUCE" : "HOLD",
        score: knowledgeConfidence.score,
      },
      {
        module: "Confidence Engine",
        decision: confidence < 30 ? (pips > 0 ? "REDUCE" : "CLOSE") : "HOLD",
        score: confidence,
      },
      {
        module: "Lifecycle Engine",
        decision: stage === "HARVEST" && confidence < 45 ? "REDUCE" : "HOLD",
        score: confidence,
      },
      {
        module: "Context Memory Engine",
        decision: contextMemory.score < 25 ? (pips > 0 ? "REDUCE" : "HOLD") : "HOLD",
        score: contextMemory.score,
      },
      {
        module: "Regret Memory Engine",
        decision: regretMemory.currentRegret > Math.max(2, regretMemory.averageRegret || 0) ? "REDUCE" : "HOLD",
        score: regretMemory.score,
      },
      {
        module: "Exit IQ Engine",
        decision: exitIQ < 25 && pips > 0 ? "REDUCE" : "HOLD",
        score: exitIQ,
      },
    ];
  }

  async _emitVotes({ evaluation, votes, decision }) {
    const voteEvents = votes.map((vote, index) => this._emit({
      type: "exit_engine_x_vote",
      evaluationId: `${evaluation.signalId || evaluation.tradeId || "unknown"}:${evaluation.evaluationNumber}`,
      voteIndex: index,
      signalId: evaluation.signalId,
      tradeId: evaluation.tradeId,
      symbol: evaluation.symbol,
      side: evaluation.side,
      module: vote.module,
      vote: vote.decision,
      score: vote.score,
      knowledgeConfidence: evaluation.knowledgeConfidence,
      confidence: evaluation.confidence,
      exitIQ: evaluation.exitIQ,
      expectedFutureValue: evaluation.expectedFutureValue,
      tradeHealth: evaluation.tradeHealth,
      regretScore: evaluation.regretMemory?.score ?? null,
    }));
    voteEvents.push(this._emit({
      type: "exit_engine_x_decision",
      evaluationId: `${evaluation.signalId || evaluation.tradeId || "unknown"}:${evaluation.evaluationNumber}`,
      signalId: evaluation.signalId,
      tradeId: evaluation.tradeId,
      symbol: evaluation.symbol,
      side: evaluation.side,
      decision: decision.finalDecision,
      voteCounts: decision.counts,
      votes,
      liveExitComparison: evaluation.liveExitComparison,
    }));
    await Promise.all(voteEvents);
  }

  async onTradeOpen(context = {}) {
    const key = this._key(context);
    if (this._states.has(key)) return;
    this._closedKeys.delete(key);
    this._states.set(key, {
      ...context,
      key,
      mfe: 0,
      previousPips: null,
      previousDelta: null,
      lastDecision: "HOLD",
      lastStage: "BIRTH",
      lifecycleHistory: ["BIRTH"],
      lastLoggedAt: 0,
      evaluations: 0,
      openedAt: Date.now(),
    });
    await this._emit({
      type: "exit_engine_x_open",
      signalId: context.signalId || null,
      tradeId: context.tradeId || null,
      symbol: context.symbol || null,
      side: context.side || null,
      entryContext: {
        session: context.session || null,
        atrPips: finite(context.atrPips),
        spreadPips: finite(context.spreadPips ?? context.spread),
        trendBucket: context.trendBucket || null,
        fingerprint: context.fingerprint || null,
        entryQuality: finite(context.entryQuality),
      },
    });
  }

  async evaluate(context = {}) {
    const key = this._key(context);
    let state = this._findState(context);
    if (!state) {
      await this.onTradeOpen(context);
      state = this._states.get(key);
    }

    const now = Date.now();
    const pips = finite(context.pips);
    const mfe = Math.max(finite(state.mfe), finite(context.mfe), pips);
    const mae = Math.min(finite(context.mae), finite(state.mae, 0));
    state.mfe = mfe;
    const momentum = calculateMomentum({
      pips,
      previousPips: state.previousPips,
      previousDelta: state.previousDelta,
      minutesOpen: context.minutesOpen,
    });
    const health = calculateTradeHealth({
      ...context,
      pips,
      mfe,
      mae,
      entryQuality: context.entryQuality ?? (finite(context.passCount) / 9),
      spreadPips: context.spreadPips ?? context.spread,
    });
    await Promise.all([this._loadHistory(now), this._loadKnowledge(now)]);
    const similarity = this._similarity({
      ...context,
      atrPips: finite(context.atrPips),
      spreadPips: finite(context.spreadPips ?? context.spread),
    });
    const knowledge = this._knowledgeResult(context);
    const knowledgeConfidence = knowledge.confidence;
    const efv = calculateExpectedFutureValue({
      ...context,
      pips,
      mfe,
      momentum,
      historicalExpectancy: similarity.expectancyPips,
      knowledgeExpectancy: knowledge.expectancyPips,
    });
    const stage = stageFor({
      minutesOpen: context.minutesOpen,
      pips,
      mfe,
    });
    const contextMemory = calculateContextMemory({
      context: {
        ...context,
        spreadPips: context.spreadPips ?? context.spread,
      },
      similarity,
      knowledge,
    });
    const regretMemory = calculateRegretMemory({
      history: this._history,
      mfe,
      pips,
    });
    const exitIQ = calculateExitIQ(mfe, pips);
    const confidence = calculateOverallConfidence({
      health,
      momentum,
      efv,
      similarity,
      knowledgeConfidence,
      contextMemory,
      regretMemory,
      exitIQ,
    });
    const votes = this._votes({
      health,
      momentum,
      efv,
      similarity,
      knowledge,
      knowledgeConfidence,
      confidence,
      stage,
      contextMemory,
      regretMemory,
      exitIQ,
      pips,
    });
    const decision = decideExit(votes);
    const evaluation = {
      schemaVersion: EXIT_ENGINE_X_SCHEMA_VERSION,
      type: "exit_engine_x_evaluation",
      signalId: context.signalId || null,
      tradeId: context.tradeId || null,
      symbol: context.symbol || null,
      side: context.side || null,
      tradeStage: stage,
      tradeHealth: health,
      momentum,
      expectedFutureValue: efv,
      similarity,
      knowledgeResult: knowledge,
      knowledgeConfidence,
      confidence,
      exitIQ,
      regretMemory,
      contextMemory,
      votes,
      decision: decision.finalDecision,
      voteCounts: decision.counts,
      liveAction: context.liveAction || "HOLD",
      shadowRecommendation: decision.finalDecision,
      liveExitComparison: compareWithLiveExit(decision.finalDecision, context.liveAction),
      evaluationNumber: state.evaluations + 1,
      contextSnapshot: {
        session: context.session || null,
        atrPips: finite(context.atrPips),
        spreadPips: finite(context.spreadPips ?? context.spread),
        trendBucket: context.trendBucket || null,
        fingerprint: context.fingerprint || null,
        pips: round(pips),
        mfe: round(mfe),
        mae: round(mae),
        minutesOpen: round(context.minutesOpen),
      },
    };
    state.previousDelta = momentum.delta;
    state.previousPips = pips;
    state.lastDecision = decision.finalDecision;
    state.lastStage = stage;
    state.lastEvaluation = evaluation;
    state.evaluations++;
    if (state.lifecycleHistory[state.lifecycleHistory.length - 1] !== stage) {
      state.lifecycleHistory.push(stage);
      await this._emit({
        type: "exit_engine_x_lifecycle",
        schemaVersion: EXIT_ENGINE_X_SCHEMA_VERSION,
        signalId: evaluation.signalId,
        tradeId: evaluation.tradeId,
        symbol: evaluation.symbol,
        side: evaluation.side,
        from: state.lifecycleHistory[state.lifecycleHistory.length - 2] || null,
        to: stage,
        lifecycleHistory: state.lifecycleHistory.slice(),
      });
    }
    await this._emitVotes({ evaluation, votes, decision });
    if (
      now - state.lastLoggedAt >= 30000 ||
      state.evaluations === 1 ||
      decision.finalDecision !== state.lastLoggedDecision ||
      stage !== state.lastLoggedStage
    ) {
      state.lastLoggedAt = now;
      state.lastLoggedDecision = decision.finalDecision;
      state.lastLoggedStage = stage;
      await this._emit(evaluation);
    }
    return evaluation;
  }

  async onTradeClose(context = {}) {
    const key = this._key(context);
    const state = this._findState(context);
    if (!state && this._closedKeys.has(key)) return null;
    const actualExit = finite(context.actualExitPips ?? context.pips);
    const bestPossibleExit = Math.max(
      finite(context.mfe),
      finite(state?.mfe),
      actualExit,
    );
    const regret = round(Math.max(0, bestPossibleExit - actualExit));
    const exitIQ = calculateExitIQ(bestPossibleExit, actualExit);
    const finalEvaluation = state?.lastEvaluation || null;
    await this._emit({
      type: "exit_engine_x_close",
      signalId: context.signalId || state?.signalId || null,
      tradeId: context.tradeId || state?.tradeId || null,
      symbol: context.symbol || state?.symbol || null,
      side: context.side || state?.side || null,
      actualExit: round(actualExit),
      bestPossibleExit: round(bestPossibleExit),
      exitIQ,
      regretMemory: {
        bestExit: round(bestPossibleExit),
        actualExit: round(actualExit),
        difference: regret,
      },
      expectedFutureValue: finalEvaluation?.expectedFutureValue || null,
      knowledgeResult: finalEvaluation?.knowledgeResult || null,
      knowledgeConfidence: finalEvaluation?.knowledgeConfidence || null,
      confidence: finalEvaluation?.confidence ?? null,
      exitIQ,
      regretScore: regret,
      liveExitComparison: compareWithLiveExit(
        finalEvaluation?.shadowRecommendation || "HOLD",
        context.liveAction || finalEvaluation?.liveAction || "HOLD",
      ),
      shadowRecommendation: finalEvaluation?.shadowRecommendation || "HOLD",
      liveAction: context.liveAction || finalEvaluation?.liveAction || "HOLD",
      liveExitReason: context.reason || null,
      mfe: round(context.mfe ?? state?.mfe),
      mae: round(context.mae),
      durationMin: round(context.minutesOpen),
    });
    this._states.delete(state?.key || key);
    this._closedKeys.add(key);
    if (state?.key) this._closedKeys.add(state.key);
    return { ok: true, exitIQ, regret };
  }
}

module.exports = {
  ExitEngineX,
  calculateTradeHealth,
  calculateMomentum,
  calculateExpectedFutureValue,
  similarityScore,
  decideExit,
  calculateExitIQ,
  calculateKnowledgeConfidence,
  calculateContextMemory,
  calculateRegretMemory,
  calculateOverallConfidence,
  compareWithLiveExit,
  stageFor,
};