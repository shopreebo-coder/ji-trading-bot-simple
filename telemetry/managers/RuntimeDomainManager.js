"use strict";
/**
 * RuntimeDomainManager — SHADOW OS v2, Sprint 1: Runtime Awakening
 *
 * Single owner of all 10 SHADOW OS v2 runtime domains.
 * Gateway between all engines and the runtime_domains PostgreSQL table.
 * Enforces optimistic locking (version field), records a full immutable
 * history of every mutation, and provides snapshot + rollback support.
 *
 * SACRED CONSTRAINT: this class never deletes domain data.
 * Every mutation is recorded. Knowledge is preserved.
 *
 * Usage:
 *   const { RuntimeDomainManager } = require('./managers/RuntimeDomainManager');
 *   const rdm = new RuntimeDomainManager({ connectionString: process.env.DATABASE_URL });
 *   await rdm.init();
 *   const domain = await rdm.getDomain('live');
 *   await rdm.compareAndSwap('live', domain.version, { ...domain.value, dailyTrades: 1 });
 *   await rdm.shutdown();
 *
 * Requirements:
 *   - Migrations 001 and 002 must have been run (runtime_domains + runtime_domain_history)
 *   - DATABASE_URL must point to PostgreSQL 9.6+
 *
 * Thread safety:
 *   All mutations go through PostgreSQL transactions with version checks.
 *   compareAndSwap() is the recommended write path for concurrent engines.
 *   updateDomain() and patchDomain() are safe but non-atomic vs concurrent writers.
 */

const { Pool } = require("pg");
const crypto   = require("crypto");

// ── Default domain values (mirrors runtime_domains bootstrap from migration 001) ─
const DEFAULT_DOMAINS = {
  live:      { dailyTrades: 0, openTrades: {}, date: "", sequence: 0 },
  shadowA:   { signalsSeen: 0, signalsBlocked: 0, lastEvalTs: "", frozen: true },
  shadowB:   { signalsSeen: 0, signalsBlocked: 0, lastEvalTs: "", frozen: true },
  shadowC:   { datasetVersion: 0, datasetSize: 0, lastTrainTs: "", nearestK: 5, accuracy: 0 },
  shadowD:   { weightsVersion: 0, lastTrainTs: "", conditionCount: 0, topConditions: [], confidence: 0 },
  shadowM:   { lastId: 0, active: {}, knownSids: [], pollCount: 0, lastPollTs: "" },
  exitLab:   { strategiesLoaded: [], bestStrategy: "", strategyVersions: {}, evaluationsThisSession: 0 },
  telemetry: { lastEventId: 0, eventCount: 0, errorCount: 0, lastErrorTs: "", dbBackend: "" },
  scheduler: { nextCycleTs: "", lastCycleTs: "", cycleCount: 0, shadowLabInterval: 30000, botPid: null },
  meta:      { systemVersion: "v40.1", schemaVersion: 1, bootCount: 0, uptimeStart: "", lastCleanShutdown: "", status: "HALTED" },
};

const REQUIRED_TABLES = [
  "runtime_domains",
  "runtime_domain_history",
  "system_snapshots",
  "consistency_log",
];

const VALID_CHANGE_OPS = new Set(["CREATE", "UPDATE", "PATCH", "CAS", "RESTORE", "ROLLBACK", "SNAPSHOT"]);
const VALID_SEVERITIES  = new Set(["INFO", "WARN", "ERROR", "CRITICAL"]);

// ── RuntimeDomainManager ──────────────────────────────────────────────────────

