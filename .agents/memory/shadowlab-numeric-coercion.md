---
name: ShadowLab numeric/boolean coercion of nullable fields
description: Why research-layer coercion helpers must special-case null/"" before Number(), and keep engine abstention as NULL
---

# Nullable numeric/boolean coercion in the research layer

When projecting event-stream values into research columns, "no measurement" must
stay NULL — never collapse to a real `0` or `false`.

**Rule:** a numeric coercion helper must special-case `null`/`undefined`/`""`
BEFORE calling `Number()`, because `Number(null) === 0` and `Number("") === 0`.
A naive `Number.isFinite(Number(v)) ? Number(v) : null` turns an abstaining
engine's null winrate into a real `0` (0% ≠ "no data"), silently corrupting
expectancy/aggregates.

**Rule:** boolean coercion of an engine decision must be tri-state — `true` /
`false` / `null`. Engines legitimately abstain (`wouldTrade === null`); mapping
that to `false` fabricates a "would not trade" decision that never happened.

**Why:** the Shadow LAB is a measurement layer; a fabricated 0 or false is worse
than a gap because it looks like real signal. Postgres BOOLEAN columns round-trip
`null` as JS `null` (never `0`) via node-pg, so if a boolean column reads back a
number, the bug is in coercion upstream, not the driver.

**How to apply:** any helper like `numOrNull`/`boolOrNull` feeding research rows;
verify with a seeded row whose source field is explicitly `null` and assert the
stored column `IS NULL`, not `0`/`false`.
