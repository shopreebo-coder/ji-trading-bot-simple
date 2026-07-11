"use strict";
/**
 * LiveMemoryIntegration — Sprint 4 "LIVE MEMORY INTEGRATION"
 * ============================================================================
 * Wires the Sprint 1–3 manager tier (RuntimeDomainManager + TradeIntentManager
 * + MemoryManager) into the running Live Engine (telemetry/server.js).
 *
 * Design contract (MASTER_ARCHITECTURE §1.2, IMPLEMENTATION_BLUEPRINT §1.2):
 *
 *   1. BEST-EFFORT, NEVER-BLOCKING. No method on this class ever throws to the
 *      caller. A memory-layer failure must NEVER break trading. Every public
 *      method resolves with a result object; errors are captured, counted, and
 *      logged to consistency_log where possible.
 *
 *   2. OBSERVE-ONLY THIS SPRINT. recoverOnStartup() recovers the full v2 state
 *      (snapshot → runtime domains → open intents → memory summary) and logs
 *      drift against server.js's replay-built `live` object, but does NOT
 *      mutate it. Read switchover happens only after the 48–72h drift-free
 *      gate (blueprint §1.2 Step C→D).
 *
 *   3. SACRED CONSTRAINT. Nothing here deletes history or knowledge. Invalid
 *      snapshots are skipped and logged — never removed. Corrupted memories
 *      are quarantined by MemoryManager.validateMemory — never deleted.
 *
 *   4. IDEMPOTENT WRITES. Every memory event carries a dedupe_key so that
 *      duplicate startups, restart loops, or replayed hooks can never write
 *      the same event twice (memory_events dedupe_key unique partial index).
 *
 *   5. DUPLICATE-STARTUP PROTECTION. A pg advisory lock (session-scoped, held
 *      on a DEDICATED standalone client — never a pool client, which would
 *      both shrink the pool and silently drop the lock on recycle) ensures
 *      only one process performs recovery + periodic persistence. A second
 *      process degrades to read-only observation and keeps serving.
 *
 * Kill switch: server.js gates construction on SHADOW_OS_MEMORY !== "off".
 * Disabling the flag restores pre-Sprint-4 behavior exactly (blueprint:
 * "reverting is as simple as disabling one flag").
 */

const { Client, Pool } = require("pg");
const { RuntimeDomainManager } = require("./RuntimeDomainManager");
const { TradeIntentManager }   = require("./TradeIntentManager");
const { MemoryManager }        = require("./MemoryManager");
const { ensureSchema }         = require("../migrations/autoMigrate");

// Advisory lock identity (classid, objid) — constant across all deployments.
// 21320 = 0x5348 ("SH"), 20307 = 0x4F53 ("OS") → "SHOS".
const LOCK_CLASS = 21320;
const LOCK_OBJ   = 20307;

// Intent statuses considered "open" (non-terminal, pre-execution).
const OPEN_INTENT_STATUSES = ["CREATED", "VALIDATED", "APPROVED"];

// How many recent snapshots the recovery walk-back inspects before giving up
// and proceeding with a fresh (no-snapshot) recovery.
const SNAPSHOT_WALKBACK_LIMIT = 20;

