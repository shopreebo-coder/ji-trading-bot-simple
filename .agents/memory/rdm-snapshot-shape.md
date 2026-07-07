---
name: RDM takeSnapshot return shape
description: takeSnapshot() return shape is { snapshotId, createdAt, domainCount, reason } — not { domains }
---

**Rule:** `RuntimeDomainManager.takeSnapshot()` returns `{ snapshotId: number, createdAt: Date, domainCount: number, reason: string }`. The domain data itself is stored in the `system_snapshots` table, not returned inline.

**Why:** Snapshots can be large (many domains with JSONB values); returning them inline would be wasteful for the common use case of "did the snapshot succeed?".

**How to apply:** When testing or consuming takeSnapshot, assert on `snapshot.snapshotId > 0` and `snapshot.domainCount >= N`. Never access `snapshot.domains` — it does not exist on the return value.
