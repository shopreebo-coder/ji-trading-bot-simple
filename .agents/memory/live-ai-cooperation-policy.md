---
name: Live AI cooperation policy
description: Rules governing Selected Engine and Shadow M participation in live trading.
---

Selected Engine is consulted before every strategy-approved entry, but only the
controlled Capital Gate owns the cooperation state. `ALLOW` requires complete,
same-signal, high-confidence A/B/C agreement plus Knowledge evidence; high-confidence
`NO_TRADE` yields `BLOCK`; conflict, LOW/MEDIUM confidence, missing evidence, or
service failure yields `ABSTAIN`. Shadow M remains advisory-only during open-trade
management, with Live Exit Engine authority preserved.

**Why:** the controlled phase explicitly requires fail-closed capital protection;
broker ownership, execution parameters, and established strategy/risk behavior still
remain in the Live Bot.

**How to apply:** Keep entry and exit cooperation telemetry explicit, preserve
dynamic engine/knowledge discovery for research, and never let persisted or
out-of-scope engines bypass the exact A/B/C Capital Gate contract.