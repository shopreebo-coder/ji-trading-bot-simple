"use strict";
/**
 * Telemetry core — logEvent() + DB persistence + EventEmitter
 *
 * DB backend is selected automatically by db-adapter.js:
 *   DATABASE_URL set (postgres://) → PostgreSQL (Railway managed — always persistent)
 *   otherwise                      → SQLite (persistent locally; ephemeral on Railway
 *                                    without a Volume — add PostgreSQL to fix this)
 *
 * logEvent() signature is fire-and-forget (sync call, async write + emit internally).
 * All other DB helpers (getDbStats, backupDatabase, getLastId) are async.
 */

const { db, DB_PATH, DATA_DIR, DATA_DIR_EXPLICIT, USE_PG } = require("./db-adapter");
const EventEmitter = require("events");
const fs   = require("fs");
const path = require("path");

// ── Event emitter (in-process SSE fan-out) ────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// ── Bot identity ──────────────────────────────────────────────────────────────
const BOT_ID = process.env.BOT_ID || "BotA";

// ── INSERT SQL ────────────────────────────────────────────────────────────────
const _INSERT_SQL =
  "INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)";

// ── Schema init (runs once at module load — async IIFE) ───────────────────────
(async function _initSchema() {
  try {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      TEXT    NOT NULL,
        bot_id  TEXT    NOT NULL,
        type    TEXT    NOT NULL,
        symbol  TEXT,
        data    TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ts     ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_type   ON events(type);
      CREATE INDEX IF NOT EXISTS idx_bot    ON events(bot_id);
      CREATE INDEX IF NOT EXISTS idx_symbol ON events(symbol);
      CREATE INDEX IF NOT EXISTS idx_date   ON events(substr(ts,1,10))
    `);
  } catch (err) {
    console.error("[TELEMETRY] Schema init error:", err.message);
  }
})();

// ── logEvent — fire-and-forget (sync call site, async write + emit) ───────────
function logEvent(event) {
  const ts     = event.timestamp || new Date().toISOString();
  const botId  = event.botId  || BOT_ID;
  const type   = event.type;
  const symbol = event.symbol || null;
  const data   = JSON.stringify({ ...event, ts, botId });

  db.run(_INSERT_SQL, ts, botId, type, symbol, data)
    .then(info => {
      const row = {
        id: Number(info.lastInsertRowid),
        ts, botId, type, symbol,
        data: { ...event, ts, botId },
      };
      emitter.emit("event", row);
    })
    .catch(err => console.error("[TELEMETRY] DB write error:", err.message));
}

// ── getLastId ─────────────────────────────────────────────────────────────────
async function getLastId() {
  const row = await db.get("SELECT MAX(id) AS id FROM events");
  return Number(row?.id ?? 0);
}

// ── backupDatabase ────────────────────────────────────────────────────────────
async function backupDatabase() {
  if (USE_PG) {
    return { ok: true, path: "(PostgreSQL — backups managed by Railway)" };
  }
  try {
    const ts  = new Date().toISOString().replace(/[:.]/g, "-");
    const dst = path.join(DATA_DIR, `events_backup_${ts}.db`);
    fs.copyFileSync(DB_PATH, dst);
    const backups = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith("events_backup_") && f.endsWith(".db"))
      .sort();
    if (backups.length > 5) {
      backups.slice(0, backups.length - 5).forEach(f => {
        try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {}
      });
    }
    console.log(`[TELEMETRY] Backup: ${dst}`);
    return { ok: true, path: dst };
  } catch (err) {
    console.error("[TELEMETRY] Backup failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── getDbStats ────────────────────────────────────────────────────────────────
async function getDbStats() {
  try {
    const total  = (await db.get("SELECT COUNT(*) AS n FROM events"))?.n ?? 0;
    const types  = await db.all(
      "SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC LIMIT 20"
    );
    const oldest = (await db.get("SELECT ts FROM events ORDER BY id ASC  LIMIT 1"))?.ts ?? null;
    const newest = (await db.get("SELECT ts FROM events ORDER BY id DESC LIMIT 1"))?.ts ?? null;
    return { total, types, oldest, newest, path: DB_PATH };
  } catch (err) {
    return { total: 0, types: [], path: DB_PATH, error: err.message };
  }
}

// ── Startup integrity log ─────────────────────────────────────────────────────
(async function _startupLog() {
  try {
    const s = await getDbStats();
    const pMark = USE_PG
      ? "✓ PERSISTENT (PostgreSQL — Railway managed)"
      : DATA_DIR_EXPLICIT
        ? "✓ PERSISTENT (DATA_DIR explicitly set)"
        : "⚠ EPHEMERAL on Railway (DATA_DIR not set — add PostgreSQL service to Railway)";
    console.log(`[TELEMETRY] DB       : ${s.path}`);
    console.log(`[TELEMETRY] Storage  : ${pMark}`);
    console.log(
      `[TELEMETRY] Events   : ${s.total}` +
      ` | oldest: ${s.oldest ? s.oldest.slice(0, 10) : "—"}` +
      ` | newest: ${s.newest ? s.newest.slice(0, 10) : "—"}`
    );
    if (s.total > 0) console.log("[TELEMETRY] ✓ Historical data preserved across this restart");
    else             console.log("[TELEMETRY] ℹ Fresh database (0 events)");
    logEvent({ type: "system_startup", totalEvents: s.total, dbPath: s.path, persistent: USE_PG || DATA_DIR_EXPLICIT });
  } catch (_) {}
})();

module.exports = {
  logEvent, db, emitter, BOT_ID,
  DATA_DIR, DATA_DIR_EXPLICIT, DB_PATH, USE_PG,
  getLastId, backupDatabase, getDbStats,
};