class LiveMemoryIntegration {
  /**
   * @param {object}  [options]
   * @param {string}  [options.connectionString]  Postgres URL (default env DATABASE_URL)
   * @param {object}  [options._pool]             Pre-created pg.Pool (tests)
   * @param {number}  [options.maxConnections=5]
   * @param {string}  [options.calledBy='live-memory-integration']
   * @param {boolean} [options.enabled=true]      When false every method is a no-op
   */
  constructor(options = {}) {
    this._enabled  = options.enabled !== false;
    this._ready    = false;
    this._shuttingDown = false;
    this._hasLock  = false;

    this._calledBy = options.calledBy || "live-memory-integration";
    this._bootId   = `${process.pid}:${new Date().toISOString()}`;

    this._connStr  = options.connectionString != null
      ? options.connectionString
      : (process.env.DATABASE_URL || "");

    this._poolOpt  = options._pool || null;
    this._maxConn  = options.maxConnections ?? 5;

    this._pool = null;   // shared by all three managers
    this._lockClient = null; // dedicated standalone client for the advisory lock

    this.rdm = null;
    this.tim = null;
    this.mm  = null;

    this._inflight = new Set();      // in-flight write promises (flush on shutdown)
    this._persistTimer = null;
    this._persistRunning = false;

    this._counters = {
      eventsRecorded:   0,
      eventsDeduped:    0,
      writeErrors:      0,
      periodicRuns:     0,
      periodicErrors:   0,
    };
    this._lastRecovery = null;
    this._lastError    = null;
    this._schema       = null;   // Sprint 4.1: last ensureSchema() summary
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Builds the shared pool + all three managers and verifies schema.
   * NEVER throws — on any failure the instance degrades to a disabled no-op
   * so that a bad DATABASE_URL can never crash the orchestrator.
   *
   * @returns {Promise<{ok: boolean, enabled: boolean, error?: string}>}
   */
  async init() {
    if (!this._enabled) return { ok: false, enabled: false, error: "disabled by flag" };
    try {
      if (this._poolOpt) {
        this._pool = this._poolOpt;
        this._ownPool = false;
      } else {
        if (!this._connStr.startsWith("postgres://") && !this._connStr.startsWith("postgresql://")) {
          throw new Error("DATABASE_URL missing or not a postgres:// URL");
        }
        this._pool = new Pool({
          connectionString:        this._connStr,
          max:                     this._maxConn,
          idleTimeoutMillis:       30000,
          connectionTimeoutMillis: 10000,
        });
        this._ownPool = true;
      }

      // Sprint 4.1: on a self-owned pool (real server startup — tests inject
      // _pool and skip this), auto-create the full SHADOW OS v2 schema before
      // any manager queries it. This makes a freshly-attached Railway
      // PostgreSQL service fully usable on first boot. A failure here
      // propagates to the catch below and degrades to no-op — never blocks
      // trading (sacred constraint).
      if (this._ownPool) {
        this._schema = await ensureSchema(this._pool, {
          log: (m) => console.log(`[MEMORY-INTEGRATION] migrate: ${m}`),
        });
      }

      this.rdm = new RuntimeDomainManager({ _pool: this._pool, calledBy: this._calledBy });
      this.tim = new TradeIntentManager({ _pool: this._pool, calledBy: this._calledBy, rdm: this.rdm });
      this.mm  = new MemoryManager({ _pool: this._pool, calledBy: this._calledBy, rdm: this.rdm });

      await this.rdm.init();
      await this.tim.init();
      await this.mm.init();

      this._ready = true;
      return { ok: true, enabled: true };
    } catch (err) {
      // Degrade to no-op. Do not keep half-initialized resources.
      this._lastError = `init: ${err.message}`;
      try { if (this._ownPool && this._pool) await this._pool.end(); } catch (_) {}
      this._pool = null;
      this._enabled = false;
      this._ready   = false;
      return { ok: false, enabled: false, error: err.message };
    }
  }

  get isActive() { return this._enabled && this._ready && !this._shuttingDown; }

  // ── Duplicate-startup protection ────────────────────────────────────────────

  /**
   * Tries to become the recovery/persistence owner via a session-scoped pg
   * advisory lock held on a dedicated standalone client for process lifetime.
   * @returns {Promise<{acquired: boolean, error?: string}>}
   */
  async _acquireLock() {
    if (this._hasLock) return { acquired: true };
    try {
      this._lockClient = new Client({ connectionString: this._connStr });
      await this._lockClient.connect();
      // If the lock connection dies, we must not crash the orchestrator.
      this._lockClient.on("error", () => { this._hasLock = false; });
      const { rows } = await this._lockClient.query(
        "SELECT pg_try_advisory_lock($1, $2) AS locked", [LOCK_CLASS, LOCK_OBJ]
      );
      this._hasLock = rows[0].locked === true;
      if (!this._hasLock) {
        // Loser keeps no connection open — it will never persist.
        await this._lockClient.end().catch(() => {});
        this._lockClient = null;
      }
      return { acquired: this._hasLock };
    } catch (err) {
      this._lastError = `lock: ${err.message}`;
      try { if (this._lockClient) await this._lockClient.end(); } catch (_) {}
      this._lockClient = null;
      this._hasLock = false;
      return { acquired: false, error: err.message };
    }
  }

  // ── Snapshot integrity ──────────────────────────────────────────────────────

  /**
   * Validates one snapshot row against runtime_domain_history:
   *   - runtime_summary must be an object of {domain: {version, checksum}}
   *   - every summarized domain must have a matching history row for this
   *     snapshot with the same version and a value whose MD5 checksum matches
   * Read-only. Never repairs, never deletes.
   *
   * @param {object} snap  Row from rdm.getSnapshot()
   * @returns {Promise<{valid: boolean, problems: string[]}>}
   */
  async validateSnapshot(snap) {
    const problems = [];
    if (!snap || typeof snap !== "object") return { valid: false, problems: ["snapshot row missing"] };

    const summary = snap.runtime_summary;
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
      return { valid: false, problems: ["runtime_summary is not an object"] };
    }
    const domains = Object.keys(summary);
    for (const d of domains) {
      const meta = summary[d];
      if (!meta || !Number.isFinite(Number(meta.version)) || typeof meta.checksum !== "string") {
        problems.push(`domain '${d}': malformed summary entry`);
      }
    }
    if (problems.length) return { valid: false, problems };

    const { rows } = await this._pool.query(
      `SELECT domain, version, value FROM runtime_domain_history WHERE snapshot_id = $1`,
      [snap.id]
    );
    const byDomain = new Map(rows.map(r => [r.domain, r]));

    for (const d of domains) {
      const hist = byDomain.get(d);
      if (!hist) { problems.push(`domain '${d}': no history row for snapshot ${snap.id}`); continue; }
      if (Number(hist.version) !== Number(summary[d].version)) {
        problems.push(`domain '${d}': version mismatch (summary=${summary[d].version} history=${hist.version})`);
        continue;
      }
      const checksum = this.rdm._checksum(hist.value);
      if (checksum !== summary[d].checksum) {
        problems.push(`domain '${d}': checksum mismatch (summary=${summary[d].checksum} computed=${checksum})`);
      }
    }
    return { valid: problems.length === 0, problems };
  }