class RuntimeDomainManager {
  /**
   * @param {object} options
   * @param {string}  [options.connectionString]  - PostgreSQL connection string (falls back to DATABASE_URL)
   * @param {object}  [options._pool]             - Pre-created pg.Pool (for testing; skips pool creation)
   * @param {number}  [options.maxConnections=5]  - Pool max connections
   * @param {number}  [options.idleTimeout=30000] - Pool idle timeout ms
   * @param {number}  [options.connectTimeout=10000] - Pool connect timeout ms
   * @param {string}  [options.calledBy='system'] - Default change_by for history records
   */
  constructor(options = {}) {
    if (options._pool) {
      this._pool    = options._pool;
      this._ownPool = false;
    } else {
      const connStr = options.connectionString || process.env.DATABASE_URL || "";
      if (!connStr.startsWith("postgres://") && !connStr.startsWith("postgresql://")) {
        throw new Error(
          "RuntimeDomainManager: connectionString must start with postgres:// or postgresql://. " +
          `Got: "${connStr.slice(0, 20)}..."`
        );
      }
      this._pool = new Pool({
        connectionString:        connStr,
        max:                     options.maxConnections    || 5,
        idleTimeoutMillis:       options.idleTimeout       || 30000,
        connectionTimeoutMillis: options.connectTimeout    || 10000,
      });
      this._ownPool = true;
    }

    this._initialized   = false;
    this._callerDefault = options.calledBy || "system";
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Verify that all required tables exist. Must be called before any other method.
   * @returns {{ ok: true, tables: string[] }}
   */
  async init() {
    const { rows } = await this._pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `, [REQUIRED_TABLES]);

    const found   = rows.map(r => r.table_name);
    const missing = REQUIRED_TABLES.filter(t => !found.includes(t));

    if (missing.length > 0) {
      throw new Error(
        `RuntimeDomainManager.init: required tables missing: [${missing.join(", ")}]. ` +
        "Run migrations 001 and 002 first."
      );
    }

    this._initialized = true;
    return { ok: true, tables: found };
  }

  /**
   * Release the connection pool. Call on process shutdown.
   */
  async shutdown() {
    if (this._ownPool && this._pool) {
      await this._pool.end();
    }
    this._initialized = false;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  _checkInit() {
    if (!this._initialized) {
      throw new Error(
        "RuntimeDomainManager: not initialized. Call init() before any other method."
      );
    }
  }

  /**
   * MD5 checksum of a domain value for integrity checks.
   * @param {object} value
   * @returns {string}
   */
  _checksum(value) {
    return crypto.createHash("md5").update(JSON.stringify(value)).digest("hex");
  }

  /**
   * Record one history entry inside a live client transaction.
   * Caller is responsible for BEGIN/COMMIT/ROLLBACK.
   */
  async _recordHistory(client, domain, version, value, changeOp, calledBy, snapshotId = null, notes = null) {
    if (!VALID_CHANGE_OPS.has(changeOp)) {
      throw new Error(`RuntimeDomainManager._recordHistory: invalid changeOp '${changeOp}'`);
    }
    await client.query(
      `INSERT INTO runtime_domain_history
         (domain, version, value, changed_by, change_op, snapshot_id, notes)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
      [
        domain,
        version,
        JSON.stringify(value),
        calledBy || this._callerDefault,
        changeOp,
        snapshotId || null,
        notes || null,
      ]
    );
  }

  // ── Core CRUD ───────────────────────────────────────────────────────────────

