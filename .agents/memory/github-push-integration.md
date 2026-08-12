---
name: GitHub push path
description: Safe repository publishing when the local HTTPS Git helper cannot authenticate
---

When the installed GitHub integration is available but `git push` over HTTPS rejects credentials, publish through the authenticated GitHub API rather than handling tokens or using force push. Verify the remote branch first, compare the remote blobs for each locally changed file with the local commit parent, create one tree and one commit on the current remote head, then update the branch ref with `force:false`.

**Why:** The workspace's local Git credential helper may not consume the Replit-managed GitHub connection, while the integration can perform an authenticated fast-forward safely. Remote history may also contain unrelated commits that make a raw local push non-fast-forward.

**How to apply:** Search the GitHub integration, resolve the `github` connector, use its authenticated proxy for Git Data API calls, and refuse the operation if the remote changed any file in the intended patch or if the branch cannot be advanced without force.