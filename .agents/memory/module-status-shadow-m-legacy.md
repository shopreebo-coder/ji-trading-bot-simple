---
name: Module status Shadow M legacy behavior
description: Existing ModuleStatusManager behavior reports Shadow M as live-influencing while the bot runs, conflicting with the older OBSERVE-mode test.
---

The module registry intentionally exposes Shadow M as live-influencing when the bot is running because its advisory cooperation is currently wired into Live Exit. Exit Engine X must remain `influencesLive: false`.

**Why:** The OBSERVE-mode integration test predates the current Shadow M cooperation contract and fails independently of Exit Engine X.

**How to apply:** Do not “fix” this while changing Exit Engine X. Treat it as a separate policy decision requiring explicit review of Shadow M’s live cooperation boundary.