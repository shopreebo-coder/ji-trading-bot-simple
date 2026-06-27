---
name: GitHub push blocker
description: How to push to the Railway GitHub repo; token 401 workaround
---

**Why:** All deploys go via GitHub → Railway auto-deploy. Push uses node HTTPS (GitHub Data API,
not git CLI). The token is stored as Replit env secret `GITHUB_PERSONAL_ACCESS_TOKEN`.
Repo: `shopreebo-coder/ji-trading-bot-simple`, branch `main`.

**Current state:** Token returns 401 Bad credentials — expired or revoked.

**Fix steps:**
1. github.com → Settings → Developer settings → Personal access tokens → Generate new token (classic)
2. Scopes: `repo` (full)
3. Update Replit Secret `GITHUB_PERSONAL_ACCESS_TOKEN` with new value
4. Also update Railway env var if used there directly
5. Confirm to agent → push script in session plan executes immediately

**Push script pattern:** Uses GitHub Data API (blobs → tree → commit → PATCH ref). Reads files
from `/home/runner/workspace`, creates blobs one at a time, then single tree + commit + ref update.

**Files always included in push:** index.js, index_railway_mtf_v39_optimized.js,
telemetry/index.js, telemetry/shadowlab.js, telemetry/shadowm.js, telemetry/server.js,
telemetry/public/index.html.

**Sync copy rule:** After any change to `index.js`, always `cp index.js index_railway_mtf_v39_optimized.js`.
