---
name: Railway versus workspace runtime
description: Distinguishing the local Replit workflow from Railway Production when checking broker environment variables.
---

The local `Telemetry Dashboard` workflow runs from the workspace using `.replit` and only inherits Replit workspace environment variables. Secrets configured only in Railway Production are not visible there. A Railway-only variable can therefore be present in Production while absent from the local bot process.

**Why:** broker diagnostics on the local workflow otherwise look like a post-restart secret-loss issue even though no Railway container is being observed.

**How to apply:** identify the process command, working directory, deployment metadata, and Railway environment metadata before interpreting secret presence. Report presence only; never print secret values.