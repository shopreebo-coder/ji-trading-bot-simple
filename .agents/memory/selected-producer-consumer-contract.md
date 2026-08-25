---
name: Selected producer/consumer contract
description: Lifecycle contract between cooperative signal notifications, ShadowLab evaluation production, and Selected Engine reads.
---

The producer of `shadow_engine_evals` must observe the same signal lifecycle that feeds Selected Engine notifications. If Selected Engine receives every `signal_detected` but ShadowLab evaluates only `trade_open`, every non-trading candidate will legitimately appear as missing evidence; retries cannot repair a producer scope mismatch.

**Why:** after a restart, upstream market-data or account failures can prevent `trade_open` while `signal_detected` continues. Persistent storage and a healthy reconciler then preserve the absence rather than losing data.

**How to apply:** before changing Selected Engine lookup logic, compare counts and IDs for `signal_detected`, `trade_open`, `lab_shadow_a..d`, and `shadow_engine_evals`. Keep the lifecycle contract explicit, and test restart recovery with both a signal that reaches `trade_open` and one that does not. Every enabled advisory producer, including D Meta, must be present in `advisory.outputs`; lifecycle/status queries must include its generated/delivered/read events.