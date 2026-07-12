"use strict";
/**
 * Auto-migration runner — applies telemetry/migrations/*.sql to PostgreSQL at
 * startup, idempotently, with NO external psql dependency.
 *
 * Why this exists (Sprint 4.1):
 *   Production (Railway) attaches a FRESH PostgreSQL service that has none of the
 *   SHADOW OS v2 tables. The domain managers assume the schema already exists, so
 *   without this step LiveMemoryIntegration.init() fails and the entire memory /
 *   snapshot / recovery layer silently degrades to no-op. This runner creates
 *   every required table + index on boot so that data persists across deploys.
 *
 * Why pool.query(fileContents) and not psql / a JS splitter:
 *   - psql is not guaranteed to exist in a Railway Nixpacks Node container.
 *   - A regex "split on ;" splitter corrupts the DO $$ ... $$; blocks in
 *     003_trade_intent_v2.sql (semicolons live inside the function body).
 *   - node-postgres' SIMPLE query protocol (a query string with no bind params)
 *     lets the SERVER parse statement boundaries — including dollar-quoted bodies —
 *     and runs the whole file as ONE implicit transaction (all-or-nothing per file).
 *
 * Safety (sacred constraint — never destroy accumulated trading knowledge):
 *   - Every migration uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS /
 *     ON CONFLICT DO NOTHING. No DROP TABLE / TRUNCATE / DELETE anywhere.
 *   - A session-scoped advisory lock serializes concurrent migrators (Railway
 *     redeploys briefly overlap old + new processes).
 *   - Applied files are recorded in schema_migrations and skipped next boot;
 *     re-running is still safe because all DDL is idempotent.
 */

const fs   = require("fs");
const path = require("path");

// Fixed apply order — later files depend on earlier ones (e.g. 003 ALTERs the
// trade_intents table created in 001).
const MIGRATIONS = [
  "001_shadow_os_v2_schema.sql",
  "002_runtime_domain_history.sql",
  "003_trade_intent_v2.sql",
  "004_memory_foundation.sql",
  "005_shadowlab_foundation.sql",
  "006_knowledge_foundation.sql",
];

// Advisory-lock key — deliberately DISTINCT from LiveMemoryIntegration's
// recovery lock (21320, 20307) so the two never contend.
const MIGRATION_LOCK_CLASS = 21320;
const MIGRATION_LOCK_OBJ   = 40911;

/**
 * Ensure the full SHADOW OS v2 schema exists on the given PostgreSQL pool.
 * Idempotent and safe to call on every boot.
 *
 * @param {import('pg').Pool} pool  connected pg pool
 * @param {object} [opts]
 * @param {(msg:string)=>void} [opts.log]  logger (defaults to console.log)
 * @param {string}             [opts.dir]  migrations dir (defaults to __dirname)
 * @returns {Promise<{ok:boolean, applied:string[], skipped:string[], backend:string}>}
 */
async function ensureSchema(pool, opts = {}) {
  const log = opts.log || ((m) => console.log(`[MIGRATE] ${m}`));
  const dir = opts.dir || __dirname;

  const client  = await pool.connect();
  const summary = { ok: false, applied: [], skipped: [], backend: "postgresql" };
  let locked = false;
  try {
    // Serialize concurrent migrators across processes (redeploy overlap).
    await client.query("SELECT pg_advisory_lock($1, $2)", [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_OBJ]);
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    const done = new Set(rows.map((r) => r.filename));

    for (const file of MIGRATIONS) {
      if (done.has(file)) { summary.skipped.push(file); continue; }
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      // Single simple-protocol query => one implicit transaction for the file.
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
        [file]
      );
      summary.applied.push(file);
      log(`applied ${file}`);
    }

    summary.ok = true;
    if (summary.applied.length === 0) {
      log(`schema up to date (${summary.skipped.length} migration(s) already applied)`);
    } else {
      log(`schema ready — applied ${summary.applied.length}, skipped ${summary.skipped.length}`);
    }
    return summary;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_OBJ]);
      } catch (_) { /* lock auto-releases on session end */ }
    }
    client.release();
  }
}

module.exports = { ensureSchema, MIGRATIONS, MIGRATION_LOCK_CLASS, MIGRATION_LOCK_OBJ };
