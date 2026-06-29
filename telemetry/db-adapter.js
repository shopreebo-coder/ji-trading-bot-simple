"use strict";
/**
 * DB Adapter — unified async interface for SQLite (default) or PostgreSQL.
 *
 * Backend is selected automatically at startup:
 *   DATABASE_URL starts with "postgres" → PostgreSQL (pg.Pool — Railway managed)
 *   otherwise                           → SQLite  (node:sqlite built-in, no install)
 *
 * Public API — all methods return Promises:
 *   db.exec(sql)                — DDL; splits on ";" and runs each statement
 *   db.all(sql, ...params)      — SELECT → array of row objects
 *   db.get(sql, ...params)      — SELECT → first row or null
 *   db.run(sql, ...params)      — INSERT/UPDATE positional ? params → { lastInsertRowid, changes }
 *   db.run(sql, namedObject)    — INSERT/UPDATE @name params    → { lastInsertRowid, changes }
 *
 * SQL compatibility (SQLite syntax works for both backends — adapter converts):
 *   Positional ?                       → $1, $2, … for PostgreSQL
 *   Named @param                       → $1, $2, … for PostgreSQL
 *   INTEGER PRIMARY KEY AUTOINCREMENT  → BIGSERIAL PRIMARY KEY for PostgreSQL
 *   REAL                               → DOUBLE PRECISION for PostgreSQL
 *   ON CONFLICT DO UPDATE, substr()    → identical in both engines (no conversion needed)
 */

const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_PG = DATABASE_URL.startsWith("postgres://") || DATABASE_URL.startsWith("postgresql://");

let db, DB_PATH, DATA_DIR, DATA_DIR_EXPLICIT;

if (USE_PG) {
  // ── PostgreSQL backend ────────────────────────────────────────────────────────
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: DATABASE_URL });

  function toPos(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  function fromNamed(sql, obj) {
    const values = [];
    const out = sql.replace(/@(\w+)/g, (_, name) => {
      values.push(obj[name] ?? null);
      return `$${values.length}`;
    });
    return [out, values];
  }

  function toPgDdl(sql) {
    return sql
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, "BIGSERIAL PRIMARY KEY")
      .replace(/\bREAL\b/g, "DOUBLE PRECISION");
  }

  db = {
    async exec(sql) {
      const stmts = toPgDdl(sql).split(";").map(s => s.trim()).filter(Boolean);
      for (const stmt of stmts) await pool.query(stmt);
    },

    async all(sql, ...params) {
      const { rows } = await pool.query(toPos(sql), params);
      return rows;
    },

    async get(sql, ...params) {
      const { rows } = await pool.query(toPos(sql), params);
      return rows[0] ?? null;
    },

    async run(sql, ...args) {
      let convertedSql, values;
      if (args.length === 1 && args[0] !== null && typeof args[0] === "object" && !Array.isArray(args[0])) {
        [convertedSql, values] = fromNamed(sql, args[0]);
      } else {
        convertedSql = toPos(sql);
        values = args;
      }
      const isInsert    = /^\s*INSERT/i.test(sql);
      const hasReturning = /RETURNING/i.test(sql);
      if (isInsert && !hasReturning) convertedSql += " RETURNING id";
      const result = await pool.query(convertedSql, values);
      return { lastInsertRowid: result.rows[0]?.id ?? null, changes: result.rowCount };
    },

    _pool: pool,
  };

  DATA_DIR          = null;
  DATA_DIR_EXPLICIT = true;
  DB_PATH           = "postgresql://" + DATABASE_URL.replace(/\/\/[^@]*@/, "//***@");

} else {
  // ── SQLite backend (default: dev + Railway without DATABASE_URL) ─────────────
  const { DatabaseSync } = require("node:sqlite");
  const fs   = require("fs");
  const path = require("path");

  DATA_DIR_EXPLICIT = !!process.env.DATA_DIR;
  DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  DB_PATH = path.join(DATA_DIR, "events.db");

  const _db = new DatabaseSync(DB_PATH);
  _db.exec("PRAGMA journal_mode = WAL");
  _db.exec("PRAGMA synchronous   = NORMAL");
  _db.exec("PRAGMA cache_size     = -4000");

  db = {
    async exec(sql)           { _db.exec(sql); },
    async all(sql, ...params) { return _db.prepare(sql).all(...params); },
    async get(sql, ...params) { return _db.prepare(sql).get(...params) ?? null; },
    async run(sql, ...args)   {
      const info = _db.prepare(sql).run(...args);
      return { lastInsertRowid: Number(info.lastInsertRowid), changes: info.changes };
    },
    _raw: _db,
  };
}

module.exports = { db, DB_PATH, DATA_DIR, DATA_DIR_EXPLICIT, USE_PG };
