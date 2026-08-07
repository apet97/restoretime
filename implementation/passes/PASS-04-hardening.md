# PASS-04 — Hardening

## Mission

Prove the dangerous behaviors under adversarial conditions and close the remaining gaps. After this
pass the product survives the threat model and the edge-case matrix, not just the happy path.

## Repository

`~/Downloads/working/addons-me/restoretime` after PASS-03 merge.

## Authoritative reading order

1. `IMPLEMENTER.md`
2. `docs/12-security.md` — threat model rows are your checklist
3. `docs/11-edge-cases.md` — every row must map to a test or a documented reason
4. `docs/07-recreation-preflight.md` §6–§9
5. `docs/14-operations.md`

## Current expected state

Feature-complete product; all PASS-01…03 suites green.

## Scope

- Concurrency proof under process-level parallelism: IT-03 extended — N concurrent claims across
  worker threads on one DB file; exactly one SUCCESS path.
- Lease/fencing drill: kill a handler mid-attempt (inject a crash point behind an env flag used
  only by tests); assert reclaim after expiry and that fenced writes from the dead attempt fail
  (IT-12).
- Permission negatives sweep: every `/api/*` route with forged workspace, forged user, demoted
  admin, expired token, token for a different addon key (IT-07/IT-09 extension).
- XSS proof: fixture entries carrying entity-encoded and markup-looking strings through every
  rendered view; assert escaped output (UT-X01 at E2E level).
- Log audit: run the full suite with log capture; assert no description/custom-field value/token
  appears in any line (N3).
- AMBIGUOUS soak: scripted sequence — commit-lost, nothing-committed, double-candidate,
  double-adoption attempt (two rows adopting the same Clockify id → one 409).
- Revalidation drill: dependency removed between plan and confirm → STALE plan, fresh preflight
  returned, no mutation issued.
- Performance sanity: list endpoint with 5k rows (seeded) renders server-side queries without
  N+1 (one lookup set per request); assert query counts and p95 under a documented local budget.
- Metrics emission per docs/14 (counter lines) at the points listed there — add only those.
- Uninstall purge proof incl. attempts/plans cascades (IT-11).
- Error-message sweep: every user-facing failure text answers what happened / was anything created
  / what next (N8); fix strings where missing.

## Explicit out of scope

New features, bulk beyond PASS-03 scope, deployment automation (PASS-05), refactors without a
failing test.

## Tests

Everything above lands as named tests in the docs/13 matrix (extend IDs in place: IT-*, UT-*,
E2E). No test may depend on wall-clock sleeps longer than 2 s (fake timers or injected clocks).

## Commands/gates

All previous gates + the new tests green; `npm run test` total runtime stays under 5 minutes.

## Git requirements

Branch `pass-04-hardening`; one commit per checklist group. PR, CI green, squash-merge.

## Completion criteria

Every docs/12 threat row and every docs/11 edge case cites a passing test or a written reason.
The final report lists any behavior changed during hardening and the evidence that required it.

## Final report format

`implementation/reports/PASS-04.md`: threat/edge-case coverage table; performance numbers; log
audit method + result; deviations; limitations.
