---
name: Exit Engine X shadow boundary
description: Exit Engine X may observe and log exit recommendations, but Live Exit remains the only executor until a statistically validated comparison.
---

Exit Engine X must remain shadow-only: it may calculate health, momentum, expected future value, similarity, knowledge, confidence, votes, lifecycle, Exit IQ, and regret, but it must never close a trade, modify SL/TP, or enter the Cooperative decision path.

**Why:** The project requires a minimum 300–500 trade comparison against the existing Live Exit before any consideration of replacing or influencing it.

**How to apply:** Keep integration limited to confirmed trade lifecycle telemetry and append-only `exit_engine_x_*` events. Any future promotion requires a separate statistical validation and explicit approval.