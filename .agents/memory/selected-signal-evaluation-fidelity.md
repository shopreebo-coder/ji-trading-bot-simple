---
name: Selected signal evaluation fidelity
description: Signal identity constraint for cooperative Selected Engine contexts built before Shadow LAB finishes recording evaluations.
---

The cooperative Selected Engine path may receive a signal before Shadow LAB has written A/B/C/D rows, but every evaluation included in that context must have the same `signalId` as the live signal. Missing same-signal rows should remain absent/abstain until a later rebuild; never substitute the latest row for each engine.

**Why:** latest-per-engine substitution creates a mixed DecisionContext that looks complete but combines opinions from unrelated signals. This is especially easy to trigger because the cooperative notify path is fire-and-forget and Shadow LAB is polled asynchronously.

**How to apply:** any context build receiving an inline signal must use the signal-scoped evaluation query. The explicit `signalId` rebuild and later Shadow LAB completion are the source of truth for a complete A–D context.