---
name: reconcileAll appends expectancy snapshots
description: Resolving a trade legitimately changes the expectancy knowledge artifact — do not assert it stays unchanged.
---

# ShadowLabManager.reconcileAll() appends an expectancy snapshot on resolve

When a trade resolves, `ShadowLabManager.reconcileAll()` appends a new row to
`shadow_expectancy_snapshots`. That row feeds the knowledge layer's
`expectancy/history` (and `confidence/history`) builder, so those artifacts
**legitimately** get a new version after a resolve.

**Why this matters:** it is tempting to write an idempotency test like "add a
resolved signal, rebuild knowledge, assert the research artifacts are unchanged."
That assertion is wrong — expectancy/confidence *should* change. It caused a
false failure during Sprint 6 and was removed.

**How to apply:** test knowledge idempotency by rebuilding over **genuinely
unchanged** research (no new resolves) and asserting `changed: 0`. To test
versioning, resolve a trade and assert the expectancy artifact bumps to v2 with a
`migration_from` chain — not that it stays put.
