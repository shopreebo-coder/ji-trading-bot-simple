"use strict";
/**
 * SHADOW OS v2 — Migration Runner
 * Sprint 0: Schema Foundation
 *
 * Usage:
 *   node telemetry/migrations/run.js
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (required)
 *
 * Safety:
 *   Idempotent — safe to run multiple times.
 *   Uses psql to execute the SQL file (avoids JS statement-splitting bugs).
 *   Never drops or truncates any existing table.
 *   All DDL uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
 *
 * GOLDEN RULE:
 *   No deployment, restart, or migration step may ever destroy the
 *   accumulated trading knowledge of the system.
 */

require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });

const path         = require("path");
const { execSync } = require("child_process");

const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL.startsWith("postgres://") && !DATABASE_URL.startsWith("postgresql://")) {
  console.error("[MIGRATION] ERROR: DATABASE_URL must start with postgres:// or postgresql://");
  console.error(`[MIGRATION]   Got: "${DATABASE_URL.slice(0, 30)}..."`);
  process.exit(1);
}

const EXPECTED_TABLES = [
  "events",
  "shadowm_trades",
  "shadowm_timeline",
  "runtime_domains",
  "trade_intents",
  "trade_intent_history",
  "memory_entries",
  "knowledge_artifacts",
  "event_idempotency",
  "consistency_log",
  "system_snapshots",
  "runtime_domain_history",
];

const EXPECTED_DOMAINS = [
  "live", "shadowA", "shadowB", "shadowC", "shadowD",
  "shadowM", "exitLab", "telemetry", "scheduler", "meta"
];

async function run() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString:        DATABASE_URL,
    max:                     3,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis:       5000,
  });

  let client;
  try {
    // ── Verify connectivity ────────────────────────────────────────
    console.log("[MIGRATION] Connecting to PostgreSQL...");
    client = await pool.connect();
    const { rows: pingRows } = await client.query("SELECT version()");
    console.log(`[MIGRATION] Connected. ${pingRows[0].version.split(",")[0]}`);

    // ── Capture pre-migration row counts (data integrity baseline) ─
    const preEvt = await client.query("SELECT COUNT(*) AS n FROM events");
    const preSmT = await client.query("SELECT COUNT(*) AS n FROM shadowm_trades");
    const preSml = await client.query("SELECT COUNT(*) AS n FROM shadowm_timeline");
    const preCounts = {
      events:           Number(preEvt.rows[0].n),
      shadowm_trades:   Number(preSmT.rows[0].n),
      shadowm_timeline: Number(preSml.rows[0].n),
    };
    console.log(`[MIGRATION] Pre-migration counts — events: ${preCounts.events}, shadowm_trades: ${preCounts.shadowm_trades}, shadowm_timeline: ${preCounts.shadowm_timeline}`);
    client.release();
    client = null;

    // ── Execute SQL via psql (most reliable multi-statement runner) ─
    const migrations = [
      "001_shadow_os_v2_schema.sql",
      "002_runtime_domain_history.sql",
      "003_trade_intent_v2.sql",
    ];

    for (const migFile of migrations) {
      const sqlPath = path.join(__dirname, migFile);
      console.log(`[MIGRATION] Running: psql -f ${migFile}`);
      try {
        const output = execSync(
          `psql "${DATABASE_URL}" -f "${sqlPath}" --set ON_ERROR_STOP=1 2>&1`,
          { encoding: "utf8", timeout: 60000 }
        );
        const lines = output.split("\n").filter(l => l.trim());
        for (const line of lines) {
          console.log(`[MIGRATION]   psql: ${line}`);
        }
        console.log(`[MIGRATION] ${migFile} complete.`);
      } catch (err) {
        const output = err.stdout || err.stderr || err.message || "";
        console.error(`[MIGRATION] psql FAILED for ${migFile}:`);
        for (const line of output.split("\n")) {
          if (line.trim()) console.error(`[MIGRATION]   ${line}`);
        }
        throw new Error(`psql execution failed for ${migFile} — see output above`);
      }
    }

    // ── Reconnect for verification ─────────────────────────────────
    client = await pool.connect();

    // ── Verify all expected tables exist ──────────────────────────
    console.log("[MIGRATION] Verifying tables...");
    const { rows: allTableRows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
    );
    const foundTables = new Set(allTableRows.map(r => r.table_name));
    let tablesOk = true;
    for (const t of EXPECTED_TABLES) {
      if (foundTables.has(t)) {
        console.log(`[MIGRATION]   ✓ ${t}`);
      } else {
        console.error(`[MIGRATION]   ✗ MISSING: ${t}`);
        tablesOk = false;
      }
    }
    if (!tablesOk) throw new Error("One or more expected tables are missing after migration.");

    // ── Verify runtime_domains bootstrap rows ─────────────────────
    console.log("[MIGRATION] Verifying runtime_domains bootstrap...");
    const { rows: domainRows } = await client.query(
      "SELECT domain FROM runtime_domains ORDER BY domain"
    );
    const foundDomains = new Set(domainRows.map(r => r.domain));
    let domainsOk = true;
    for (const d of EXPECTED_DOMAINS) {
      if (foundDomains.has(d)) {
        console.log(`[MIGRATION]   ✓ domain: ${d}`);
      } else {
        console.error(`[MIGRATION]   ✗ MISSING domain: ${d}`);
        domainsOk = false;
      }
    }
    if (!domainsOk) throw new Error("One or more runtime_domains bootstrap rows are missing.");

    // ── Verify existing data is intact (sacred constraint) ─────────
    console.log("[MIGRATION] Verifying data integrity (sacred constraint)...");
    const postEvt = await client.query("SELECT COUNT(*) AS n FROM events");
    const postSmT = await client.query("SELECT COUNT(*) AS n FROM shadowm_trades");
    const postSml = await client.query("SELECT COUNT(*) AS n FROM shadowm_timeline");
    const post = {
      events:           Number(postEvt.rows[0].n),
      shadowm_trades:   Number(postSmT.rows[0].n),
      shadowm_timeline: Number(postSml.rows[0].n),
    };

    let dataOk = true;
    for (const [tbl, preCnt] of Object.entries(preCounts)) {
      const postCnt = post[tbl];
      if (postCnt >= preCnt) {
        console.log(`[MIGRATION]   ✓ ${tbl}: ${preCnt} → ${postCnt} rows (no data lost)`);
      } else {
        console.error(`[MIGRATION]   ✗ DATA LOSS DETECTED in ${tbl}: ${preCnt} → ${postCnt}`);
        dataOk = false;
      }
    }
    if (!dataOk) throw new Error("CRITICAL: Data loss detected — rolling back is required!");

    console.log("\n[MIGRATION] ════════════════════════════════════════");
    console.log("[MIGRATION] MIGRATIONS 001 + 002 + 003 COMPLETE — All checks passed.");
    console.log("[MIGRATION] ════════════════════════════════════════\n");

  } finally {
    if (client) client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error("\n[MIGRATION] FATAL:", err.message);
  process.exit(1);
});
