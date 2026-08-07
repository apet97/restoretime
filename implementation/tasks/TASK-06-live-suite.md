# TASK-06 — Live release suite

- Pass: PASS-05
- Goal: LV-01…LV-09 against the production build on the sacrificial workspace.
- Why: the addon-token success path (R11) and the reconcile list shape (R10) are NOT_TESTABLE
  without an installed addon; release depends on them.
- Prerequisites: PASS-04 merged; deployable image; operator-provided live env (`CK_LIVE_*`).
- Files/modules: `tests/live/*`, `evidence/live-release-run.md` (output).
- Interfaces: docs/13 LV table; docs/15 pipeline.
- Behavior: install → webhook → own recreate → admin recreate for another user → missing-dependency
  substitution → archived-tag and billable-permission probes → list-shape pinning.
- Failure behavior: any LV failure stops the release; new evidence updates docs/01 and the design;
  tests are never weakened to pass.
- Tests: the suite itself.
- Acceptance: PASS-05 completion criteria.
