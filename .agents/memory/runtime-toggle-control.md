---
name: Cross-process runtime toggles
description: Runtime ON/OFF controls for modules whose code runs in the spawned bot process.
---

Runtime controls for the telemetry server and the spawned Live Bot must use a shared atomic file (or another cross-process channel), not only an in-memory server registry. The synchronous Shadow Gate reads that channel on each invocation and defaults fail-open when it is unavailable.

**Why:** The dashboard server and `index.js` do not share memory, while the Live Bot entrypoint is intentionally frozen. An in-memory toggle would report OFF in the dashboard while Shadow Gate continued running.

**How to apply:** Keep lifecycle adapters in the server registry for parent-process managers; use the shared control channel for child-process Shadow engines. Protected execution and observability surfaces should remain visible but non-toggleable.