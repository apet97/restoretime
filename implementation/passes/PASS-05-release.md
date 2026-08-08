# PASS-05 — Release

## Mission

Take the hardened product to production on a sacrificial workspace, close the remaining
NOT_TESTABLE evidence gaps with the live suite, complete the Marketplace package, and tag the
release.

## Repository

`~/Downloads/working/addons-me/restoretime` after PASS-04 merge.

## Authoritative reading order

1. `IMPLEMENTER.md`
2. `docs/15-release.md` — the pipeline this pass implements and executes
3. `docs/13-testing.md` — LV suite definitions
4. `docs/16-definition-of-done.md`
5. `evidence/webhook-validation.md` §4 — the unknowns this pass closes

## Current expected state

All suites green; no live verification has happened yet (no installed addon existed during
planning).

## Scope

- Container build: `Dockerfile` (Node 22, non-root, `npm ci --omit=dev`, migrations at boot,
  `/healthz` wired). Document run env (docs/05 variables).
- Live suite `tests/live/` implementing LV-01…LV-10 per docs/13 with env-gated credentials
  (`CK_LIVE_*`). LV-04 (admin recreates another user's entry with the addon token; the same
  scenario was already proved on the developer environment 2026-08-08 —
  evidence/install-capture-2026-08-08.md; this run re-confirms on production), LV-09
  (`listForUser` field coverage), and LV-10 (the ambiguity drill through the `RT_CHAOS_FETCH`
  test hook) close the load-bearing unknowns (R11, R10) and prove the riskiest path live.
  LV-10 is a hard gate: if the chaos hook cannot run in the deployment shape, the release stops
  and the reason is recorded in the final report — the ambiguity protocol never ships unverified.
- Live-suite outcome handling: if an LV row fails because platform behavior differs from the
  baseline, stop. Record the new evidence, update the affected docs/01 row and any design doc,
  and re-run the affected product tests. Never weaken a test to force green.
- Adversarial review: run an independent reviewer over the full diff `main` vs the first pass
  branch point, guided by docs/12 and the no-bloat rules in `AGENTS.md`. Incorporate only
  findings with evidence or concrete benefit.
- Release execution per docs/15: CI gates → image → deploy to `<operator: host>` → migrations →
  live suite → production smoke → Marketplace manifest review package (scopes justification,
  privacy text from docs/08/12, terminology check) → rollback drill → tag `v1.0.0` with notes.
- Operator placeholders to resolve at execution time (ask the operator, do not invent): deployment
  host/orchestrator, production `PUBLIC_BASE_URL`, DNS/TLS, Marketplace listing metadata (icon,
  screenshots, description text beyond the draft in this repo).

## Explicit out of scope

Feature work, architecture changes, new dependencies. If the live suite forces a design change,
record it as a new ADR revision and re-run PASS-04 gates.

## Safety invariants

- The sacrificial workspace is the only live target. No customer workspace is touched.
- Credentials exist only in the live-suite environment; the repo never contains any.
- Rollback drill restores the previous image and verifies `/healthz` + one component load.

## Tests

LV-01…LV-10 green on the production build; full offline suite green on the release commit.

## Commands/gates

`docs/15-release.md` §Release pipeline steps 1–7, each with recorded output.

## Git requirements

Branch `pass-05-release`. The release tag is created only after every gate passes. Push
`main` and the tag to the remote.

## Completion criteria

`docs/16-definition-of-done.md` fully checked; live evidence addendum written to
`evidence/live-release-run.md` (sanitized); Marketplace package submitted or staged with the exact
remaining operator inputs.

## Final report format

`implementation/reports/PASS-05.md`: gate outputs, LV results, evidence deltas (and the doc
updates they forced), review findings + disposition, release coordinates (image digest, tag,
deployment), rollback drill record.