  /**
   * Walks recent snapshots newest→oldest and returns the first that passes
   * integrity validation. Invalid snapshots are logged to consistency_log and
   * SKIPPED — never deleted (Sacred Constraint).
   *
   * @returns {Promise<{snapshot: object|null, skipped: Array<{id, problems}>}>}
   */
  async findLatestValidSnapshot() {
    const skipped = [];
    const recent = await this.rdm.listSnapshots(SNAPSHOT_WALKBACK_LIMIT);
    for (const s of recent) {
      const snap = await this.rdm.getSnapshot(s.id);
      const { valid, problems } = await this.validateSnapshot(snap);
      if (valid) return { snapshot: snap, skipped };
      skipped.push({ id: Number(s.id), problems });
      await this.rdm.logConsistency(
        "recovery:snapshot_invalid", "ERROR",
        `LiveMemoryIntegration: snapshot ${s.id} failed integrity validation — skipped (never deleted)`,
        { snapshotId: Number(s.id), problems }
      ).catch(() => {});
    }
    return { snapshot: null, skipped };
  }

  // ── Startup recovery ────────────────────────────────────────────────────────

  /**
   * The Sprint 4 startup sequence. OBSERVE-ONLY: recovers the full v2 state
   * and logs drift vs. the replay-built live object, but does not mutate it.
   *
   * Steps:
   *   1. Advisory lock (duplicate/concurrent startup protection)
   *   2. Memory integrity validation (quarantine, never delete)
   *   3. Latest VALID snapshot (integrity-checked, walk-back on corruption)
   *   4. Runtime domain state (authoritative v2 state)
   *   5. Open trade intents
   *   6. Memory summary
   *   7. Drift comparison vs. server.js live object (logged, not applied)
   *   8. Idempotent SYSTEM_RECOVERY memory event (dedupe_key per boot)
   *   9. post_recovery snapshot
   *
   * @param {object} [opts]
   * @param {object} [opts.liveState]  server.js `live` object for drift check
   * @returns {Promise<object>} structured recovery report — never throws
   */
  async recoverOnStartup(opts = {}) {
    if (!this.isActive) return { recovered: false, reason: this._enabled ? "not-ready" : "disabled" };
    const t0 = Date.now();
    const report = {
      recovered: false, reason: null, bootId: this._bootId,
      lockAcquired: false, quarantined: 0, snapshotId: null, snapshotsSkipped: 0,
      domains: {}, openIntents: 0, memoryTotal: null, drift: null,
      postRecoverySnapshotId: null, durationMs: null,
    };
    try {
      // 1. Duplicate-startup protection
      const lock = await this._acquireLock();
      report.lockAcquired = lock.acquired;
      if (!lock.acquired) {
        report.reason = lock.error ? `lock-error: ${lock.error}` : "lock-held-by-other-process";
        console.warn(`[MEMORY-INTEGRATION] Recovery skipped — ${report.reason}. Continuing in observe-only mode.`);
        await this.rdm.logConsistency(
          "recovery:duplicate_startup", "WARN",
          `LiveMemoryIntegration: startup ${this._bootId} did not acquire recovery lock — recovery skipped`,
          { bootId: this._bootId, reason: report.reason }
        ).catch(() => {});
        report.durationMs = Date.now() - t0;
        return report;
      }

      // 2. Memory integrity validation — quarantines structural corruption
      const validation = await this.mm.validateMemory({ calledBy: this._calledBy });
      report.quarantined = validation.corrupted.length;

      // 3. Latest valid snapshot (integrity-checked walk-back)
      const { snapshot, skipped } = await this.findLatestValidSnapshot();
      report.snapshotId       = snapshot ? Number(snapshot.id) : null;
      report.snapshotsSkipped = skipped.length;

      // 4. Runtime domain state (current authoritative v2 state)
      const domains = await this.rdm.listDomains();
      for (const d of domains) {
        report.domains[d.domain] = { version: Number(d.version), value: d.value };
      }

      // 5. Open trade intents
      let openIntents = [];
      for (const status of OPEN_INTENT_STATUSES) {
        const rows = await this.tim.listIntents({ status, limit: 1000 });
        openIntents = openIntents.concat(rows);
      }
      report.openIntents = openIntents.length;

      // 6. Memory summary
      const summary = await this.mm.summarizeMemory();
      report.memoryTotal = summary.total;

      // 7. Drift comparison (observe-only — logged, never applied)
      if (opts.liveState && report.domains.live) {
        report.drift = this._compareLiveState(opts.liveState, report.domains.live.value);
        if (report.drift.hasDrift) {
          await this.rdm.logConsistency(
            "recovery:live_drift", "WARN",
            "LiveMemoryIntegration: drift between replay-built live state and runtime_domains 'live'",
            report.drift
          ).catch(() => {});
        }
      }

      // 8. Idempotent recovery event (duplicate recovery can never double-write)
      const rec = await this.mm.createMemory({
        event_type: "SYSTEM_RECOVERY",
        runtime_domain: "live",
        importance: 0.9,
        tags: ["recovery", "sprint4", "startup"],
        source: this._calledBy,
        dedupe_key: `system_recovery:${this._bootId}`,
        payload: {
          bootId:           this._bootId,
          snapshotId:       report.snapshotId,
          snapshotsSkipped: report.snapshotsSkipped,
          quarantined:      report.quarantined,
          domains:          Object.keys(report.domains),
          openIntents:      report.openIntents,
          memoryTotal:      report.memoryTotal,
          drift:            report.drift,
        },
        reasoning: "Sprint 4 startup recovery sequence",
      });
      if (rec.duplicate) this._counters.eventsDeduped++;

      // 9. Post-recovery snapshot
      const snap = await this.rdm.takeSnapshot("post_recovery", {
        calledBy: this._calledBy,
        memorySummary: this._trimSummary(summary),
      });
      report.postRecoverySnapshotId = snap.snapshotId;

      report.recovered  = true;
      report.reason     = "ok";
      report.durationMs = Date.now() - t0;
      this._lastRecovery = report;
      console.log(
        `[MEMORY-INTEGRATION] Recovery complete in ${report.durationMs}ms — ` +
        `snapshot=${report.snapshotId ?? "none"} domains=${Object.keys(report.domains).length} ` +
        `openIntents=${report.openIntents} memories=${report.memoryTotal} quarantined=${report.quarantined}` +
        (report.drift?.hasDrift ? " [DRIFT LOGGED]" : "")
      );
      return report;
    } catch (err) {
      this._lastError = `recovery: ${err.message}`;
      report.reason = `error: ${err.message}`;
      report.durationMs = Date.now() - t0;
      console.error(`[MEMORY-INTEGRATION] Recovery failed (trading unaffected): ${err.message}`);
      if (this.rdm) {
        await this.rdm.logConsistency(
          "recovery:failed", "ERROR",
          `LiveMemoryIntegration: recovery failed — ${err.message}`,
          { bootId: this._bootId, error: err.message }
        ).catch(() => {});
      }
      return report;
    }
  }

