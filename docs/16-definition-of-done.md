# 16 — Definition of done

The product is done when every statement is true and verified.

Status recorded PASS-05 (evidence/live-release-run.md, `implementation/reports/PASS-05.md`). A box
is checked only when it is genuinely true; every unchecked box carries the one-line reason it isn't
yet, so an honest gap is visible here rather than buried in a report.

## Contracts

- [x] `TIME_ENTRY_DELETED` ingestion verifies, normalizes, persists, and acks; duplicates are
      no-ops (IT-01, IT-02, CT-01…CT-05).
- [x] A regular user sees only their own deleted entries; an admin sees the workspace's (IT-07).
- [x] An admin can find an entry by the user's or project's **name**, including when the project has
      since been deleted from Clockify and the member deactivated — the rows that exist to be found
      (UT-L02, IT-20, and the list-filter E2E case). Neither name filter widens a non-admin's scope,
      and `/api/options?kind=users` is admin-only.
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
      `tests/integration/chaos-fetch-drill.test.ts`). The SDK's own retry layer is pinned too:
      `tests/integration/write-retry-invariant.test.ts` proves `createForUser` reaches the
      transport exactly once on a 500, a 429 with `Retry-After`, and a rejected fetch — so the
      invariant survives an SDK default changing under us, not only app code changing.
- [x] Every Clockify 4xx maps to a user-facing reason through `clockifyErrorCode`, including
      numeric body codes and code-absent bodies; the SDK `getErrorCode` is not imported anywhere
      in `src/` (UT-M01; `grep -rn "^import.*getErrorCode" src/` → no matches, re-verified
      PASS-05 and again after the 4.0.0 upgrade). Since `clockify-sdk-ts-115@3.0.0` the two agree;
      the normalizer is kept to pin this app's classification, and UT-M01 now asserts the
      agreement so a future divergence surfaces there (docs/03 §6).
- [x] `clockifyErrorDetail` — the one SDK accessor that can carry request data into a string — is
      not imported anywhere (`grep -rn "^import.*clockifyErrorDetail" src/` → no matches; the only
      mention in `src/` is the docblock in `src/clockify/errors.ts` explaining why). Log safety
      rests on `safeErrorSummary` alone (docs/12, docs/14 N3; IT log-audit).
- [x] Bounded list reads use `iterPages` and surface the page bound instead of returning a partial
      result (IT-14).
- [x] Recreated-deleted-recreated chains show lineage (IT-06).
- [x] Uninstall purges the workspace's data (IT-11) — and **proved live**: a real uninstall on the
      developer workspace took `recoverable_entries` 132, `recreation_plans` 11,
      `recreation_attempts` 4 and `installations` 1 all to zero (evidence "Live run 10").

## Quality bars

- [x] `npm run typecheck`, `lint`, `test`, `build` green on `main` — verified on `main` after the
      PASS-05 merge: 33 test files, 299 tests, plus 18 E2E; `git diff --check` clean; `gitleaks
      detect` reports no leaks. (Re-verified 2026-08-09 after the `clockify-sdk-ts-115` 4.0.0
      upgrade and the name filters: 37 test files, 324 tests, plus 20 E2E, same three clean.
      Re-verified 2026-08-09 after the broken-installation notice, the reconcile
      transport-failure catch, and the status/dismissed filter resolution: 37 test files,
      329 tests, plus 22 E2E, same three clean.)
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
      written verbatim to the new entry (R19). **R22 proved live**: with active required fields
      carrying no default, a create that omits them is rejected `400 {"message":" <field names>",
      "code":501}` and one that supplies them succeeds — so LV-08's P-CF-REQ half runs too and the
      whole docs/07 §3 custom-field rule set is live-verified. The suite runs with **no skips**.
      The docs/15 step-6 smoke has now **run on the developer environment** (evidence
      "Live run 7"): the addon was loaded in a real Clockify iframe and walked list → detail →
      preflight → confirm → RECREATED against another user's entry, with Clockify's own
      "Add-on: Time entry recreated." toast confirming the postMessage bridge. That render found a
      release-blocking defect present in rc.1…rc.5 — the component response omitted `connect-src`,
      so `default-src 'none'` blocked every `/api/*` call and the UI could not load data in any
      browser. Fixed and pinned in `tests/unit/server.test.ts`.
      The docs/10 §8 **token-refresh** contract is also verified live now: the proactive dispatch
      fired at exactly 25 minutes and a call 106 s after the original token's expiry still
      succeeded (evidence "Live run 12"). Its reactive 401-retry half remains unit-covered only.
      Re-run in full on `clockify-sdk-ts-115` **4.0.0** (evidence "Live run 14"): 11 passed, 0
      skipped, 0 blocked — the suite is the only thing that exercises real Clockify error shapes,
      and 4.0.0 changed how errors serialize, so this is the run that matters for that upgrade. The
      same run closed LV-02's self-declared gap by the log inspection it asks for: 11
      `webhook_received`, 11 `recoverable_created`, 11 persisted rows, 0 error lines.
      **Still unverified**: production (`app.clockify.me`) has never been exercised.
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
      (401 without a token). The **authenticated** component render was out of scope for this drill;
      it has since been done separately on the developer environment (evidence "Live run 7").
- [x] GitHub release tagged with notes — currently `v1.0.0-rc.9`, a **release candidate**, not
      `v1.0.0`. rc.6 fixed the component CSP defect and rc.7 the false P-LOCK-REG warning; both
      were found by driving the addon and the workspace through a real browser (evidence "Live
      run 7" and "Live run 8"), which is why the candidate series moved twice after the passes
      closed. rc.8 carried the UI sweep, and rc.9 the `clockify-sdk-ts-115` 4.0.0 upgrade and the
      name filters.
      docs/15 defines `v1.0.0` as the Marketplace-submission release; the box above still shows
      production unverified, so calling this `v1.0.0` would assert it. The tag notes state exactly
      what was and was not proved.
