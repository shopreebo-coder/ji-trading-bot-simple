"use strict";
/**
 * TradeIntentManager — SHADOW OS v2, Sprint 2: Intent Foundation
 *
 * Sole owner of all trade intents in the SHADOW OS v2 decision layer.
 * No order may reach the Live Engine without first existing as a
 * committed trade intent in this manager.
 *
 * Intent Lifecycle (enforced state machine):
 *   CREATED → VALIDATED → APPROVED → EXECUTED → ARCHIVED
 *                       → REJECTED → ARCHIVED
 *        → CANCELLED → ARCHIVED (from CREATED, VALIDATED, or APPROVED)
 *
 * Every state transition is:
 *   • Atomic     (PostgreSQL SELECT FOR UPDATE + UPDATE in same transaction)
 *   • Audited    (trade_intent_history append-only record in same transaction)
 *   • Versioned  (monotonic version counter incremented on every transition)
 *   • Permanent  (history is never deleted — Sacred Constraint)
 *
 * SACRED CONSTRAINT: this class never deletes intent data.
 * Every mutation is recorded. The full reasoning behind every
 * approved, rejected, or cancelled intent is preserved forever.
 *
 * CAS pool deadlock rule (from replit.md):
 *   Never call pool.connect() while already holding a client.
 *   All secondary reads within a transition use the already-held client.
 *
 * Usage:
 *   const { TradeIntentManager } = require('./managers/TradeIntentManager');
 *   const tim = new TradeIntentManager({ connectionString: process.env.DATABASE_URL });
 *   await tim.init();
 *   const { row } = await tim.createIntent({
 *     signal_id: 'sig_001', intent_type: 'OPEN', symbol: 'EUR_USD',
 *   });
 *   await tim.validateIntent(row.id, { passed: true, checks: { confidence: true } });
 *   await tim.approveIntent(row.id);
 *   const { row: exec } = await tim.executeIntent(row.id, { oanda_order_id: 'ORD-123' });
 *   await tim.archiveIntent(row.id);
 *   await tim.shutdown();
 *
 * Optional RDM integration:
 *   const tim = new TradeIntentManager({ connectionString, rdm });
 *   // executeIntent() will patch the runtime domain via rdm.patchDomain() (best-effort).
 *
 * Requirements:
 *   - Migrations 001, 002, 003 must have been applied
 *   - DATABASE_URL must point to PostgreSQL 9.6+
 */

const { Pool } = require("pg");

// ── State machine definition ──────────────────────────────────────────────────

/**
 * Valid next states from each status.
 * ARCHIVED is terminal — no transitions allowed.
 */
const VALID_TRANSITIONS = {
  CREATED:   ["VALIDATED", "REJECTED", "CANCELLED"],
  VALIDATED: ["APPROVED",  "REJECTED", "CANCELLED"],
  APPROVED:  ["EXECUTED",  "CANCELLED"],
  EXECUTED:  ["ARCHIVED"],
  REJECTED:  ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED:  [],
};

const TERMINAL_STATES   = new Set(["ARCHIVED"]);
const VALID_INTENT_TYPES = new Set(["OPEN", "CLOSE", "MODIFY"]);
const VALID_DIRECTIONS   = new Set(["BUY", "SELL", "NONE"]);

const REQUIRED_TABLES = [
  "trade_intents",
  "trade_intent_history",
  "consistency_log",
];

// ── TradeIntentManager ────────────────────────────────────────────────────────

