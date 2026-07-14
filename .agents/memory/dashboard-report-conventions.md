---
name: Dashboard report conventions
description: Gotchas for the Babel-standalone dashboard (telemetry/public/index.html) and its client-side reports
---

# Dashboard report conventions

- **Winrate units are mixed across the system.** Knowledge-layer builders (`patterns/validated`, `engines/statistics` via `rate()`) store winrate as a **0–1 fraction**; lab HTTP endpoints (`/api/lab/*`, `/api/stats`) return winrate as a **0–100 percent**. Any consumer that prints `%` must know which source it is reading — a fraction printed as percent silently under-reports by 100×.
  **Why:** this exact bug shipped in the first cut of the AI report v2 and was only caught in review.
  **How to apply:** when formatting any winrate, check whether it comes from a knowledge artifact (fraction → multiply by 100) or a lab endpoint (already percent).

- **Verifying the dashboard without running the bot.** `telemetry/server.js` is the live trading orchestrator — never start it locally to test the dashboard. Instead: extract the `<script type="text/babel">` block, syntax-check with the workspace esbuild (`require('.../esbuild').transform(src, {loader:'jsx'})`), and smoke-test pure module-level functions by `eval`-ing the slice between section markers in Node.
  **Why:** starting server.js risks live OANDA activity; esbuild handles the JSX + modern syntax Babel standalone accepts.

- **Client-side report pattern:** keep report builders as pure module-level functions (data in → lines out) so they are Node-testable; fetch via a best-effort `safe()` wrapper (per-endpoint try/catch → null) so a single dead endpoint renders N/A instead of killing the report; guard localStorage comparison baselines so a heavily-failed fetch pass never overwrites a healthy baseline.
