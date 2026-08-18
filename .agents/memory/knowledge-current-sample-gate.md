---
name: Knowledge current-sample gate
description: Keeps historical snapshot volume separate from current non-test outcome evidence used for confidence and controlled decisions.
---

# Knowledge confidence must use the current non-test sample

Historical expectancy snapshots may contain many points and may include simulation or test rows. Those points are useful research context, but they are not equivalent to current resolved live outcomes.

**Why:** treating snapshot-point counts or test-contaminated resolved counts as live training events can produce `MEDIUM`/`HIGH` Knowledge confidence and available evidence when the real non-test sample is still too small. That can make Selected or Capital Gate appear more certain than the data supports.

**How to apply:** expose the current resolved non-test sample separately, exclude `testSimulation=true`, and require the controlled Knowledge evidence path to meet the minimum resolved-outcome threshold (currently 30). Below that threshold, keep evidence unavailable and let the Capital Gate fail closed to `ABSTAIN`.