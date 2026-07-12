"use strict";
/**
 * SHADOW OS v2 — Sprint 6: KnowledgeRepository
 *
 * The ONLY component that reads/writes the knowledge_* tables. It owns:
 *   • immutable, versioned artifact storage in knowledge_artifacts
 *   • point-in-time manifests in knowledge_snapshots
 *   • read helpers for the Knowledge API + statistics
 *
 * Immutability + versioning contract (INVARIANT 3 — knowledge is never deleted,
 * only superseded):
 *   Each (domain, artifact) has AT MOST ONE active row (superseded_at IS NULL,
 * enforced by the partial unique index idx_ka_active). Writing new content:
 *     - identical checksum to the active row      → NO-OP (idempotent)
 *     - identical checksum to a superseded row    → skip (content already recorded)
 *     - new content                               → supersede active + INSERT v+1,
 *                                                    migration_from = previous id
 *
 * Concurrency + rollback safety (single live process, but redeploys briefly
 * overlap on Railway):
 *   The supersede+insert runs in ONE PostgreSQL transaction on ONE pooled client
 *   (BEGIN/COMMIT). The supersede uses a CAS guard
 *   (WHERE id=$1 AND superseded_at IS NULL); rowCount=0 ⇒ a concurrent writer won
 *   ⇒ ROLLBACK. The two unique indexes (idx_ka_active + idx_ka_checksum) are the
 *   ultimate backstop: a losing racer's INSERT raises 23505 and is rolled back +
 *   reported as a no-op. Exactly one active row always survives.
 *
 * Pool-safety (replit.md "CAS pool deadlock" gotcha): the artifact value +
 * checksum are computed by the CALLER before a client is acquired, and this
 * transaction NEVER calls another method that acquires a second client while
 * holding one. It holds a single connection only for supersede+insert.
 *
 * This layer is READ-ONLY with respect to live/shadow/risk: it only ever reads
 * the Shadow LAB tables (via the KnowledgeManager builders) and writes its own
 * knowledge_* tables. Nothing here can influence a live or shadow decision.
 */

const { checksumValue, confidenceScore, provenanceNote, canonicalJson } = require("./knowledgeProvenance");

const PG_UNIQUE_VIOLATION = "23505";

