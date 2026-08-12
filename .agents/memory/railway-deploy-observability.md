---
name: Railway deploy observability
description: GitHub can trigger Railway production deployments, but repository deployment records may not expose service URLs or terminal health.
---

Railway deployments connected to this repository can appear as GitHub Deployment records with environment names and dashboard URLs, while remaining `in_progress` without public service URLs or runtime logs available through the installed integrations.

**Why:** A push can fan out to multiple Railway production environments, so a successful GitHub push is not proof that the intended bot runtime is healthy or serving the new commit.

**How to apply:** Verify the exact Railway service/environment and inspect its runtime logs and telemetry endpoint before claiming production success; do not infer health from the GitHub deployment record alone.