  /** Field-by-field drift comparison between replay-built and v2 live state. */
  _compareLiveState(replayLive, domainValue) {
    const drift = { hasDrift: false, fields: [] };
    const v = domainValue || {};
    if (typeof v.dailyTrades === "number" && typeof replayLive.dailyTrades === "number"
        && v.dailyTrades !== replayLive.dailyTrades) {
      drift.fields.push({ field: "dailyTrades", replay: replayLive.dailyTrades, domain: v.dailyTrades });
    }
    const replayOpen = Object.keys(replayLive.openTrades || {}).sort();
    const domainOpen = Object.keys(v.openTrades || {}).sort();
    if (JSON.stringify(replayOpen) !== JSON.stringify(domainOpen)) {
      drift.fields.push({ field: "openTrades", replay: replayOpen, domain: domainOpen });
    }
    drift.hasDrift = drift.fields.length > 0;
    return drift;
  }

  /** Keeps snapshot memory summaries bounded. */
  _trimSummary(summary) {
    if (!summary) return { note: "summary unavailable" };
    return {
      total:       summary.total,
      byStatus:    summary.byStatus,
      byEventType: summary.byEventType,
      historyRows: summary.historyRows,
      generatedAt: summary.generatedAt,
    };
  }

  // ── Runtime event hooks (called from server.js — always fire-safe) ──────────

