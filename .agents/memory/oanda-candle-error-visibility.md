---
name: OANDA candle error visibility
description: Preserve actionable OANDA candle request failures instead of treating them as empty market data.
---

OANDA candle requests must preserve HTTP status, response body/message, instrument, timeframe, requested count, endpoint, timeout, and duration in diagnostics, then propagate the failure. An empty array is valid-looking data and makes authentication or transport failures appear to be an ordinary M5 insufficiency.

**Why:** The workspace process showed OANDA HTTP 401 with an authorization error while the previous implementation converted that response into `[]`, causing `strategy()` to stop at `m5_insufficient` without identifying the credential/environment problem.

**How to apply:** When validating production, inspect the deployment process's effective OANDA environment/base URL and the emitted candle request diagnostics. Do not claim `>=60` candles or a `shadowGate()` lifecycle until a real production response records the status, candle count, and last-candle timestamp.