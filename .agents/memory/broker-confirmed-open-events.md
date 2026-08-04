---
name: Broker-confirmed open events
description: Reliability rule for coupling successful broker orders to persisted trade_open telemetry.
---

**Rule:** An open-trade event must be emitted only after the broker confirms the order and its persistence promise has completed.

**Why:** Emitting before the broker request, or using an unawaited database write, can create ghost telemetry or leave a real broker order without the `trade_open` record after a restart or process interruption.

**How to apply:** Keep decision and risk logic unchanged; make the order helper return an explicit success result, emit `trade_open` only on success, and await the telemetry write before continuing.