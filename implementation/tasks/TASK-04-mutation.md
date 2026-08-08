# TASK-04 — Mutation and ambiguity

- Pass: PASS-02
- Goal: exactly-one recreation per source; honest outcomes (SUCCESS / FAILED / AMBIGUOUS).
- Why: Clockify has no idempotency and no dedup (R7); this is where data corruption would happen.
- Prerequisites: TASK-03.
- Files/modules: `src/clockify/recreate.ts`, claim + transitions in `src/store/entries.ts`,
  `src/store/attempts.ts`; endpoints `recreate`, `reconcile`, `mark-not-created`,
  `resolve-ambiguous`.
- Interfaces: docs/07 §6 (claim SQL verbatim), §7 (revalidation), §8 (protocol), §9 (diff).
- Behavior: claim → baseline → `createForUser` → 201+verify → RECREATED; 4xx → FAILED (mapped);
  5xx/timeout → AMBIGUOUS → baseline-delta reconcile; adoption guarded by the partial unique
  index; never auto-retry; never delete Clockify entries. Client constructed with
  `timeoutInSeconds: 30`; classification per fact 7 (timeout/transport/5xx → AMBIGUOUS; 4xx →
  FAILED). Codes come from the app normalizer `clockifyErrorCode` (docs/03 §6) compared against
  string literals — never the SDK `getErrorCode`, which returns `undefined` for Clockify's numeric
  codes (R15); a code-absent 4xx maps on status alone. A 201 determines RECREATED even if the
  verification read fails (fact 11). List reads use `iterPages`, never `iterAll`, so the page bound
  is detectable (docs/03 note 5).
- Failure behavior: stale plan → fresh preflight, no mutation; claim lost → current-state response;
  reconcile ≥2 candidates → user picks.
- Tests: IT-03, IT-04, IT-05, IT-06, IT-12, UT-S01, UT-S02, UT-M01.
- Acceptance: the scripted walkthrough (PASS-02 completion) passes; concurrency proof shows one
  winner.