  /**
   * Internal: run a memory write best-effort, tracked for shutdown flush.
   * Returns a promise that NEVER rejects.
   */
  _track(label, fn) {
    if (!this.isActive) return Promise.resolve({ ok: false, reason: "inactive" });
    const p = (async () => {
      try {
        const out = await fn();
        if (out && out.duplicate) this._counters.eventsDeduped++;
        else this._counters.eventsRecorded++;
        return { ok: true, out };
      } catch (err) {
        this._counters.writeErrors++;
        this._lastError = `${label}: ${err.message}`;
        console.error(`[MEMORY-INTEGRATION] ${label} failed (trading unaffected): ${err.message}`);
        return { ok: false, error: err.message };
      }
    })();
    this._inflight.add(p);
    p.finally(() => this._inflight.delete(p));
    return p;
  }

  /** Minute-bucket helper for deterministic dedupe keys from stdout parsing. */
  _minuteBucket(ts) {
    return new Date(ts || Date.now()).toISOString().slice(0, 16);
  }

  /** Trade opened (parsed from bot stdout). Idempotent per symbol+side+minute. */
  recordTradeOpen({ symbol, side, at } = {}) {
    return this._track("recordTradeOpen", () => this.mm.createMemory({
      event_type: "TRADE_OPENED",
      runtime_domain: "live",
      symbol,
      importance: 0.8,
      tags: ["trade", "open", "live-engine"],
      source: this._calledBy,
      occurred_at: at ? new Date(at).toISOString() : undefined,
      dedupe_key: `trade_open:${symbol}:${side}:${this._minuteBucket(at)}`,
      payload: { symbol, side, bootId: this._bootId },
    }).then(r => r));
  }

