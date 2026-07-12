---
name: Knowledge artifact content-only checksum
description: Why knowledge-layer artifact checksums must exclude provenance, and how a leak churns versions on every restart.
---

# Knowledge artifact checksums are content-only

A knowledge artifact's identity (its checksum, used by the CAS upsert to decide
"new version or no-op") is computed over the built **content ONLY**. Provenance
(`run_id`, `build_id`, `config_hash`) lives in dedicated `knowledge_artifacts`
columns — **never inside the `value`/content** that gets hashed.

**Why:** the layer must be rollback-safe and must not churn. Every process boot
mints a fresh `run_id` (and possibly a new `build_id`/`config_hash`). If any
provenance-coupled field leaks into an artifact's content, the checksum changes on
every restart even when the underlying research is identical — so a redeploy
spuriously supersedes every artifact to a new version. Knowledge should
*accumulate*, not re-mint on restart.

**How to apply:** when writing or reviewing a KnowledgeManager builder
(`_build*`), the returned content object must be a pure function of the `shadow_*`
research rows — never of `this.provenance` or anything derived from it. Two
builders violated this during Sprint 6:
- `config/history` embedded the manager's own `config_hash` and an `isCurrent`
  flag. Fix: drop them; capture "current config" via the **env-derived surface**
  (changes only on a real config change) plus the observed config history.
- Any `isCurrent`/"latest run" marker computed against the live provenance is the
  same trap in disguise.

The recovery test is the guard: a second manager with a **different** provenance
rebuilding the same research must yield `changed: 0` and the active rows must
**retain the original provenance**. If that test starts minting versions, a
builder has coupled content to provenance.
