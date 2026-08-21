# OANDA 401 Diagnostic Report

Scope: read-only authentication-path audit
Date: 2026-08-21 (Europe/London)
Safety: No code, database, ENV, Live Bot, Shadow module, commit, deploy, or workflow configuration was modified. No secret value was printed or stored.

## Executive conclusion

Confirmed cause in the currently running Replit workspace process: C — wrong or missing ENV variable at runtime. The process receives neither OANDA_API_KEY nor OANDA_ACCOUNT_ID.

The local .env contains SYMBOLS but no OANDA credential variables. The bot startup log confirms: environment=practice(default), baseUrl=https://api-fxpractice.oanda.com, accountIdPresent=false, apiKeyPresent=false.

The candle request therefore constructs the effective header as a Bearer header over an undefined key. OANDA returns HTTP 401 with: Insufficient authorization to perform request. This does not prove that a real token is revoked; the current process is not sending a real token under the code's expected name.

Railway limitation: this workspace has no Railway runtime access. It is not possible here to prove whether Railway has the variables, has different names, or is running an older process. If Railway is the intended live runtime, the deployment-level classification may be F (stale or mismatched process ENV) or the Railway equivalent of C.

## 1. Token ENV variable

Active code reads process.env.OANDA_API_KEY in index.js. The telemetry-only TelemetryReconciler reads the same name. No active code path was found using OANDA_API_TOKEN, OANDA_TOKEN, or another token variable.

## 2. Account ID ENV variable

Active code reads process.env.OANDA_ACCOUNT_ID in index.js. TelemetryReconciler reads the same name. No active code path was found using ACCOUNT_ID or OANDA_ACCOUNT.

## 3. LIVE versus PRACTICE

The selector is process.env.OANDA_ENV === live for LIVE; every other value, including missing or empty, selects PRACTICE. No separate LIVE/PRACTICE selector is used.

## 4. Exact OANDA base URLs

LIVE: https://api-fxtrade.oanda.com
PRACTICE/default: https://api-fxpractice.oanda.com
Candle request: base URL plus /v3/instruments/<symbol>/candles.
Observed current endpoint: https://api-fxpractice.oanda.com/v3/instruments/EUR_USD/candles, with equivalent paths for GBP_USD, USD_JPY, and XAU_USD.
The active code does not read OANDA_BASE_URL, so that variable cannot override the computed URL.

## 5. Authorization header

index.js assigns API_KEY from process.env.OANDA_API_KEY and constructs headers with Authorization: Bearer plus API_KEY, together with Content-Type: application/json. Axios passes this same headers object to OANDA requests.
TelemetryReconciler constructs Authorization: Bearer plus env.OANDA_API_KEY.
There is no trimming, quoting removal, decoding, alternate auth scheme, or later header rewrite. With the current missing key, the effective value is an undefined bearer value; the header template itself is structurally correct when a real key is present.

## 6. Fallback/default analysis

Token: no fallback; only OANDA_API_KEY is read.
Account ID: no fallback; only OANDA_ACCOUNT_ID is read.
Environment: missing OANDA_ENV defaults to practice.
Base URL: computed from OANDA_ENV; OANDA_BASE_URL is ignored.
dotenv.config() loads .env at index startup, but the inspected local .env has no OANDA variables.
No alternate credential variable was found that could override a Railway value.

## 7. Effective process ENV versus Railway

The configured local workflow is: PORT=8083 plus telemetry flags, then node telemetry/server.js. The telemetry server spawns node index.js. Effective ENV-name inspection of both running processes found:
- OANDA_API_KEY: absent
- OANDA_ACCOUNT_ID: absent
- OANDA_ENV: absent

The logs independently say: TELEMETRY RECONCILER OANDA credentials absent — dormant, and apiKeyPresent=false/accountIdPresent=false. This is a workspace-local Replit process, not a Railway process. Railway state is unconfirmed.

## 8. Candle versus account/order credentials

Yes for the main bot: candle and account/order requests use the same headers object and therefore the same OANDA_API_KEY.
Candles: GET /v3/instruments/<symbol>/candles.
Account/open trades: GET /v3/accounts/<accountId>/openTrades.
Pricing: GET /v3/accounts/<accountId>/pricing.
Account summary: GET /v3/accounts/<accountId>/summary.
Orders: POST /v3/accounts/<accountId>/orders.
Close: PUT /v3/accounts/<accountId>/trades/<tradeId>/close.
The account ID is not in the candle URL but is in account/order URLs. Missing account ID can therefore cause account endpoint failures independently, while candle authentication still fails from the missing token.
TelemetryReconciler also uses the same token and environment selection for its GET-only requests and remains dormant when credentials are absent.

## Evidence

1. Startup log: environment=practice(default), practice base URL, accountIdPresent=false, apiKeyPresent=false.
2. Startup log: OANDA credentials absent — dormant for Telemetry Reconciler.
3. Running-process ENV-name inspection: no OANDA credential names in the bot or telemetry server process.
4. Local .env key inspection: SYMBOLS present; no OANDA keys.
5. Candle logs for all four symbols: HTTP 401 and response body Insufficient authorization to perform request.
6. Account/pricing/open-trade logs: HTTP 400, consistent with an undefined account path in the current local process.
7. OANDA responded from the expected practice host, establishing endpoint reachability.

## Classification

A invalid/revoked token: not determinable; no real token is present locally.
B token/account mismatch: not determinable; neither real token nor account ID is present locally.
C wrong ENV variable: CONFIRMED for the current workspace; the names read by code are absent.
D malformed Authorization header: secondary symptom, not root cause; the template is correct but receives no key.
E wrong endpoint/environment: unlikely; the practice host is correct for the default and returned an auth response.
F stale deployment/process ENV: possible for Railway; local separation from Railway is confirmed.

## Harmless authenticated API check

Not performed because the current runtime has no OANDA credentials. Sending a request with the missing key would only reproduce the known unauthenticated 401 and would not test existing credentials. No order, trade, pricing mutation, or other write operation was attempted.

## Recommended fix

1. In the intended runtime, likely Railway, verify exact names OANDA_API_KEY and OANDA_ACCOUNT_ID.
2. Verify OANDA_ENV is exactly live for a live account, or practice/unset for a practice account.
3. Restart or redeploy the intended service so the new process receives the variables.
4. Confirm safe startup metadata only: apiKeyPresent=true, accountIdPresent=true, selected environment, and base URL.
5. Run one GET-only OANDA check from that same runtime and confirm HTTP 200 before evaluating candle data.
6. Do not set OANDA_BASE_URL expecting it to control this implementation; it is not read.

## Is token regeneration necessary?

No, not based on this audit. Regeneration is not justified until a valid token is present in the intended process and a GET-only request using that token still returns 401. First correct or verify exact ENV names and process propagation. If a valid Railway request then returns 401, investigate revocation/expiry and account-environment pairing before regenerating.

Generated from read-only code, process-environment-name, workflow-log, and configuration inspection. Secret values were not accessed for display, printed, or included.