  /** Trade closed (parsed from bot EXIT block). Idempotent per symbol+minute. */
  recordTradeClose({ symbol, reason, profit, peak, minutes, breakEven, at } = {}) {
    return this._track("recordTradeClose", () => this.mm.createMemory({
      event_type: "TRADE_CLOSED",
      runtime_domain: "live",
      symbol,
      importance: 0.8,
      tags: ["trade", "close", "live-engine"],
      source: this._calledBy,
      occurred_at: at ? new Date(at).toISOString() : undefined,
      dedupe_key: `trade_close:${symbol}:${this._minuteBucket(at)}`,
      payload: {
        symbol, reason: reason ?? null,
        profit: profit != null ? Number(profit) : null,
        peak: peak != null ? Number(peak) : null,
        minutes: minutes != null ? Number(minutes) : null,
        breakEven: breakEven === true || breakEven === "true",
        bootId: this._bootId,
      },
    }));
  }

  /** Bot child process restart (crash loop / scheduled). Idempotent per boot+count. */
  recordBotRestart({ exitCode, restartCount, delayMs } = {}) {
    return this._track("recordBotRestart", () => this.mm.createMemory({
      event_type: "BOT_RESTART",
      runtime_domain: "live",
      importance: 0.6,
      tags: ["lifecycle", "restart", "live-engine"],
      source: this._calledBy,
      dedupe_key: `bot_restart:${this._bootId}:${restartCount}`,
      payload: { exitCode: exitCode ?? null, restartCount, delayMs, bootId: this._bootId },
    }));
  }

  // ── Periodic persistence ────────────────────────────────────────────────────

  /**
   * Starts the periodic persistence loop (snapshot + KV GC). Only the lock
   * holder persists. Timer is unref'd so it can never hold the process open.
   * @param {number} [intervalMs=300000]  5 minutes
   */
  startPeriodicPersistence(intervalMs = 300000) {
    if (!this.isActive || !this._hasLock || this._persistTimer) return false;
    this._persistTimer = setInterval(() => { this._periodicTick(); }, intervalMs);
    if (typeof this._persistTimer.unref === "function") this._persistTimer.unref();
    console.log(`[MEMORY-INTEGRATION] Periodic persistence every ${Math.round(intervalMs / 1000)}s`);
    return true;
  }

  async _periodicTick() {
    if (!this.isActive || !this._hasLock || this._persistRunning) return;
    this._persistRunning = true;
    try {
      const summary = await this.mm.summarizeMemory();
      await this.rdm.takeSnapshot("periodic", {
        calledBy: this._calledBy,
        memorySummary: this._trimSummary(summary),
      });
      await this.mm.kvGc();
      this._counters.periodicRuns++;
    } catch (err) {
      this._counters.periodicErrors++;
      this._lastError = `periodic: ${err.message}`;
      console.error(`[MEMORY-INTEGRATION] Periodic persistence failed (will retry next tick): ${err.message}`);
    } finally {
      this._persistRunning = false;
    }
  }

  // ── Graceful shutdown ───────────────────────────────────────────────────────

