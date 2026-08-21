# OANDA Railway Runtime Check — Read Only

Date: 2026-08-21 (Europe/London)
Scope: actual Railway production runtime verification requested; no local Replit process used as evidence for Railway.
Safety: no code, ENV, database, Live Bot, Shadow module, commit, deployment, restart, or redeploy was modified. No secret value was printed, returned, stored, or logged.

## Executive result

The actual Railway process ENV and an authenticated OANDA request from inside Railway could NOT be verified from the available read-only interfaces.

Available access exposed GitHub deployment records created by railway-app[bot], but not Railway shell access, Railway runtime logs, Railway environment-variable presence, or an execution channel inside the Railway service. Replit's deployment API also reports no published Replit deployment and is not the Railway runtime.

Therefore the requested Railway classification remains UNDETERMINED. The available evidence does not justify classifying the issue as A, B, C, D, or E for Railway. It also cannot prove that the 401 is Replit-only.

## Requested runtime facts

| Fact | Result | Evidence / limitation |
|---|---|---|
| Railway OANDA_API_KEY present | UNKNOWN | Railway process ENV is not exposed through the available GitHub/Replit interfaces. |
| Railway OANDA_ACCOUNT_ID present | UNKNOWN | Same limitation. |
| Railway OANDA_ENV value | UNKNOWN | No Railway runtime log or ENV inspection available. |
| Railway selected base URL | UNKNOWN | Depends on OANDA_ENV inside Railway. |
| Railway process/service name | PARTIALLY AVAILABLE | GitHub records expose Railway environment names, not the process command or service identity. |
| Railway deployment/version | CONFIRMED at deployment-record level | Latest visible records use commit SHA 9d034883bc858fa487df575d633f1d32b085a24e. |
| Railway runtime health | NOT CONFIRMED | GitHub deployment status was success, but this is not runtime log or credential proof. |

## Deployment records observed

GitHub repository: shopreebo-coder/ji-trading-bot-simple.

The latest visible GitHub deployment records were created by railway-app[bot] on 2026-08-18 and target multiple production environments, including:
- resourceful-radiance / production
- distinguished-healing / production
- attractive-bravery / production
- tranquil-patience / production
- practical-spontaneity / production

There were 20 visible Railway production deployment records in the queried page. All queried records used SHA 9d034883bc858fa487df575d633f1d32b085a24e and the latest status returned by GitHub was success. This fan-out means a specific Live Bot service cannot be safely selected from the records alone.

The latest status records contain target URLs, but the available records do not identify an authenticated Railway runtime endpoint or expose process environment metadata. No target URL was used to send an OANDA request.

## OANDA authenticated check

Not performed. There is no execution channel inside the actual Railway service and no safe way from this workspace to make the request using that service's existing OANDA credentials. A request from local Replit would violate the scope of this check and would not test Railway credentials.

No OANDA GET request was sent from the local environment as a substitute. No order, trade, pricing mutation, close, cancel, or other account-state operation was attempted.

## What is and is not proven

Proven:
- Railway deployment integrations exist and GitHub contains railway-app[bot] production deployment records.
- Multiple Railway production environments received the same visible SHA 9d034883bc858fa487df575d633f1d32b085a24e.
- The GitHub deployment statuses queried were success.
- GitHub deployment records do not expose the effective OANDA ENV or runtime logs.
- Replit's own deployment service reported isDeployed=false; this is not evidence about Railway.

Not proven:
- Whether Railway receives OANDA_API_KEY.
- Whether Railway receives OANDA_ACCOUNT_ID.
- Whether Railway receives OANDA_ENV.
- Whether Railway selects LIVE or PRACTICE.
- Whether Railway's OANDA token is valid, revoked, or paired with the account.
- Whether the running process is the expected Live Bot service rather than one of the other production environments.

## Classification

A invalid/revoked OANDA credentials: NOT DETERMINABLE — no authenticated Railway request was possible.
B Railway token/account mismatch: NOT DETERMINABLE — Railway account/token presence is unknown.
C Railway ENV propagation problem: NOT DETERMINABLE — Railway process ENV is unavailable.
D malformed Authorization header: NOT DETERMINABLE at Railway runtime — code inspection shows the intended header template, but the actual Railway value cannot be observed.
E Railway wrong environment: NOT DETERMINABLE — OANDA_ENV is unavailable in Railway.
A Replit-only 401: NOT PROVEN — the earlier local 401 was confirmed, but this check could not compare it with Railway.

## Required next observation to resolve the issue

A read-only inspection must be performed in the Railway service that actually runs the Live Bot, using Railway's own service/runtime log or shell interface. It should emit only:
- apiKeyPresent=true/false
- accountIdPresent=true/false
- OANDA_ENV value
- selected base URL
- service/process name
- deployment SHA/version

If both credentials are present, that same Railway process should issue exactly one GET-only OANDA request, such as account summary or candles, and report HTTP status only plus authentication success/failure. The token and account identifier must remain redacted.

No fix was applied and no production process was restarted or redeployed.

Generated from read-only GitHub integration deployment metadata and Replit deployment metadata. This report deliberately does not claim access to Railway runtime secrets or process state.