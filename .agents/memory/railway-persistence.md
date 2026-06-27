---
name: Railway persistence fix
description: Why data was lost on redeploy and how to fix it permanently
---

**Root cause:** Railway container has `/data` directory writable WITHOUT a Volume attached.
Old code used `fs.accessSync("/data", W_OK)` to auto-detect the data dir — this always
returned true on Railway, so data went to ephemeral `/data` and was destroyed on every redeploy.

**Fix (already applied):** `telemetry/index.js` no longer auto-detects `/data`. It now:
- Uses `DATA_DIR` env var if set → marks storage as PERSISTENT
- Falls back to `./data` with a loud warning if `DATA_DIR` not set

**Required Railway configuration (one-time):**
1. Railway dashboard → Service → Storage → Add Volume → Mount path: `/data`
2. Railway dashboard → Variables → DATA_DIR = /data
3. Redeploy

**After correct config, startup log shows:**
```
[TELEMETRY] DB path  : /data/events.db
[TELEMETRY] Storage  : ✓ PERSISTENT (DATA_DIR explicitly set)
[TELEMETRY] Events   : N | oldest: ... | newest: ...
[TELEMETRY] ✓ Historical data preserved across this restart
```

**How to apply:** If user reports data loss on Railway, first check startup logs for the
`⚠ EPHEMERAL` warning. If present, Railway Volume is not configured.
