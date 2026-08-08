# 16 — Definition of done

The product is done when every statement is true and verified.

Status recorded PASS-05 (evidence/live-release-run.md, `implementation/reports/PASS-05.md`). A box
is checked only when it is genuinely true; every unchecked box carries the one-line reason it isn't
yet, so an honest gap is visible here rather than buried in a report.

## Contracts

- [x] `TIME_ENTRY_DELETED` ingestion verifies, normalizes, persists, and acks; duplicates are
      no-ops (IT-01, IT-02, CT-01…CT-05).
- [x] A regular user sees only their own deleted entries; an admin sees the workspace's (IT-07).
- [x] Preflight produces plans that match docs/07 rule-for-rule (UT-P01…P16).
- [x] A confirmed, valid plan recreates the entry through `createForUser`; the success view shows
      the new entry, fidelity, and differences (F9, F12; LV-03, LV-04) — proven offline
      (`tests/integration/mutation.test.ts`, `tests/e2e/component-flow.test.ts`'s success view) and
      **live**: LV-03 drove plan → confirm → RECREATED against real Clockify, and LV-04 did it for
      another user's entry using the installation's own addon token (evidence/live-release-run.md
      "Live run 2").
- [x] Concurrent recreation of the same source is impossible (IT-03).
- [x] An unknown-outcome create becomes AMBIGUOUS and resolves per docs/07 §8; no automatic retry
      exists anywhere (IT-04; the LV-10 chaos-hook mechanics are additionally proved offline in
      `tests/integration/chaos-fetch-drill.test.ts`).
- [x] Every Clockify 4xx maps to a user-facing reason through `clockifyErrorCode`, including
      numeric body codes and code-absent bodies; the SDK `getErrorCode` is not imported anywhere
      (UT-M01; `grep -rn "^import.*getErrorCode" src/` → no matches, re-verified PASS-05).
- [x] Bounded list reads use `iterPages` and surface the page bound instead of returning a partial
      result (IT-14).
- [x] Recreated-deleted-recreated chains show lineage (IT-06).
- [x] Uninstall purges the workspace's data (IT-11).

## Quality bars

- [x] `npm run typecheck`, `lint`, `test`, `build` green on `main` — verified on `main` after the
      PASS-05 merge: 33 test files, 299 tests, plus 18 E2E; `git diff --check` clean; `gitleaks
      detect` reports no leaks.
      (`implementation/passes/PASS-05-release.md` "Git requirements": PR review and merge precede
      the tag).
- [x] No dependency beyond `implementation/DEPENDENCIES.md`; no dead code; no TODO/FIXME in `src/`
      (`grep -rn "TODO\|FIXME" src/` → no matches, re-verified PASS-05; no new dependency was
      added).
- [x] Every user-facing string follows docs/10 terminology (recreate, never restore)
      (`implementation/marketplace/terminology-check.md` — zero forbidden-term matches across
      `src/ui/`, `src/api/routes.ts`, `src/api/views.ts`, `src/manifest.ts`).
- [x] No raw webhook payload, token, or description appears in any log line (verified by the
      PASS-04 log-audit test that captures logs across the full suite run;
      `tests/integration/log-audit.test.ts` re-run green on this pass's commit).
- [x] ADRs still match the code; deviations were re-decided, not drifted into (PASS-05 made one
      code change — `src/clockify/chaos-fetch.ts` wired into `src/clockify/client.ts` — a new
      test-only hook gated identically to the existing `RT_TEST_CRASH_MID_ATTEMPT` pattern; it adds
      no new production behavior and required no ADR revision).

## Release gates

- [x] Live suite LV-01…LV-10 passes against a real installed addon on the sacrificial workspace
      (LV-10 proves the ambiguity protocol live; it is not optional) — **run on the developer
      environment**, `10 passed | 1 skipped`, reproduced twice
      (evidence/live-release-run.md "Live run 2").
      LV-10's hard gate passed live: a create that really committed while the caller saw a
      transport failure became AMBIGUOUS and was adopted by reconcile. LV-04 closed R11 on the real
      addon-token path and LV-07 closed R12. R5 closed live: LV-03 asserted a non-default
      custom-field value written at create and preserved on the new entry. **R23 closed**: live custom-field items now
      carry all five properties the preflight reads, and LV-08 proved P-CF-OPT end to end — a value
      outside the field's current `allowedValues` was surfaced, kept on the user's choice, and
      written verbatim to the new entry (R19). LV-08 reports PARTIAL: no field on this workspace has
      `required: true` with no default, so the P-CF-REQ half did not run and R22 stays
      operator-stated.
      **Still unverified**: production (`app.clockify.me`) has never been exercised, and an
      authenticated component render needs a Clockify-signed session (docs/15 step-6 smoke).
- [ ] Marketplace manifest review package complete (docs/15). **Reason unchecked**: the reviewable
      package is staged (`implementation/marketplace/`: manifest review, scope justification,
      privacy text, terminology check, rollback proof) — everything docs/15's own prerequisites
      list names. A real Marketplace submission additionally needs operator-supplied icon artwork,
      screenshots, and a long-form listing description, plus a production host/DNS/TLS
      (`implementation/marketplace/README.md` "What only the operator can supply") — none of which
      exist yet.
- [x] Rollback drill executed and recorded (evidence/live-release-run.md §2.3,
      `implementation/reports/PASS-05.md` "Rollback drill") — a real Docker build/run sequence
      including a deliberately incompatible drill-only migration, executed and reversed for real,
      not a dry run. Scope caveat: the pass file's "verify `/healthz` + one component load" was
      satisfied by `/healthz`, the served assets, and the `/component` verified-claims boundary
      (401 without a token). An **authenticated** component render needs a Clockify-signed session
      and belongs to the docs/15 step-6 production smoke, not to this drill.
- [x] GitHub release tagged with notes — `v1.0.0-rc.3`, a **release candidate**, not `v1.0.0`.
      docs/15 defines `v1.0.0` as the Marketplace-submission release; the box above shows two
      things still unverified (production, and an authenticated component render), so calling this
      `v1.0.0` would assert them. The tag notes state exactly what was and was not proved.