  /**
   * Create a domain if it does not already exist.
   * Safe to call even if the domain exists (returns existing row, created=false).
   *
   * @param {string} domain
   * @param {object} initialValue
   * @param {object} [options]
   * @param {number} [options.schemaVer=1]
   * @param {string} [options.calledBy]
   * @param {string} [options.notes]
   * @returns {{ created: boolean, row: object }}
   */
  async createDomain(domain, initialValue, options = {}) {
    this._checkInit();
    if (!domain || typeof domain !== "string") {
      throw new Error("RuntimeDomainManager.createDomain: domain must be a non-empty string");
    }
    if (typeof initialValue !== "object" || initialValue === null || Array.isArray(initialValue)) {
      throw new Error("RuntimeDomainManager.createDomain: initialValue must be a plain object");
    }

    const calledBy  = options.calledBy  || this._callerDefault;
    const schemaVer = options.schemaVer || 1;
    const notes     = options.notes     || `initial value for domain '${domain}'`;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO runtime_domains (domain, version, value, schema_ver)
         VALUES ($1, 0, $2::jsonb, $3)
         ON CONFLICT (domain) DO NOTHING
         RETURNING domain, version, value, updated_at, schema_ver`,
        [domain, JSON.stringify(initialValue), schemaVer]
      );

      if (rows.length > 0) {
        await this._recordHistory(client, domain, 0, initialValue, "CREATE", calledBy, null, notes);
        await client.query("COMMIT");
        return { created: true, row: rows[0] };
      } else {
        await client.query("ROLLBACK");
        const existing = await this.getDomain(domain);
        return { created: false, row: existing };
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read a domain's current state.
   * @param {string} domain
   * @returns {object|null} — { domain, version, value, updated_at, schema_ver } or null
   */
  async getDomain(domain) {
    this._checkInit();
    const { rows } = await this._pool.query(
      `SELECT domain, version, value, updated_at, schema_ver
       FROM runtime_domains WHERE domain = $1`,
      [domain]
    );
    return rows[0] ?? null;
  }

  /**
   * List all domains.
   * @returns {object[]}
   */
  async listDomains() {
    this._checkInit();
    const { rows } = await this._pool.query(
      `SELECT domain, version, value, updated_at, schema_ver
       FROM runtime_domains ORDER BY domain`
    );
    return rows;
  }

  /**
   * Replace an entire domain value. Increments version.
   * Not atomic vs. concurrent writers — use compareAndSwap() for concurrent safety.
   *
   * @param {string} domain
   * @param {object} newValue
   * @param {object} [options]
   * @returns {object} — updated domain row
   */
  async updateDomain(domain, newValue, options = {}) {
    this._checkInit();
    if (typeof newValue !== "object" || newValue === null || Array.isArray(newValue)) {
      throw new Error("RuntimeDomainManager.updateDomain: newValue must be a plain object");
    }

    const calledBy = options.calledBy || this._callerDefault;
    const notes    = options.notes    || null;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `UPDATE runtime_domains
         SET value = $2::jsonb, version = version + 1, updated_at = NOW()
         WHERE domain = $1
         RETURNING domain, version, value, updated_at, schema_ver`,
        [domain, JSON.stringify(newValue)]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error(`RuntimeDomainManager.updateDomain: domain '${domain}' not found`);
      }

      const row = rows[0];
      await this._recordHistory(client, domain, row.version, newValue, "UPDATE", calledBy, null, notes);
      await client.query("COMMIT");
      return row;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Shallow-merge a patch into an existing domain value (PostgreSQL || operator).
   * Top-level keys in patch overwrite existing keys. Increments version.
   *
   * @param {string} domain
   * @param {object} patch — top-level keys to merge
   * @param {object} [options]
   * @returns {object} — updated domain row (full merged value)
   */
  async patchDomain(domain, patch, options = {}) {
    this._checkInit();
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new Error("RuntimeDomainManager.patchDomain: patch must be a plain object");
    }

    const calledBy = options.calledBy || this._callerDefault;
    const notes    = options.notes    || `patch keys: [${Object.keys(patch).join(", ")}]`;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `UPDATE runtime_domains
         SET value = value || $2::jsonb, version = version + 1, updated_at = NOW()
         WHERE domain = $1
         RETURNING domain, version, value, updated_at, schema_ver`,
        [domain, JSON.stringify(patch)]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error(`RuntimeDomainManager.patchDomain: domain '${domain}' not found`);
      }

      const row = rows[0];
      await this._recordHistory(client, domain, row.version, row.value, "PATCH", calledBy, null, notes);
      await client.query("COMMIT");
      return row;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Optimistic Locking ──────────────────────────────────────────────────────

  /**
   * Atomic compare-and-swap.
   * Updates the domain only if its current version matches expectedVersion.
   * If the version has changed (concurrent write detected), returns swapped=false.
   *
   * Recommended usage pattern:
   *   const row = await rdm.getDomain('shadowM');
   *   const result = await rdm.compareAndSwap('shadowM', row.version, newValue);
   *   if (!result.swapped) { // re-read and retry }
   *
   * @param {string} domain
   * @param {bigint|number} expectedVersion
   * @param {object} newValue
   * @param {object} [options]
   * @returns {{ swapped: boolean, currentVersion: number, row: object|null }}
   */
  async compareAndSwap(domain, expectedVersion, newValue, options = {}) {
    this._checkInit();
    if (typeof newValue !== "object" || newValue === null || Array.isArray(newValue)) {
      throw new Error("RuntimeDomainManager.compareAndSwap: newValue must be a plain object");
    }

    const calledBy = options.calledBy || this._callerDefault;
    const notes    = options.notes    || null;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `UPDATE runtime_domains
         SET value = $3::jsonb, version = version + 1, updated_at = NOW()
         WHERE domain = $1 AND version = $2
         RETURNING domain, version, value, updated_at, schema_ver`,
        [domain, expectedVersion, JSON.stringify(newValue)]
      );

      if (rows.length > 0) {
        const row = rows[0];
        await this._recordHistory(client, domain, row.version, newValue, "CAS", calledBy, null, notes);
        await client.query("COMMIT");
        return { swapped: true, currentVersion: Number(row.version), row };
      } else {
        // Read current state BEFORE releasing the connection.
        // Calling this.getDomain() here would request a second connection while
        // the current connection is still held (finally block runs after return),
        // which deadlocks under concurrent CAS with a small pool.
        const { rows: currentRows } = await client.query(
          `SELECT domain, version, value, updated_at, schema_ver
           FROM runtime_domains WHERE domain = $1`,
          [domain]
        );
        await client.query("ROLLBACK");
        const current = currentRows[0] ?? null;
        return {
          swapped:        false,
          currentVersion: current ? Number(current.version) : null,
          row:            current,
        };
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────

  /**
   * Capture all domain values into a system_snapshots row.
   * Also records a SNAPSHOT history entry for each domain (enables restore).
   *
   * @param {string} [reason='manual']
   * @param {object} [options]
   * @param {object} [options.memorySummary]  Output of MemoryManager.summarizeMemory() (Sprint 3)
   * @returns {{ snapshotId: number, createdAt: Date, domainCount: number, reason: string }}
   */
  async takeSnapshot(reason = "manual", options = {}) {
    this._checkInit();
    const calledBy = options.calledBy || this._callerDefault;

    const domains = await this.listDomains();

    // Build runtime_summary: { domain → { version, checksum } }
    const runtimeSummary = {};
    for (const d of domains) {
      runtimeSummary[d.domain] = {
        version:  Number(d.version),
        checksum: this._checksum(d.value),
      };
    }

    // Insert snapshot row
    const { rows: snapRows } = await this._pool.query(
      `INSERT INTO system_snapshots
         (trigger_type, runtime_summary, memory_summary, knowledge_summary, system_status)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5)
       RETURNING id, created_at`,
      [
        reason,
        JSON.stringify(runtimeSummary),
        JSON.stringify(options.memorySummary || { note: "no memory summary provided" }),
        JSON.stringify({ note: "KnowledgeManager not yet implemented (Sprint 4)" }),
        "OPERATIONAL",
      ]
    );

    const snapshotId = Number(snapRows[0].id);
    const createdAt  = snapRows[0].created_at;

    // Record SNAPSHOT history for each domain (in one transaction)
    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      for (const d of domains) {
        await this._recordHistory(
          client, d.domain, Number(d.version), d.value,
          "SNAPSHOT", calledBy, snapshotId,
          `snapshot: ${reason}`
        );
      }
      await client.query("COMMIT");
    } catch (histErr) {
      await client.query("ROLLBACK").catch(() => {});
      // Non-fatal: snapshot row was created; history write failed.
      // restoreFromSnapshot will detect the missing history and throw.
      // Log the issue but don't fail takeSnapshot().
      console.error(`[RuntimeDomainManager] takeSnapshot history write failed: ${histErr.message}`);
    } finally {
      client.release();
    }

    return { snapshotId, createdAt, domainCount: domains.length, reason };
  }

  /**
   * Retrieve a specific snapshot by ID.
   * @param {number} snapshotId
   * @returns {object|null}
   */
  async getSnapshot(snapshotId) {
    this._checkInit();
    const { rows } = await this._pool.query(
      `SELECT id, created_at, trigger_type, runtime_summary,
              memory_summary, knowledge_summary, system_status
       FROM system_snapshots WHERE id = $1`,
      [snapshotId]
    );
    return rows[0] ?? null;
  }

  /**
   * List recent snapshots.
   * @param {number} [limit=10]
   * @returns {object[]}
   */
  async listSnapshots(limit = 10) {
    this._checkInit();
    const { rows } = await this._pool.query(
      `SELECT id, created_at, trigger_type, system_status
       FROM system_snapshots ORDER BY created_at DESC LIMIT $1`,
      [Math.min(limit, 1000)]
    );
    return rows;
  }

  /**
   * Restore domain values from a snapshot.
   * Reads domain values from runtime_domain_history where snapshot_id matches.
   *
   * @param {number} snapshotId
   * @param {string[]} [domains=null] — restore only these domains (null = all)
   * @param {object}   [options]
   * @returns {{ restored: string[], snapshotId: number, fromTrigger: string }}
   */
  async restoreFromSnapshot(snapshotId, domains = null, options = {}) {
    this._checkInit();
    const calledBy = options.calledBy || this._callerDefault;

    const snapshot = await this.getSnapshot(snapshotId);
    if (!snapshot) {
      throw new Error(`RuntimeDomainManager.restoreFromSnapshot: snapshot ${snapshotId} not found`);
    }

    // Fetch domain values from history linked to this snapshot
    let histQuery;
    let histParams;
    if (domains && domains.length > 0) {
      histQuery  = `SELECT DISTINCT ON (domain) domain, version, value
                    FROM runtime_domain_history
                    WHERE snapshot_id = $1 AND domain = ANY($2::text[])
                    ORDER BY domain, id DESC`;
      histParams = [snapshotId, domains];
    } else {
      histQuery  = `SELECT DISTINCT ON (domain) domain, version, value
                    FROM runtime_domain_history
                    WHERE snapshot_id = $1
                    ORDER BY domain, id DESC`;
      histParams = [snapshotId];
    }

    const { rows: histRows } = await this._pool.query(histQuery, histParams);

    if (histRows.length === 0) {
      throw new Error(
        `RuntimeDomainManager.restoreFromSnapshot: no history records found for snapshot ${snapshotId}. ` +
        "The snapshot may have been created before history recording was enabled."
      );
    }

    const restored = [];
    const client   = await this._pool.connect();
    try {
      await client.query("BEGIN");

      for (const hist of histRows) {
        const { rows: updated } = await client.query(
          `UPDATE runtime_domains
           SET value = $2::jsonb, version = version + 1, updated_at = NOW()
           WHERE domain = $1
           RETURNING domain, version`,
          [hist.domain, JSON.stringify(hist.value)]
        );

        if (updated.length > 0) {
          await this._recordHistory(
            client, hist.domain, Number(updated[0].version), hist.value,
            "RESTORE", calledBy, snapshotId,
            `restored from snapshot ${snapshotId} (trigger: ${snapshot.trigger_type})`
          );
          restored.push(hist.domain);
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return { restored, snapshotId, fromTrigger: snapshot.trigger_type };
  }

  // ── Version History & Rollback ──────────────────────────────────────────────

  /**
   * Get the mutation history for a domain, most recent first.
   * @param {string} domain
   * @param {number} [limit=20]
   * @returns {object[]} — runtime_domain_history rows
   */
  async getHistory(domain, limit = 20) {
    this._checkInit();
    const { rows } = await this._pool.query(
      `SELECT id, domain, version, value, changed_at, changed_by, change_op, snapshot_id, notes
       FROM runtime_domain_history
       WHERE domain = $1
       ORDER BY version DESC, id DESC
       LIMIT $2`,
      [domain, Math.min(limit, 10000)]
    );
    return rows;
  }

  /**
   * Rollback a domain to a specific historical version.
   * Reads the value from runtime_domain_history, writes it back as a new version.
   * Does NOT delete any history — the rollback itself is recorded.
   *
   * @param {string} domain
   * @param {bigint|number} targetVersion
   * @param {object} [options]
   * @returns {{ domain, rolledBackTo, currentVersion, restoredValue }}
   */
  async rollback(domain, targetVersion, options = {}) {
    this._checkInit();
    const calledBy = options.calledBy || this._callerDefault;

    // Find the value at targetVersion
    const { rows: histRows } = await this._pool.query(
      `SELECT value FROM runtime_domain_history
       WHERE domain = $1 AND version = $2
       ORDER BY id DESC LIMIT 1`,
      [domain, targetVersion]
    );

    if (histRows.length === 0) {
      throw new Error(
        `RuntimeDomainManager.rollback: no history entry for domain '${domain}' at version ${targetVersion}. ` +
        "Use getHistory() to see available versions."
      );
    }

    const rollbackValue = histRows[0].value;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `UPDATE runtime_domains
         SET value = $2::jsonb, version = version + 1, updated_at = NOW()
         WHERE domain = $1
         RETURNING domain, version, updated_at`,
        [domain, JSON.stringify(rollbackValue)]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error(`RuntimeDomainManager.rollback: domain '${domain}' not found`);
      }

      const row = rows[0];
      await this._recordHistory(
        client, domain, Number(row.version), rollbackValue,
        "ROLLBACK", calledBy, null,
        `rolled back to version ${targetVersion}`
      );
      await client.query("COMMIT");

      return {
        domain,
        rolledBackTo:    Number(targetVersion),
        currentVersion:  Number(row.version),
        restoredValue:   rollbackValue,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Consistency & Audit ─────────────────────────────────────────────────────

  /**
   * Write an entry to consistency_log.
   * @param {string} checkId      — unique identifier for the type of check (e.g. 'rdm.version_negative.live')
   * @param {string} severity     — 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'
   * @param {string} description
   * @param {object} [detail]     — optional JSONB detail
   * @param {object} [options]
   * @param {string} [options.domain]
   * @returns {{ id: number, detectedAt: Date }}
   */
  async logConsistency(checkId, severity, description, detail = null, options = {}) {
    this._checkInit();
    if (!VALID_SEVERITIES.has(severity)) {
      throw new Error(`RuntimeDomainManager.logConsistency: invalid severity '${severity}'`);
    }

    const { rows } = await this._pool.query(
      `INSERT INTO consistency_log (check_id, severity, domain, description, detail)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, detected_at`,
      [
        checkId,
        severity,
        options.domain || null,
        description,
        detail ? JSON.stringify(detail) : null,
      ]
    );

    return { id: Number(rows[0].id), detectedAt: rows[0].detected_at };
  }

  /**
   * Mark a consistency_log entry as resolved.
   * @param {number} id
   * @param {string} resolution
   * @param {object} [options]
   * @param {boolean} [options.autoRepaired=false]
   * @param {object}  [options.repairDetail]
   * @returns {{ id: number, resolvedAt: Date }}
   */
  async resolveConsistency(id, resolution, options = {}) {
    this._checkInit();

    const { rows } = await this._pool.query(
      `UPDATE consistency_log
       SET resolved_at   = NOW(),
           resolution    = $2,
           auto_repaired = $3,
           repair_detail = $4::jsonb
       WHERE id = $1
       RETURNING id, resolved_at`,
      [
        id,
        resolution,
        options.autoRepaired  || false,
        options.repairDetail ? JSON.stringify(options.repairDetail) : null,
      ]
    );

    if (rows.length === 0) {
      throw new Error(`RuntimeDomainManager.resolveConsistency: entry ${id} not found`);
    }

    return { id: Number(rows[0].id), resolvedAt: rows[0].resolved_at };
  }

  /**
   * Run a consistency check across all domains.
   * Logs issues to consistency_log automatically.
   *
   * Checks:
   *   1. domain value is a plain JSON object
   *   2. version is non-negative
   *   3. updated_at is not more than 5 minutes in the future
   *
   * @returns {{ checks: number, domains: number, issues: number, severity: string, detail: [] }}
   */
  async runConsistencyCheck() {
    this._checkInit();
    const domains = await this.listDomains();
    const issues  = [];
    const nowMs   = Date.now();

    for (const d of domains) {
      // Check 1: value is a plain object
      if (typeof d.value !== "object" || d.value === null || Array.isArray(d.value)) {
        const entry = await this.logConsistency(
          `rdm.value_type.${d.domain}`, "ERROR",
          `Domain '${d.domain}' value is not a JSON object (got ${typeof d.value})`,
          { domain: d.domain, valueType: typeof d.value },
          { domain: d.domain }
        );
        issues.push({ domain: d.domain, check: "value_type", severity: "ERROR", logId: entry.id });
      }

      // Check 2: version is non-negative
      if (Number(d.version) < 0) {
        const entry = await this.logConsistency(
          `rdm.version_negative.${d.domain}`, "CRITICAL",
          `Domain '${d.domain}' has a negative version: ${d.version}`,
          { domain: d.domain, version: Number(d.version) },
          { domain: d.domain }
        );
        issues.push({ domain: d.domain, check: "version_negative", severity: "CRITICAL", logId: entry.id });
      }

      // Check 3: updated_at not in the future (> 5 min)
      const updatedMs = new Date(d.updated_at).getTime();
      if (updatedMs > nowMs + 5 * 60 * 1000) {
        const entry = await this.logConsistency(
          `rdm.timestamp_future.${d.domain}`, "WARN",
          `Domain '${d.domain}' has updated_at ${Math.round((updatedMs - nowMs) / 1000)}s in the future`,
          { domain: d.domain, updated_at: d.updated_at },
          { domain: d.domain }
        );
        issues.push({ domain: d.domain, check: "timestamp_future", severity: "WARN", logId: entry.id });
      }
    }

    const severity = issues.length === 0
      ? "OK"
      : issues.some(i => i.severity === "CRITICAL") ? "CRITICAL"
      : issues.some(i => i.severity === "ERROR")    ? "ERROR"
      : "WARN";

    return {
      checks:  domains.length * 3,
      domains: domains.length,
      issues:  issues.length,
      severity,
      detail:  issues,
    };
  }

  // ── Health & Stats ──────────────────────────────────────────────────────────

  /**
   * Quick connectivity check. Does not require init().
   * @returns {{ ok: true, latencyMs: number }}
   */
  async ping() {
    const start = Date.now();
    await this._pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - start };
  }

  /**
   * Return operational statistics.
   * @returns {{ domains, maxVersion, historyRows, snapshots, pool, initialized }}
   */
  async getStats() {
    this._checkInit();
    const [domainRes, histRes, snapRes] = await Promise.all([
      this._pool.query("SELECT COUNT(*) AS n, MAX(version) AS maxver FROM runtime_domains"),
      this._pool.query("SELECT COUNT(*) AS n FROM runtime_domain_history"),
      this._pool.query("SELECT COUNT(*) AS n FROM system_snapshots"),
    ]);

    return {
      domains:     Number(domainRes.rows[0].n),
      maxVersion:  Number(domainRes.rows[0].maxver ?? 0),
      historyRows: Number(histRes.rows[0].n),
      snapshots:   Number(snapRes.rows[0].n),
      pool: {
        total:   this._pool.totalCount,
        idle:    this._pool.idleCount,
        waiting: this._pool.waitingCount,
      },
      initialized: this._initialized,
    };
  }
}

module.exports = { RuntimeDomainManager, DEFAULT_DOMAINS, REQUIRED_TABLES };
