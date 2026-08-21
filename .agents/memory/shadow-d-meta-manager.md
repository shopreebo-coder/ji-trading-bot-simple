---
name: Shadow D Meta Manager
description: Architecture and integration pattern for ShadowDMetaManager — the rebuilt Shadow D Meta Trade Manager.
---

## What it is
`telemetry/managers/ShadowDMetaManager.js` — advisory-only Meta Trade Manager with two decision paths:
- Pre-trade: `analyzeEntry()` → ENTER / WAIT / REJECT / INSUFFICIENT_DATA (called from `shadowGate()` in `shadowlab.js`)
- Post-entry: `analyzePosition()` → HOLD / HOLD_WITH_CAUTION / PROTECT / REDUCE / EXIT (called from `/api/cooperative/advisory` in `server.js`)

## Integration points
- `shadowlab.js` — `shadowGate()` calls `ShadowDMetaManager.analyzeAndLogEntry()` synchronously after A/B/C/D. Result in `advisory.dMeta`.
- `server.js` — `_fetchStoredEvals(signalId)` helper fetches stored A/B/C from DB, then calls `ShadowDMetaManager.analyzeAndLogPosition()`. Result in response body `dMeta`.
- New endpoint: `GET /api/shadow-d/status`
- New event types: `lab_shadow_d_meta_entry` (linked by signalId), `lab_shadow_d_meta_position` (linked by tradeId + signalId)

## Test pattern — avoid DB pool hang
`ShadowDMetaManager` lazy-requires `telemetry/index.js` only on first `logEvent` call. In test files, set `process.env.SHADOW_D_META_NO_LOG = "1"` BEFORE requiring the module to skip all DB writes and prevent PostgreSQL pool from keeping the test process alive.

**Why:** `require("../index")` opens a PostgreSQL pool that never auto-closes. Lazy import + NO_LOG flag means tests exit cleanly.

**How to apply:** Add `process.env.SHADOW_D_META_NO_LOG = "1"` as the first line of any unit test that imports ShadowDMetaManager directly.

## Sacred constraints (verified by 33 tests)
- Never sets `blocked = true`
- Never has `execute`, `placeTrade`, `closePosition` keys
- Every output has `advisoryOnly: true` + `authoritativeLayer: "live_bot"`
- `index.js` (Live Bot) was NOT modified

## Runtime toggle
`SHADOW_D_META_ENABLED` env var (default: on). Also `"shadow-d-meta": true` in `runtime-control.js` DEFAULT_RUNTIME_MODULES.
