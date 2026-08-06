---
name: Public application routing
description: Public root routing for the Telemetry Dashboard and secondary artifact paths.
---

The public root must be owned by the Telemetry Dashboard on local port 8083. The Mockup Sandbox belongs on `/mockup` via local port 8081; the API artifact uses `/api-server` on local port 8080 so it cannot intercept the Telemetry Dashboard's `/api/*` endpoints.

**Why:** The default public route previously pointed to the Mockup Sandbox, hiding the dashboard, and the API artifact's `/api` path intercepted telemetry endpoints.

**How to apply:** Preserve the external-port and artifact preview-path separation when changing workflows or publishing configuration; verify `/`, `/mockup/`, and representative `/api/*` endpoints after routing changes.