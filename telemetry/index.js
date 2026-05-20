"use strict";
/**
 * Telemetry core — logEvent() + SQLite persistence + EventEmitter
 * Uses Node.js built-in  node:sqlite  (available since Node 22, no deps needed).
 * DB path: $DATA_DIR/events.db  (Railway volume at /data, else ./data)
 */

const { DatabaseSync } = require("node:sqlite");
const EventEmitter     = require("events");
const fs               = require("fs");
const path             = require("path");

// ── data directory ────────────────────────────────────────────────────────────
const DATA_DIR = (() => {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try { fs.accessSync("/data", fs.constants.W_OK); return "/data"; } catch (_) {}
  return path.join(__dirname, "..", "data");
})();

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

module.exports = { logEvent, db, emitter, BOT_ID, DATA_DIR, getLastId };
