---
name: Memory Integration workflow lock
description: Runtime advisory-lock interaction between Telemetry Dashboard and Memory Integration tests.
---

Memory Integration startup-recovery tests need to acquire a global PostgreSQL advisory lock. The running Telemetry Dashboard can hold that same lock, causing legitimate tests to report `lock-held-by-other-process`; stop the dashboard for the test run and restart it afterward.

**Why:** the dashboard process owns the live memory integration lifecycle, so a test process is correctly treated as a duplicate boot while the workflow is active.

**How to apply:** If MI integration tests fail only on lock acquisition, inspect active workflow ownership before changing Memory Manager code. Keep the workflow stopped only for the isolated test run, then restore it and verify startup logs.