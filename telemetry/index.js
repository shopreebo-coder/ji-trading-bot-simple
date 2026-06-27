"use strict";
/**
 * Telemetry core — logEvent() + SQLite persistence + EventEmitter
 * Uses Node.js built-in  node:sqlite  (available since Node 22, no deps needed).
 *
 * DB PATH RULES — READ CAREFULLY:
 *   DATA_DIR env var set  → uses that path  (persistent if it points to a Railway Volume)
 *   DATA_DIR not set      → falls back to ./data  (local dev / Replit workspace)
 *
 * RAILWAY PERSISTENCE REQUIREMENT:
 *   Without an explicit DATA_DIR pointing to a mounted Volume, data is stored on
 *   the container's ephemeral filesystem and WILL BE LOST on every redeploy.
 *
 *   To persist data on Railway:
 *     1. Railway dashboard → Service → Storage → Add Volume → Mount at /data
 *     2. Railway dashboard → Variables → Add  DATA_DIR=/data
 *     3. Redeploy
 *
 * IMPORTANT: Do NOT rely on /data being writable — Railway containers allow writes
 * to /data even without a Volume, but without a Volume the path is ephemeral.
 * Only DATA_DIR env var guarantees the path is intentionally configured.
 */

const { DatabaseSync } = require("node:sqlite");
const EventEmitter     = require("events");
const fs               = require("fs");
const path             = require("path");

// ── data directory ────────────────────────────────────────────────────────────
// BUG FIX (v40.1): Removed the /data accessSync auto-detection.
// Railway containers have a writable /data even without a Volume — auto-detecting
// it silently stored the DB on ephemeral container storage and caused data loss
// on every redeploy. DATA_DIR must be explicitly set to guarantee persistence.
const DATA_DIR_EXPLICIT = !!process.env.DATA_DIR;

const DATA_DIR = (() => {
  // Path 1: Explicitly configured — required for Railway persistence
  if (process.env.DATA_DIR) return process.env.DATA_DIR;

  // Path 2: Local fallback — persistent in Replit workspace, ephemeral on Railway
  return path.join(__dirname, "..", "data");
})();

// Warn loudly if not explicitly configured (will be ephemeral on Railway)
if (!DATA_DIR_EXPLICIT) {
  console.warn("[TELEMETRY] ⚠  DATA_DIR env var not set — using local fallback: " + DATA_DIR);
  console.warn("[TELEMETRY] ⚠  On Railway: data WILL BE LOST on redeploy. Add a Volume at /data and set DATA_DIR=/data.");
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, "events.db");

// ── open database ─────────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous   = NORMAL");
db.exec("PRAGMA cache_size     = -4000");

db.exec(`
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
  CREATE INDEX IF NOT EXISTS idx_date   ON events(substr(ts,1,10));
`);

// ── prepared statements ───────────────────────────────────────────────────────
const _insert = db.prepare(
  "INSERT INTO events (ts, bot_id, type, symbol, data) VALUES (?, ?, ?, ?, ?)"
);

const _lastId = db.prepare("SELECT MAX(id) AS id FROM events");

// ── event emitter (in-process SSE fan-out) ────────────────────────────────────
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

// ── bot identity ──────────────────────────────────────────────────────────────
const BOT_ID = process.env.BOT_ID || "BotA";

// ── logEvent ──────────────────────────────────────────────────────────────────
function logEvent(event) {
  const ts     = event.timestamp || new Date().toISOString();
  const botId  = event.botId  || BOT_ID;
  const type   = event.type;
  const symbol = event.symbol || null;
  const data   = JSON.stringify({ ...event, ts, botId });

  try {
    const info = _insert.run(ts, botId, type, symbol, data);
    const row  = {
      id:     Number(info.lastInsertRowid),
      ts, botId, type, symbol,
      data: { ...event, ts, botId },
    };
    emitter.emit("event", row);
  } catch (err) {
    console.error("[TELEMETRY] DB error:", err.message);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function getLastId() {
  const row = _lastId.get();
  return Number(row?.id ?? 0);
}

// ── database backup ───────────────────────────────────────────────────────────
/**
 * Copies events.db → events_backup_<timestamp>.db in DATA_DIR.
 * Keeps last 5 backups, deletes older ones.
 * Called automatically before destructive operations; callable via API.
 */
function backupDatabase() {
  try {
    const ts  = new Date().toISOString().replace(/[:.]/g, "-");
    const dst = path.join(DATA_DIR, `events_backup_${ts}.db`);
    fs.copyFileSync(DB_PATH, dst);
    // Keep only the last 5 backups
    const backups = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith("events_backup_") && f.endsWith(".db"))
      .sort();
    if (backups.length > 5) {
      backups.slice(0, backups.length - 5).forEach(f => {
        try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {}
      });
    }
    console.log(`[TELEMETRY] Backup: ${dst} (${backups.length} kept)`);
    return { ok: true, path: dst };
  } catch (err) {
    console.error("[TELEMETRY] Backup failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// ── DB stats (for health checks / status endpoints) ───────────────────────────
function getDbStats() {
  try {
    const total = db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0;
    const types = db.prepare(
      "SELECT type, COUNT(*) AS n FROM events GROUP BY type ORDER BY n DESC LIMIT 20"
    ).all();
    const oldest = db.prepare("SELECT ts FROM events ORDER BY id ASC  LIMIT 1").get()?.ts ?? null;
    const newest = db.prepare("SELECT ts FROM events ORDER BY id DESC LIMIT 1").get()?.ts ?? null;
    return { total, types, oldest, newest, path: DB_PATH };
  } catch (err) {
    return { total: 0, types: [], path: DB_PATH, error: err.message };
  }
}

// ── startup integrity log ─────────────────────────────────────────────────────
(function _startupLog() {
  try {
    const s    = getDbStats();
    const pMark = DATA_DIR_EXPLICIT ? "✓ PERSISTENT (DATA_DIR explicitly set)" : "⚠ EPHEMERAL on Railway (DATA_DIR not set)";
    console.log(`[TELEMETRY] DB path  : ${s.path}`);
    console.log(`[TELEMETRY] Storage  : ${pMark}`);
    console.log(`[TELEMETRY] Events   : ${s.total} | oldest: ${s.oldest ? s.oldest.slice(0, 10) : "—"} | newest: ${s.newest ? s.newest.slice(0, 10) : "—"}`);
    if (s.total > 0) console.log("[TELEMETRY] ✓ Historical data preserved across this restart");
    else             console.log("[TELEMETRY] ℹ Fresh database (0 events)");
    logEvent({ type: "system_startup", totalEvents: s.total, dbPath: s.path, persistent: DATA_DIR_EXPLICIT });
  } catch (_) {}
})();

module.exports = { logEvent, db, emitter, BOT_ID, DATA_DIR, DATA_DIR_EXPLICIT, getLastId, backupDatabase, getDbStats };
