---
name: Shadow M architecture
description: How Shadow M (Exit Lab) works — event feed, strategy engine, DB tables, file locations
---

Shadow M is entirely event-driven — no OANDA API polling needed.

**Why:** The live bot (index.js) already emits `trade_state_snapshot` every 30 seconds via
`logEvent()`, which in turn fires `emitter.emit("event", row)`. Shadow M simply listens to
this existing stream. This avoids duplicate OANDA calls and guarantees Shadow M uses the
exact same price data as the live bot.

**Event contract:**
- `trade_open` → signalId, symbol, side, stopLossPips, takeProfitPips, atrPips, ts
- `trade_state_snapshot` → signalId, symbol, side, pips, mfe, mae, minutesOpen, ts (every 30s)
- `trade_close` → signalId, symbol, profitPips, mfe, mae, profitGivenBackPips, duration, ts

**Exit strategies (7):** ATR Trailing (1.5×ATR pullback from MFE), Profit Protection
(pip < MFE×0.6 once MFE > TP×0.5), Time 1h/2h/4h, Breakeven Guard (0p when MFE > TP×0.25),
TP Extended (1.5× TP).

**DB tables:** `shadowm_trades` (UNIQUE on signal_id, upsert), `shadowm_timeline` (per-tick).
Full tracking state serialised as JSON in `data` column → enables restart restoration.

**Files:**
- `telemetry/shadowm.js` — core module + getShadowMStats/Trades/Timeline
- `telemetry/server.js` — /api/shadowm/status|trades|active|dashboard + shadowM.start()
- `telemetry/public/index.html` — LabShadowM component, "Exit Lab" subtab

**How to apply:** When adding new exit strategies, add to _newStrategies() + _checkStrategies() + _rankStrategies() + _toRow() + DB column. No changes to index.js needed.