class TradeIntentManager {
  /**
   * @param {object}  options
   * @param {string}  [options.connectionString]     PostgreSQL connection string
   * @param {object}  [options._pool]                Pre-created pg.Pool (for testing)
   * @param {number}  [options.maxConnections=5]     Pool max connections
   * @param {number}  [options.idleTimeout=30000]    Pool idle timeout ms
   * @param {number}  [options.connectTimeout=10000] Pool connect timeout ms
   * @param {string}  [options.calledBy='system']    Default changed_by for history
   * @param {object}  [options.rdm]                  RuntimeDomainManager instance (optional)
   */
  constructor(options = {}) {
    if (options._pool) {
      this._pool    = options._pool;
      this._ownPool = false;
    } else {
      const connStr = (options.connectionString != null ? options.connectionString : process.env.DATABASE_URL) || "";
      if (!connStr.startsWith("postgres://") && !connStr.startsWith("postgresql://")) {
        throw new Error(
          `TradeIntentManager: connectionString must start with postgres:// or postgresql://. ` +
          `Got: "${connStr.slice(0, 20)}..."`
        );
      }
      this._pool = new Pool({
        connectionString:        connStr,
        max:                     options.maxConnections  ?? 5,
        idleTimeoutMillis:       options.idleTimeout     ?? 30000,
        connectionTimeoutMillis: options.connectTimeout  ?? 10000,
      });
      this._ownPool = true;
    }

    this._defaultCalledBy = options.calledBy || "system";
    this._rdm             = options.rdm       || null;
    this._ready           = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Verifies all required tables exist. Must be called before any other method.
   * @returns {{ ok: boolean, tables: string[] }}
   */
  async init() {
    const client = await this._pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT table_name
         FROM   information_schema.tables
         WHERE  table_schema = 'public'`
      );
      const found   = new Set(rows.map(r => r.table_name));
      const missing = REQUIRED_TABLES.filter(t => !found.has(t));
      if (missing.length > 0) {
        throw new Error(
          `TradeIntentManager.init(): missing required tables: ${missing.join(", ")}. ` +
          `Run migration 003 first.`
        );
      }
      this._ready = true;
      return { ok: true, tables: REQUIRED_TABLES };
    } finally {
      client.release();
    }
  }

  /** Shuts down the pool (only if owned by this instance). */
  async shutdown() {
    if (this._ownPool) await this._pool.end();
    this._ready = false;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _assertReady() {
    if (!this._ready) {
      throw new Error("TradeIntentManager: call init() before using this manager.");
    }
  }

  /**
   * Core state-transition engine.
   *
   * Runs entirely inside the caller's transaction.
   * Uses SELECT FOR UPDATE to prevent concurrent transitions on the same row.
   * Records an audit entry in trade_intent_history in the same transaction.
   *
   * @param {object}         client         pg PoolClient (already in BEGIN)
   * @param {number}         intentId       intent primary key
   * @param {string|string[]} validFrom     acceptable current status(es)
   * @param {string}         toStatus       target status
   * @param {object}         extraFields    additional SQL columns to SET { col: value }
   * @param {string}         changedBy      audit identity
   * @param {object}         detail         JSONB for history record
   * @returns {object}       updated intent row (after transition)
   */
  async _transition(client, intentId, validFrom, toStatus, extraFields = {}, changedBy = "system", detail = {}) {
    const validFromArr = Array.isArray(validFrom) ? validFrom : [validFrom];

    // Lock the row exclusively to prevent concurrent transitions
    const { rows: lockRows } = await client.query(
      `SELECT id, status, version FROM trade_intents WHERE id = $1 FOR UPDATE`,
      [intentId]
    );

    if (lockRows.length === 0) {
      throw new Error(`TradeIntentManager: intent ${intentId} not found`);
    }

    const current = lockRows[0];

    if (TERMINAL_STATES.has(current.status)) {
      throw new Error(
        `TradeIntentManager: intent ${intentId} is in terminal state '${current.status}' — ` +
        `no further transitions are allowed`
      );
    }

    if (!validFromArr.includes(current.status)) {
      throw new Error(
        `TradeIntentManager: invalid transition to '${toStatus}': ` +
        `intent ${intentId} is in status '${current.status}' ` +
        `(expected one of: ${validFromArr.join(", ")})`
      );
    }

    // Build SET clause dynamically for extra fields
    const extraKeys = Object.keys(extraFields);
    const extraVals = Object.values(extraFields);
    const extraSet  = extraKeys.map((k, i) => `${k} = $${i + 3}`).join(", ");
    const setClause = `status = $1, version = version + 1, updated_at = NOW()${extraSet ? ", " + extraSet : ""}`;

    const { rows } = await client.query(
      `UPDATE trade_intents SET ${setClause} WHERE id = $2 RETURNING *`,
      [toStatus, intentId, ...extraVals]
    );

    const row = rows[0];

    // Append-only audit record — SACRED: never deleted
    await client.query(
      `INSERT INTO trade_intent_history
         (intent_id, from_status, to_status, version, changed_by, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [intentId, current.status, toStatus, Number(row.version), changedBy, JSON.stringify(detail)]
    );

    return row;
  }

  // ── Public Lifecycle Methods ──────────────────────────────────────────────

  /**
   * Creates a new trade intent in CREATED state.
   *
   * Idempotent on (signal_id, intent_type): if an intent already exists for
   * this pair, returns { created: false, duplicate: true, row: existingRow }.
   *
   * @param {object} data
   * @param {string}  data.signal_id                  Unique signal identifier
   * @param {string}  data.intent_type                OPEN | CLOSE | MODIFY
   * @param {string}  data.symbol                     Instrument (e.g. EUR_USD)
   * @param {string}  [data.runtime_domain='live']    Domain that owns this intent
   * @param {string}  [data.engine_source='system']   Engine creating this intent
   * @param {string}  [data.strategy_id='default']    Strategy identifier
   * @param {string}  [data.direction]                BUY | SELL | NONE
   * @param {number}  [data.confidence]               Signal confidence (0–1)
   * @param {number}  [data.risk_score]               Risk score (0–1)
   * @param {number}  [data.position_size]            Position size in units/lots
   * @param {number}  [data.stop_loss]                Stop loss price
   * @param {number}  [data.take_profit]              Take profit price
   * @param {string}  [data.reasoning]                Human-readable rationale
   * @param {object}  [data.metadata]                 Flexible extra metadata
   * @param {object}  [opts]
   * @param {string}  [opts.calledBy]                 Audit identity
   * @returns {{ created: boolean, duplicate: boolean, row: object }}
   */
  async createIntent(data = {}, opts = {}) {
    this._assertReady();

    if (!data.signal_id || typeof data.signal_id !== "string" || !data.signal_id.trim()) {
      throw new Error("createIntent: signal_id is required and must be a non-empty string");
    }
    if (!data.intent_type || !VALID_INTENT_TYPES.has(data.intent_type)) {
      throw new Error(`createIntent: intent_type must be one of: ${[...VALID_INTENT_TYPES].join(", ")}`);
    }
    if (!data.symbol || typeof data.symbol !== "string" || !data.symbol.trim()) {
      throw new Error("createIntent: symbol is required and must be a non-empty string");
    }
    if (data.direction != null && !VALID_DIRECTIONS.has(data.direction)) {
      throw new Error(`createIntent: direction must be one of: ${[...VALID_DIRECTIONS].join(", ")} (or omitted)`);
    }
    if (data.confidence != null && (typeof data.confidence !== "number" || data.confidence < 0 || data.confidence > 1)) {
      throw new Error("createIntent: confidence must be a number in [0, 1]");
    }
    if (data.risk_score != null && (typeof data.risk_score !== "number" || data.risk_score < 0 || data.risk_score > 1)) {
      throw new Error("createIntent: risk_score must be a number in [0, 1]");
    }

    const changedBy = opts.calledBy || this._defaultCalledBy;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `INSERT INTO trade_intents (
           signal_id, intent_type, symbol, status,
           runtime_domain, engine_source, strategy_id,
           direction, confidence, risk_score, position_size,
           stop_loss, take_profit, reasoning, metadata, version
         ) VALUES ($1,$2,$3,'CREATED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0)
         ON CONFLICT (signal_id, intent_type) DO NOTHING
         RETURNING *`,
        [
          data.signal_id.trim(),
          data.intent_type,
          data.symbol.trim(),
          data.runtime_domain || "live",
          data.engine_source  || "system",
          data.strategy_id    || "default",
          data.direction      ?? null,
          data.confidence     ?? null,
          data.risk_score     ?? null,
          data.position_size  ?? null,
          data.stop_loss      ?? null,
          data.take_profit    ?? null,
          data.reasoning      || null,
          JSON.stringify(data.metadata || {}),
        ]
      );

      if (rows.length === 0) {
        // Duplicate — read within same tx before rollback
        const { rows: existing } = await client.query(
          `SELECT * FROM trade_intents WHERE signal_id = $1 AND intent_type = $2`,
          [data.signal_id.trim(), data.intent_type]
        );
        await client.query("ROLLBACK");
        return { created: false, duplicate: true, row: existing[0] ?? null };
      }

      const row = rows[0];

      // Initial audit entry (from_status = NULL for CREATED)
      await client.query(
        `INSERT INTO trade_intent_history
           (intent_id, from_status, to_status, version, changed_by, detail)
         VALUES ($1, NULL, 'CREATED', 0, $2, $3)`,
        [row.id, changedBy, JSON.stringify({
          signal_id:   data.signal_id.trim(),
          intent_type: data.intent_type,
          symbol:      data.symbol.trim(),
        })]
      );

      await client.query("COMMIT");
      return { created: true, duplicate: false, row };

    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Validates a CREATED intent.
   * If validationResult.passed is true  → transitions to VALIDATED.
   * If validationResult.passed is false → transitions to REJECTED (reason preserved).
   *
   * @param {number} intentId
   * @param {object} validationResult
   * @param {boolean} validationResult.passed
   * @param {object}  [validationResult.checks]  Detailed check map
   * @param {string}  [validationResult.reason]  Rejection reason (required if passed=false)
   * @param {object}  [opts]
   * @param {string}  [opts.calledBy]
   * @returns {object} updated intent row
   */
  async validateIntent(intentId, validationResult = {}, opts = {}) {
    this._assertReady();

    const id = Number(intentId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("validateIntent: intentId must be a positive number");
    }
    if (typeof validationResult.passed !== "boolean") {
      throw new Error("validateIntent: validationResult.passed must be a boolean");
    }
    if (!validationResult.passed && (!validationResult.reason || !String(validationResult.reason).trim())) {
      throw new Error("validateIntent: validationResult.reason is required when passed=false");
    }

    const toStatus   = validationResult.passed ? "VALIDATED" : "REJECTED";
    const changedBy  = opts.calledBy || this._defaultCalledBy;
    const extraFields = {
      validation_detail: JSON.stringify(validationResult.checks || {}),
    };
    if (!validationResult.passed) {
      extraFields.rejection_reason = String(validationResult.reason).trim();
    }

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this._transition(
        client, id, "CREATED", toStatus, extraFields,
        changedBy,
        { validation_passed: validationResult.passed, reason: validationResult.reason || null }
      );
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
   * Approves a VALIDATED intent, permitting it to proceed to execution.
   *
   * @param {number} intentId
   * @param {object} [opts]
   * @param {string} [opts.calledBy]
   * @param {object} [opts.notes]    Additional approval metadata
   * @returns {object} updated intent row
   */
  async approveIntent(intentId, opts = {}) {
    this._assertReady();

    const id = Number(intentId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("approveIntent: intentId must be a positive number");
    }

    const changedBy = opts.calledBy || this._defaultCalledBy;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this._transition(
        client, id, "VALIDATED", "APPROVED", {},
        changedBy,
        { notes: opts.notes || null }
      );
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
   * Rejects an intent from CREATED, VALIDATED, or APPROVED state.
   * The rejection reason is preserved permanently (Sacred Constraint).
   *
   * @param {number} intentId
   * @param {string} reason   Must be a non-empty string (preserved forever)
   * @param {object} [opts]
   * @param {string} [opts.calledBy]
   * @returns {object} updated intent row
   */
  async rejectIntent(intentId, reason, opts = {}) {
    this._assertReady();

    const id = Number(intentId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("rejectIntent: intentId must be a positive number");
    }
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      throw new Error("rejectIntent: reason is required and must be a non-empty string");
    }

    const changedBy = opts.calledBy || this._defaultCalledBy;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this._transition(
        client, id,
        ["CREATED", "VALIDATED", "APPROVED"],
        "REJECTED",
        { rejection_reason: reason.trim() },
        changedBy,
        { reason: reason.trim() }
      );
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
   * Executes an APPROVED intent and records the execution details.
   *
   * The intent is committed as EXECUTED before any RDM update is attempted.
   * If the RDM update fails, the intent remains EXECUTED and the error is
   * logged to consistency_log — the intent is NOT rolled back.
   *
   * @param {number} intentId
   * @param {object} [executionDetail]          Execution outcome (OANDA response, etc.)
   * @param {object} [opts]
   * @param {string} [opts.calledBy]
   * @param {string} [opts.oanda_order_id]      OANDA order ID
   * @returns {{ row: object, rdmUpdated: boolean, rdmError: string|null }}
   */
  async executeIntent(intentId, executionDetail = {}, opts = {}) {
    this._assertReady();

    const id = Number(intentId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("executeIntent: intentId must be a positive number");
    }

    const changedBy  = opts.calledBy || this._defaultCalledBy;
    const extraFields = {
      execution_detail: JSON.stringify(executionDetail),
    };
    if (opts.oanda_order_id) {
      extraFields.oanda_order_id = opts.oanda_order_id;
    }

    // ── Step 1: Transition APPROVED → EXECUTED (committed to DB) ─────────
    const client = await this._pool.connect();
    let row;
    try {
      await client.query("BEGIN");
      row = await this._transition(
        client, id, "APPROVED", "EXECUTED", extraFields,
        changedBy,
        { execution_detail: executionDetail, oanda_order_id: opts.oanda_order_id || null }
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();    // Release before any RDM call (CAS pool deadlock rule)
    }

    // ── Step 2: Optional RDM domain update (best-effort, separate connection) ─
    let rdmUpdated = false;
    let rdmError   = null;

    if (this._rdm) {
      try {
        const domain    = row.runtime_domain || "live";
        const domainRow = await this._rdm.getDomain(domain);
        if (domainRow) {
          await this._rdm.patchDomain(
            domain,
            {
              lastIntentId:     row.id,
              lastIntentSymbol: row.symbol,
              lastIntentType:   row.intent_type,
              lastIntentTs:     new Date().toISOString(),
            },
            { calledBy: `tim.executeIntent#${row.id}` }
          );
          rdmUpdated = true;
        }
      } catch (rdmErr) {
        rdmError = rdmErr.message;
        // Log to consistency_log — do NOT throw; intent is already safely EXECUTED
        try {
          await this._rdm.logConsistency(
            `tim_exec_rdm_${row.id}`,
            "WARN",
            `TradeIntentManager.executeIntent: RDM domain update failed for intent ${row.id}`,
            { intentId: row.id, domain: row.runtime_domain, error: rdmErr.message }
          );
        } catch (_) { /* swallow — never let audit failure cascade */ }
      }
    }

    return { row, rdmUpdated, rdmError };
  }

  /**
   * Cancels an intent from CREATED, VALIDATED, or APPROVED state.
   * The cancellation reason is preserved permanently (Sacred Constraint).
   *
   * @param {number} intentId
   * @param {string} reason   Must be a non-empty string (preserved forever)
   * @param {object} [opts]
   * @param {string} [opts.calledBy]
   * @returns {object} updated intent row
   */
  async cancelIntent(intentId, reason, opts = {}) {
    this._assertReady();

    const id = Number(intentId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("cancelIntent: intentId must be a positive number");
    }
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      throw new Error("cancelIntent: reason is required and must be a non-empty string");
    }

    const changedBy = opts.calledBy || this._defaultCalledBy;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this._transition(
        client, id,
        ["CREATED", "VALIDATED", "APPROVED"],
        "CANCELLED",
        { cancelled_reason: reason.trim() },
        changedBy,
        { reason: reason.trim() }
      );
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
   * Archives a terminal intent (EXECUTED, REJECTED, or CANCELLED).
   * ARCHIVED is the final resting state — no further transitions.
   *
   * @param {number} intentId
   * @param {object} [opts]
   * @param {string} [opts.calledBy]
   * @param {object} [opts.notes]
   * @returns {object} updated intent row
   */
  async archiveIntent(intentId, opts = {}) {
    this._assertReady();

    const id = Number(intentId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("archiveIntent: intentId must be a positive number");
    }

    const changedBy = opts.calledBy || this._defaultCalledBy;

    const client = await this._pool.connect();
    try {
      await client.query("BEGIN");
      const row = await this._transition(
        client, id,
        ["EXECUTED", "REJECTED", "CANCELLED"],
        "ARCHIVED",
        {},
        changedBy,
        { notes: opts.notes || null }
      );
      await client.query("COMMIT");
      return row;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Read Methods ──────────────────────────────────────────────────────────

  /**
   * Returns a single intent by ID, or null if not found.
   * @param {number} intentId
   * @returns {object|null}
   */
  async getIntent(intentId) {
    this._assertReady();
    const id = Number(intentId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("getIntent: intentId must be a positive number");
    }
    const { rows } = await this._pool.query(
      `SELECT * FROM trade_intents WHERE id = $1`,
      [id]
    );
    return rows[0] ?? null;
  }

  /**
   * Lists intents with optional filters.
   *
   * @param {object} [filter]
   * @param {string}   [filter.status]
   * @param {string}   [filter.runtime_domain]
   * @param {string}   [filter.symbol]
   * @param {string}   [filter.engine_source]
   * @param {string}   [filter.intent_type]
   * @param {string}   [filter.signal_id]
   * @param {Date}     [filter.since]             created_at >= since
   * @param {Date}     [filter.until]             created_at <= until
   * @param {number}   [filter.limit=100]         max rows (capped at 1000)
   * @param {string}   [filter.orderBy='created_at']
   * @param {string}   [filter.orderDir='DESC']
   * @returns {object[]}
   */
  async listIntents(filter = {}) {
    this._assertReady();

    const conds  = [];
    const params = [];
    let   p      = 1;

    const safe = { status: true, runtime_domain: true, symbol: true, engine_source: true, intent_type: true, signal_id: true };
    for (const [col, ok] of Object.entries(safe)) {
      if (ok && filter[col] != null) {
        conds.push(`${col} = $${p++}`);
        params.push(filter[col]);
      }
    }
    if (filter.since != null) { conds.push(`created_at >= $${p++}`); params.push(filter.since); }
    if (filter.until != null) { conds.push(`created_at <= $${p++}`); params.push(filter.until); }

    const where    = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const orderDir = (filter.orderDir || "DESC").toUpperCase() === "ASC" ? "ASC" : "DESC";
    const orderBy  = filter.orderBy || "created_at";
    const limit    = Math.min(Math.max(Number(filter.limit) || 100, 1), 1000);

    const { rows } = await this._pool.query(
      `SELECT * FROM trade_intents ${where} ORDER BY ${orderBy} ${orderDir} LIMIT $${p}`,
      [...params, limit]
    );
    return rows;
  }

  /**
   * Returns the full audit history for one intent (most recent first).
   * @param {number} intentId
   * @returns {object[]}
   */
  async getIntentHistory(intentId) {
    this._assertReady();
    const id = Number(intentId);
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error("getIntentHistory: intentId must be a positive number");
    }
    const { rows } = await this._pool.query(
      `SELECT * FROM trade_intent_history
       WHERE intent_id = $1
       ORDER BY changed_at DESC, id DESC`,
      [id]
    );
    return rows;
  }

  /**
   * Returns any existing intents with the given (signal_id, intent_type).
   * Used to detect duplicates before calling createIntent().
   *
   * @param {string} signalId
   * @param {string} intentType
   * @returns {object[]}
   */
  async getDuplicates(signalId, intentType) {
    this._assertReady();
    if (!signalId || !intentType) {
      throw new Error("getDuplicates: signalId and intentType are required");
    }
    const { rows } = await this._pool.query(
      `SELECT * FROM trade_intents WHERE signal_id = $1 AND intent_type = $2`,
      [String(signalId), String(intentType)]
    );
    return rows;
  }

  // ── Health & Stats ────────────────────────────────────────────────────────

  /**
   * Returns counts of intents by status and pool health.
   * @returns {{ byStatus: object, total: number, historyRows: number, pool: object }}
   */
  async getStats() {
    this._assertReady();

    const [{ rows: statusRows }, { rows: histRows }] = await Promise.all([
      this._pool.query(`SELECT status, COUNT(*) AS n FROM trade_intents GROUP BY status`),
      this._pool.query(`SELECT COUNT(*) AS n FROM trade_intent_history`),
    ]);

    const byStatus = {};
    let total = 0;
    for (const r of statusRows) {
      byStatus[r.status] = Number(r.n);
      total += Number(r.n);
    }

    return {
      byStatus,
      total,
      historyRows: Number(histRows[0].n),
      pool: {
        total:   this._pool.totalCount,
        idle:    this._pool.idleCount,
        waiting: this._pool.waitingCount,
      },
    };
  }

  /**
   * Tests connectivity. Safe to call before init().
   * @returns {{ ok: boolean, latencyMs: number }}
   */
  async ping() {
    const t0 = Date.now();
    await this._pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - t0 };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  TradeIntentManager,
  VALID_TRANSITIONS,
  VALID_INTENT_TYPES,
  VALID_DIRECTIONS,
};
