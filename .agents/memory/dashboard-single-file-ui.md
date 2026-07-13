---
name: Dashboard is a hand-maintained single-file UI
description: How the forex bot dashboard is built/served, and why new backend endpoints don't appear in the UI automatically.
---

The operator dashboard is one hand-written file: `telemetry/public/index.html` (~3000 lines, React 18 UMD + `@babel/standalone@7` via `<script type="text/babel">`, no build step). It is served by the SAME `telemetry/server.js` process (`express.static(public)` + `sendFile(public/index.html)`), so frontend and backend are inherently the same commit — a "frontend/backend version mismatch" is not possible here.

**Rule:** adding a backend endpoint does NOT make it visible. Sprints in this repo ship backend + API + tests only; the UI is a separate, manual step. To surface data you must wire a tab into this file: add the name to the `TABS` array, add a `useState` + a `refreshX()` fetch, add an `if(tab==="X") refreshX()` branch in the on-tab-change `useEffect`, add a `{tab==="X" && <XTab/>}` render-switch line, and define the component (mirror `SnowballLabTab`, the LAB tab, as the closest pattern).

**Why:** the Sprint 5 Shadow LAB research layer (`/api/lab/research/*`, `/api/lab/expectancy`) and the entire Sprint 6 Knowledge layer (`/api/knowledge/*`) existed and returned 200 for a long time while being completely invisible — because no tab consumed them. The dashboard's older LAB tab reads a DIFFERENT set (`/api/lab/overview`, `/api/lab/shadow-a..d`), which is why "LAB works but Knowledge doesn't" was confusing.

**How to apply:** whenever a task says "X is enabled/returning 200 but not showing in the UI", first grep `telemetry/public/index.html` for the feature name — absence there (not a feature flag, not a deploy mismatch) is the usual root cause. `??`/`?.` are safe (Babel @7; already used 44×/81×).