  /**
   * Flush pending memory → final snapshot → validate → release lock → close.
   * Bounded by timeoutMs. NEVER throws; never blocks process exit — the
   * caller enforces its own hard exit deadline on top of this.
   *
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=4000]
   * @param {string} [opts.reason='shutdown']
   * @returns {Promise<{ok: boolean, steps: object}>}
   */
  async gracefulShutdown(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 4000;
    const reason    = opts.reason || "shutdown";
    const steps = { flushed: false, finalEvent: false, finalSnapshot: false, consistent: null, lockReleased: false };

    if (this._shuttingDown) return { ok: true, steps, note: "already shutting down" };
    this._shuttingDown = true;
    if (this._persistTimer) { clearInterval(this._persistTimer); this._persistTimer = null; }
    if (!this._ready) return { ok: false, steps, note: "never initialized" };

    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(deadline - Date.now(), 0);
    const bounded = (p) => Promise.race([
      p,
      new Promise(res => setTimeout(() => res({ timedOut: true }), remaining()).unref?.()),
    ]);

    try {
      // 1. Flush in-flight writes (MM writes are unbuffered — flush = drain)
      await bounded(Promise.allSettled([...this._inflight]));
      steps.flushed = true;

      if (this._hasLock) {
        // 2. Final shutdown event (idempotent per boot)
        const ev = await bounded(this.mm.createMemory({
          event_type: "SYSTEM_SHUTDOWN",
          runtime_domain: "live",
          importance: 0.7,
          tags: ["lifecycle", "shutdown"],
          source: this._calledBy,
          dedupe_key: `system_shutdown:${this._bootId}`,
          payload: { bootId: this._bootId, reason, counters: this._counters },
        }).catch(err => ({ error: err.message })));
        steps.finalEvent = !!(ev && !ev.timedOut && !ev.error);

        // 3. Final snapshot with memory summary
        const summary = await bounded(this.mm.summarizeMemory().catch(() => null));
        const snap = await bounded(this.rdm.takeSnapshot("shutdown", {
          calledBy: this._calledBy,
          memorySummary: (summary && !summary.timedOut) ? this._trimSummary(summary) : { note: "summary unavailable at shutdown" },
        }).catch(err => ({ error: err.message })));
        steps.finalSnapshot = !!(snap && !snap.timedOut && !snap.error);
        steps.finalSnapshotId = snap && snap.snapshotId ? snap.snapshotId : null;

        // 4. Consistency validation (bounded, non-blocking)
        const check = await bounded(this.rdm.runConsistencyCheck().catch(() => null));
        steps.consistent = (check && !check.timedOut && check.severity != null)
          ? check.severity === "OK"
          : null;
      }

      return { ok: true, steps };
    } catch (err) {
      this._lastError = `shutdown: ${err.message}`;
      return { ok: false, steps, error: err.message };
    } finally {
      // 5. Release advisory lock + close connections — never blocks exit
      try {
        if (this._lockClient) {
          await this._lockClient.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_CLASS, LOCK_OBJ]).catch(() => {});
          await this._lockClient.end().catch(() => {});
          steps.lockReleased = true;
        }
      } catch (_) {}
      this._lockClient = null;
      this._hasLock = false;
      try { if (this._ownPool && this._pool) await this._pool.end(); } catch (_) {}
      console.log(`[MEMORY-INTEGRATION] Shutdown complete (${reason}) — flushed=${steps.flushed} snapshot=${steps.finalSnapshot}`);
    }
  }

  // ── Introspection ───────────────────────────────────────────────────────────

  getStatus() {
    return {
      enabled:      this._enabled,
      ready:        this._ready,
      active:       this.isActive,
      hasLock:      this._hasLock,
      shuttingDown: this._shuttingDown,
      bootId:       this._bootId,
      counters:     { ...this._counters },
      inflight:     this._inflight.size,
      lastRecovery: this._lastRecovery ? {
        recovered:  this._lastRecovery.recovered,
        reason:     this._lastRecovery.reason,
        snapshotId: this._lastRecovery.snapshotId,
        durationMs: this._lastRecovery.durationMs,
      } : null,
      lastError: this._lastError,
      schema: this._schema ? {
        ok:      this._schema.ok,
        applied: this._schema.applied,
        skipped: this._schema.skipped,
      } : null,
    };
  }
}

module.exports = { LiveMemoryIntegration, LOCK_CLASS, LOCK_OBJ, OPEN_INTENT_STATUSES, SNAPSHOT_WALKBACK_LIMIT };
