"use strict";
/**
 * Sprint 6 — Knowledge Layer feature-flag / no-op safety test.
 *
 * The Knowledge Layer is gated by KNOWLEDGE_LAYER (default OFF). When off, the
 * server never calls start(), so the layer must be a complete no-op. This test
 * proves the manager honours that contract at the object level:
 *   1. Constructing a KnowledgeManager performs ZERO database writes and installs
 *      NO timers/handlers (flag-off ≡ never start ≡ nothing happens).
 *   2. Read-only calls (getStatistics) never write.
 *   3. Writes happen ONLY when start()/snapshotAll() is explicitly invoked
 *      (i.e. only when the flag is ON) — verified by an explicit build producing
 *      artifacts, then stop() cleanly halting the layer.
 *
 * Requires PostgreSQL; skips cleanly otherwise.
 */

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { ensureSchema } = require("../../migrations/autoMigrate");
const { db, USE_PG } = require("../../db-adapter");
const { KnowledgeManager } = require("../../managers/KnowledgeManager");
const { createProvenance } = require("../../managers/knowledgeProvenance");

const IS_PG = USE_PG;
const NS = `T6F-${crypto.randomUUID().slice(0, 8)}`;
const PREFIX = `test-${NS}-`;
const PROV = createProvenance({ runId: `km-${NS}`, buildId: "v40.1+t6flag00000", configHash: crypto.createHash("sha256").update(NS).digest("hex") });

async function activeCount() {
  const r = await db.get("SELECT COUNT(*) AS n FROM knowledge_artifacts WHERE domain LIKE ? AND superseded_at IS NULL", `${PREFIX}%`);
  return Number(r.n);
}

before(async () => {
  if (!IS_PG) return;
  await ensureSchema(db._pool, { log: () => {} });
});

after(async () => {
  if (!IS_PG) return;
  try {
    await db._pool.query("DELETE FROM knowledge_artifacts WHERE domain LIKE $1", [`${PREFIX}%`]);
    await db._pool.query("DELETE FROM knowledge_snapshots WHERE run_id = $1", [PROV.runId]);
  } catch (_) {}
  await db._pool.end();
});

test("flag OFF ≡ no-op; writes only on explicit start", { skip: !IS_PG ? "no PostgreSQL DATABASE_URL" : false }, async (t) => {
  await t.test("construction is side-effect free (flag off = never started)", async () => {
    assert.equal(await activeCount(), 0, "clean slate for this prefix");
    const mgr = new KnowledgeManager({ db, provenance: PROV, domainPrefix: PREFIX, pollIntervalMs: 3_600_000 });
    assert.equal(mgr._timer, null, "no timer installed on construction");
    assert.equal(mgr._running, false, "not running on construction");
    assert.equal(await activeCount(), 0, "construction wrote nothing");

    // A read-only call must also never write.
    await mgr.getStatistics();
    assert.equal(await activeCount(), 0, "getStatistics wrote nothing");
  });

  await t.test("explicit build (flag on) writes; stop() halts cleanly", async () => {
    const mgr = new KnowledgeManager({ db, provenance: PROV, domainPrefix: PREFIX, pollIntervalMs: 3_600_000 });
    await mgr.start();
    assert.equal(mgr._running, true, "running after start()");
    // The Shadow LAB tables always contain some data on the dev DB, so at least
    // the global-scope builders produce artifacts once the layer is on.
    assert.ok(await activeCount() >= 1, "an explicitly started layer builds artifacts");
    mgr.stop();
    assert.equal(mgr._running, false, "stopped");
    assert.equal(mgr._timer, null, "timer cleared on stop()");
  });
});
