---
name: TIM cancelIntent state machine
description: cancelIntent accepts APPROVED as a valid source status; concurrent approve+cancel can both succeed
---

**Rule:** `cancelIntent()` in TradeIntentManager accepts CREATED, VALIDATED, *and* APPROVED as valid source statuses. This means a concurrent `approveIntent` + `cancelIntent` on the same VALIDATED intent can both succeed sequentially (approve: VALIDATED→APPROVED, then cancel: APPROVED→CANCELLED).

**Why:** Business logic — an already-approved intent is still cancellable before execution. This is intentional design from SHADOW_OS_V2.md.

**How to apply:** When writing concurrent-transition tests involving approve and cancel, do NOT assert `fulfilled.length === 1`. Instead assert `fulfilled.length >= 1` and verify the final state is in `["APPROVED", "CANCELLED"]`. Two concurrent approvals (approve vs approve) are the correct test for "exactly one winner" semantics.