class KnowledgeRepository {
  /**
   * @param {object} opts
   * @param {object} opts.db  db-adapter instance (PostgreSQL or SQLite)
   */
  constructor({ db } = {}) {
    if (!db) throw new Error("KnowledgeRepository requires a db adapter");
    this.db = db;
    this._pg = !!db._pool; // PostgreSQL transaction path available
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** Active artifact row for (domain, artifact), or null. */
  async getActive(domain, artifact) {
    return this.db.get(
      "SELECT * FROM knowledge_artifacts WHERE domain = ? AND artifact = ? AND superseded_at IS NULL",
      domain, artifact
    );
  }

  /** A specific version of an artifact, or null. */
  async getVersion(domain, artifact, version) {
    return this.db.get(
      "SELECT * FROM knowledge_artifacts WHERE domain = ? AND artifact = ? AND version = ?",
      domain, artifact, Number(version)
    );
  }

  /** Full version history (newest first) for (domain, artifact). */
  async getHistory(domain, artifact) {
    return this.db.all(
      `SELECT id, version, checksum, byte_size, training_events, confidence,
              superseded_at, created_at, run_id, build_id, config_hash,
              source_window_from, source_window_to, migration_from, notes
         FROM knowledge_artifacts
        WHERE domain = ? AND artifact = ?
        ORDER BY version DESC`,
      domain, artifact
    );
  }

  /** All currently-active artifacts (metadata only — no value payload). */
  async listActive() {
    return this.db.all(
      `SELECT id, domain, artifact, version, checksum, byte_size, training_events,
              confidence, run_id, build_id, config_hash,
              source_window_from, source_window_to, created_at, notes
         FROM knowledge_artifacts
        WHERE superseded_at IS NULL
        ORDER BY domain, artifact`
    );
  }

  /** All active artifacts WITH their value payloads (for read-only export). */
  async exportActive() {
    return this.db.all(
      `SELECT id, domain, artifact, version, value, checksum, byte_size, training_events,
              confidence, run_id, build_id, config_hash, source_window_from, source_window_to,
              created_at, notes
         FROM knowledge_artifacts
        WHERE superseded_at IS NULL
        ORDER BY domain, artifact`
    );
  }

  /** Read-only aggregate statistics over the whole knowledge store. */
  async statistics() {
    const total = await this.db.get("SELECT COUNT(*) AS n FROM knowledge_artifacts");
    const active = await this.db.get(
      "SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS bytes FROM knowledge_artifacts WHERE superseded_at IS NULL"
    );
    const byDomain = await this.db.all(
      `SELECT domain, COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS bytes
         FROM knowledge_artifacts
        WHERE superseded_at IS NULL
        GROUP BY domain
        ORDER BY domain`
    );
    const snaps = await this.db.get(
      "SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM knowledge_snapshots"
    );
    return {
      artifacts: {
        total: Number(total?.n ?? 0),
        active: Number(active?.n ?? 0),
        superseded: Number(total?.n ?? 0) - Number(active?.n ?? 0),
        activeBytes: Number(active?.bytes ?? 0),
      },
      byDomain: byDomain.map((d) => ({ domain: d.domain, active: Number(d.n), bytes: Number(d.bytes) })),
      snapshots: { total: Number(snaps?.n ?? 0), latest: snaps?.latest ?? null },
    };
  }

  /** Most recent knowledge snapshots (manifest metadata only). */
  async listSnapshots(limit = 100) {
    const n = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    return this.db.all(
      `SELECT id, artifact_count, total_bytes, manifest_checksum,
              run_id, build_id, config_hash, created_at
         FROM knowledge_snapshots
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      n
    );
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /**
   * Store new content for (domain, artifact) as an immutable version.
   * The checksum covers CONTENT ONLY (provenance lives in columns), so a
   * rebuild that produces identical content is a genuine no-op.
   *
   * @param {string} domain
   * @param {string} artifact
   * @param {*}      content   pure artifact value (NO provenance mixed in)
   * @param {{runId:string, buildId:string, configHash:string}} prov
   * @param {{trainingEvents?:number, tier?:string, windowFrom?:string, windowTo?:string}} [meta]
   * @returns {Promise<{changed:boolean, reason:string, version:number, id:(number|null), checksum:string}>}
   */
  async upsertVersion(domain, artifact, content, prov, meta = {}) {
    // Compute everything BEFORE acquiring a client (pool-safety).
    const value = content ?? null;
    const checksum = checksumValue(value);
    const valueJson = canonicalJson(value);
    const byteSize = Buffer.byteLength(valueJson, "utf8");
    const trainingEvents = Number.isFinite(Number(meta.trainingEvents)) ? Number(meta.trainingEvents) : 0;
    const confidence = confidenceScore(trainingEvents);
    const notes = provenanceNote(prov, {
      trainingEvents,
      tier: meta.tier,
      windowFrom: meta.windowFrom,
      windowTo: meta.windowTo,
    });
    const row = {
      domain, artifact, valueJson, checksum, byteSize, trainingEvents, confidence, notes,
      runId: prov.runId, buildId: prov.buildId, configHash: prov.configHash,
      windowFrom: meta.windowFrom ?? null, windowTo: meta.windowTo ?? null,
    };
    return this._pg ? this._upsertPg(row) : this._upsertSeq(row);
  }

  /** PostgreSQL path — single-client transaction with CAS guard. */
  async _upsertPg(r) {
    const client = await this.db._pool.connect();
    try {
      await client.query("BEGIN");

      // Lock the active row (if any) for this key to serialize concurrent writers.
      const active = (await client.query(
        "SELECT id, version, checksum FROM knowledge_artifacts WHERE domain=$1 AND artifact=$2 AND superseded_at IS NULL FOR UPDATE",
        [r.domain, r.artifact]
      )).rows[0];

      // Identical content already active → idempotent no-op.
      if (active && active.checksum === r.checksum) {
        await client.query("COMMIT");
        return { changed: false, reason: "unchanged", version: Number(active.version), id: Number(active.id), checksum: r.checksum };
      }

      // Content matches a previously-superseded version (oscillation). With
      // monotone builders this is unreachable; do NOT resurrect/duplicate.
      const prior = (await client.query(
        "SELECT id, version FROM knowledge_artifacts WHERE domain=$1 AND artifact=$2 AND checksum=$3 LIMIT 1",
        [r.domain, r.artifact, r.checksum]
      )).rows[0];
      if (prior) {
        await client.query("ROLLBACK");
        return { changed: false, reason: "reverted-to-prior", version: Number(prior.version), id: Number(prior.id), checksum: r.checksum };
      }

      // Supersede the active row with a compare-and-swap guard.
      if (active) {
        const upd = await client.query(
          "UPDATE knowledge_artifacts SET superseded_at = NOW() WHERE id=$1 AND superseded_at IS NULL",
          [active.id]
        );
        if (upd.rowCount === 0) {
          await client.query("ROLLBACK");
          return { changed: false, reason: "cas-miss", version: Number(active.version), id: Number(active.id), checksum: r.checksum };
        }
      }

      // Next version is computed INSIDE the transaction.
      const nextVersion = Number(
        (await client.query(
          "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM knowledge_artifacts WHERE domain=$1 AND artifact=$2",
          [r.domain, r.artifact]
        )).rows[0].v
      );

      const ins = await client.query(
        `INSERT INTO knowledge_artifacts
           (domain, artifact, version, value, checksum, byte_size, training_events, confidence,
            migration_from, notes, run_id, build_id, config_hash, source_window_from, source_window_to)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, version`,
        [r.domain, r.artifact, nextVersion, r.valueJson, r.checksum, r.byteSize, r.trainingEvents, r.confidence,
         active ? active.id : null, r.notes, r.runId, r.buildId, r.configHash, r.windowFrom, r.windowTo]
      );

      await client.query("COMMIT");
      return {
        changed: true,
        reason: active ? "superseded" : "created",
        version: Number(ins.rows[0].version),
        id: Number(ins.rows[0].id),
        previousId: active ? Number(active.id) : null,
        checksum: r.checksum,
      };
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) { /* connection may be dead */ }
      // A losing racer trips a unique index — treat as an idempotent no-op.
      if (e && e.code === PG_UNIQUE_VIOLATION) {
        return { changed: false, reason: "conflict", version: null, id: null, checksum: r.checksum };
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * SQLite fallback — sequential (no BEGIN/COMMIT). Only reached in dev on the
   * SQLite backend, where the KnowledgeManager is the single writer, so the
   * unique indexes still guarantee at most one active row.
   */
  async _upsertSeq(r) {
    const active = await this.getActive(r.domain, r.artifact);
    if (active && active.checksum === r.checksum) {
      return { changed: false, reason: "unchanged", version: Number(active.version), id: Number(active.id), checksum: r.checksum };
    }
    const prior = await this.db.get(
      "SELECT id, version FROM knowledge_artifacts WHERE domain = ? AND artifact = ? AND checksum = ?",
      r.domain, r.artifact, r.checksum
    );
    if (prior) {
      return { changed: false, reason: "reverted-to-prior", version: Number(prior.version), id: Number(prior.id), checksum: r.checksum };
    }
    if (active) {
      await this.db.run(
        "UPDATE knowledge_artifacts SET superseded_at = CURRENT_TIMESTAMP WHERE id = ? AND superseded_at IS NULL",
        active.id
      );
    }
    const maxV = await this.db.get(
      "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM knowledge_artifacts WHERE domain = ? AND artifact = ?",
      r.domain, r.artifact
    );
    const nextVersion = Number(maxV.v);
    const res = await this.db.run(
      `INSERT INTO knowledge_artifacts
         (domain, artifact, version, value, checksum, byte_size, training_events, confidence,
          migration_from, notes, run_id, build_id, config_hash, source_window_from, source_window_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.domain, r.artifact, nextVersion, r.valueJson, r.checksum, r.byteSize, r.trainingEvents, r.confidence,
      active ? active.id : null, r.notes, r.runId, r.buildId, r.configHash, r.windowFrom, r.windowTo
    );
    return {
      changed: true,
      reason: active ? "superseded" : "created",
      version: nextVersion,
      id: res.lastInsertRowid ?? null,
      previousId: active ? Number(active.id) : null,
      checksum: r.checksum,
    };
  }

  /**
   * Record a point-in-time manifest of the ACTIVE artifact set. Idempotent:
   * dedupe_key = manifest checksum, so an unchanged active set (e.g. on restart)
   * inserts nothing.
   *
   * @param {Array<{id:number, domain:string, artifact:string, version:number, checksum:string, byte_size:number}>} manifestRows
   * @param {{runId:string, buildId:string, configHash:string}} prov
   */
  async insertSnapshot(manifestRows, prov) {
    const items = (manifestRows || []).map((m) => ({
      id: Number(m.id),
      domain: m.domain,
      artifact: m.artifact,
      version: Number(m.version),
      checksum: m.checksum,
      byte_size: Number(m.byte_size ?? 0),
    }));
    // Manifest checksum covers identity+version+checksum only (byte_size is
    // derivable and id is storage-local), so it is stable + reproducible.
    const checksumContent = items.map(({ domain, artifact, version, checksum }) => ({ domain, artifact, version, checksum }));
    const manifestChecksum = checksumValue(checksumContent);
    const totalBytes = items.reduce((s, m) => s + m.byte_size, 0);
    const manifestJson = canonicalJson(items);
    const cast = this._pg ? "?::jsonb" : "?";

    const res = await this.db.run(
      `INSERT INTO knowledge_snapshots
         (artifact_count, total_bytes, manifest, manifest_checksum, run_id, build_id, config_hash, dedupe_key)
       VALUES (?, ?, ${cast}, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      items.length, totalBytes, manifestJson, manifestChecksum,
      prov.runId, prov.buildId, prov.configHash, manifestChecksum
    );

    return {
      inserted: (res.changes ?? 0) > 0,
      manifestChecksum,
      artifactCount: items.length,
      totalBytes,
    };
  }
}

module.exports = { KnowledgeRepository };
