# Project Guidelines

## Isolated Runtime Proofs

- For an isolated runtime proof item, one explicit user authorization covers retries for that same item and scope; do not ask for separate approval after each failed attempt.
- Make only as many attempts as needed to meet the unchanged acceptance criteria, and stop once the item passes. Never exceed **10 total attempts per item**, counting attempts recorded in earlier sessions as well as the current session.
- Count each invocation of the runtime proof runner as an attempt, whether it passes, fails, or stops during preflight. Record each attempt and its outcome in the project evidence.
- Before retrying, diagnose the previous failure, make and test any necessary scoped fix, and preserve the prior attempt's evidence. Do not relax acceptance criteria to turn a failure into a pass.
- Stop and seek user direction if the proposed retry changes the approved scope, could affect an existing or external system, cleanup or isolation checks fail, or another safety boundary is reached. The per-item authorization does not cover a different proof item, deployment, or production activity.
- Retain the existing private-network, pinned-image, resource-limit, deadline, watchdog, and owned-resource cleanup requirements for every attempt.
