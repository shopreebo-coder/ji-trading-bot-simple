---
name: Live AI cooperation policy
description: Rules governing Selected Engine and Shadow M participation in live trading.
---

Selected Engine is consulted before every strategy-approved entry, but only a HIGH-confidence `NO_TRADE` blocks the entry. HIGH-confidence `TRADE` is an allow signal; MEDIUM is advisory; LOW and unavailable evidence are fail-open. Shadow M remains advisory-only during open-trade management, with Live Exit Engine authority preserved.

**Why:** AI modules must cooperate with the live bot without changing established strategy/risk behavior or stopping trading when research services fail.

**How to apply:** Keep entry and exit cooperation telemetry explicit, preserve dynamic engine/knowledge discovery, and treat module errors, abstentions, and missing evidence as non-blocking unless the configured high-confidence block policy matches.