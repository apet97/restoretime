# 16 — Definition of done

The product is done when every current-candidate statement is true and verified. Checked evidence
below is historical unless the item names the exact current candidate. Worktree changes after
`v1.0.0-rc.14` require new local gates, strict live receipts, and cleanup evidence.

Two changes have shipped to `main` since `v1.0.0-rc.14` and neither is a release candidate: the
installation-generation boundary (pull request 42) and the defect sweep and component design pass
(pull request 43). Their contracts are checked in "Contracts" below and their developer-deployment
evidence is in docs/15. The "Next-candidate gates" section still governs the next candidate; a
merged pull request and an evaluation deployment do not satisfy it.

PASS-05 and `evidence/live-release-run.md` contain historical candidate evidence. The current tree
uses `@apet97/clockify-addon-sdk` 1.3.0, `clockify-sdk-ts-115` 5.1.0, and `better-sqlite3` 13.0.3.
Older local and live results remain useful history, but they are not proof for this dependency set.
A checked box below either describes a current static fact or identifies itself as historical
evidence.

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
      `tests/integration/chaos-fetch-drill.test.ts`). SDK 5.1 `classifyWriteOutcome()` owns the
      write taxonomy. A 304 `ClockifyApiError` is `unknown`; the app reports it and keeps the
      result, row, and attempt AMBIGUOUS. The SDK's own retry layer is pinned too:
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
- [x] Bounded list reads use SDK `PaginatedList.collect()` and surface `truncated: true` instead of
      returning a partial result (IT-14).
- [x] Recreated-deleted-recreated chains show lineage (IT-06).
- [x] Uninstall purges the data owned by that installation generation, scoped by
      `(workspace_id, addon_id)`, in one transaction; another generation of the same workspace and
      another workspace are both untouched, and a repeated `DELETED` reports `stale` and changes
      nothing (IT-11). **Proved live** under the earlier workspace-wide rule: a real uninstall on
      the developer workspace took `recoverable_entries` 132, `recreation_plans` 11,
      `recreation_attempts` 4 and `installations` 1 all to zero (evidence "Live run 10"). Proved
      live again under the scoped rule on developer deployment `9f425551`: the uninstall purged
      that installation's 156 rows and left the *other* workspace's installation and its 4 rows
      in place (docs/15).
- [x] `(workspace_id, addon_id)` is the ownership key for every product-data read and write
      (migration 0004). A reinstall neither inherits the previous generation's entries nor is
      blocked by them; installing supersedes the older generation; a delayed `DELETED` for a
      superseded generation is acknowledged and leaves the current one intact; a viewer from one
      generation gets 404 for another's row (IT-21). A delivery still being verified when the
      uninstall commits is refused by a database-enforced generation fence rather than an
      in-memory check (IT-22). **Proved live**: a reinstall issued a fresh `addonId`
      (`6a8a5582…`, distinct from the retired `6a7fd73e…`), and the new generation started empty
      and captured its own deletion under its own id (docs/15).
- [x] A replayed `INSTALLED` for an already-retired generation is still installed but supersedes
      nothing, so it cannot purge the current generation (IT-21, migration 0005). Lifecycle tokens
      carry no `exp` — the SDK verifier defaults `requireExpiration: false` — so such an event can
      arrive at any later time and always looks newest; `retired_installations` is what makes it
      inert.
- [x] The list is fully traversable: `GET /api/entries` pages by keyset over
      `detected_at DESC, id DESC`, each row is reached exactly once, a row inserted between pages
      never repeats an already-returned one, a malformed or unsupported-version cursor and an
      out-of-range `limit` are answered 400 rather than clamped, and a cursor cannot reach another
      installation generation's rows (IT-24). **Proved live**: 4 pages, 153 rows, 153 unique ids,
      no repeats; **Load more** walked 50 → 100 → 150 → 153 and then withdrew (docs/15).
- [x] **Load more** appends without losing the reader's place: the rows already shown stay, focus
      remains on the button across a page, the announcement names the rows that arrived, and when
      the last page removes the button focus moves to the count (E2E-UI-01, E2E-UI-02;
      `tests/e2e/views.test.ts` "list continuation"). Verified red-first — restoring the full
      re-render throws focus to the page heading. **Proved live** on deployment `fdce441f` with 60
      seeded entries: 50 → 60 rows and focus on `All 60 entries shown.` (docs/15).

## Quality bars

- [x] `v1.0.0-rc.14` at `2d5e7fbf3507d520456d60f69f70e29e78d9edb9` passed Node 22
      typecheck, strict lint, build, 472 non-E2E tests, and 104 E2E tests. Both npm audits reported
      zero vulnerabilities. The candidate-bound release evidence also records the image, secret,
      local migration and rollback, and live checks.
- [x] Historical `v1.0.0-rc.10` candidate passed `npm run typecheck`, `lint`, `test`, `build`, and E2E.
      Verified 2026-08-11 with Node 22.23.1: typecheck, lint, and build passed; 37 files and 381
      non-E2E tests passed; 8 files and 42 E2E tests passed; `git diff --check` passed. Root and
      install-capture production dependency audits reported zero vulnerabilities. `gitleaks
      detect --no-banner --redact` scanned 85 commits and found no leak. Historical runs
      were green on `main` after the
      PASS-05 merge: 33 test files, 299 tests, plus 18 E2E; `git diff --check` clean; `gitleaks
      detect` reports no leaks. (Re-verified 2026-08-09 after the `clockify-sdk-ts-115` 4.0.0
      upgrade and the name filters: 37 test files, 324 tests, plus 20 E2E, same three clean.
      Re-verified 2026-08-09 after the broken-installation notice, the reconcile
      transport-failure catch, and the status/dismissed filter resolution: 37 test files,
      329 tests, plus 22 E2E, same three clean.)
      (`implementation/passes/PASS-05-release.md` "Git requirements": PR review and merge precede
      the tag).
- [x] No dependency beyond `implementation/DEPENDENCIES.md`; no dead code; no TODO/FIXME in `src/`
      (`grep -rn "TODO\|FIXME" src/` → no matches, re-verified for RC.14; strict lint reports
      unused locals and parameters; every declared dependency has a source, test, typecheck, or
      build use).
- [x] Every user-facing string follows docs/10 terminology (recreate, never restore)
      (`implementation/marketplace/terminology-check.md` — the 2026-08-10 scan found zero
      forbidden-term matches across the app surfaces and paste-ready Marketplace text).
- [x] No raw webhook payload, token, or description appears in any log line (verified by the
      PASS-04 log-audit test that captures logs across the full suite run;
      `tests/integration/log-audit.test.ts` passed for `v1.0.0-rc.10`).
- [x] ADRs still match the code. The current recovery and race tests defend ADR-007's no-blind-
      retry rule. The state hardening needed no migration. ADR-010 now records attempt-aware lazy
      lease recovery while keeping the accepted no-worker decision.

## Release gates

- [x] Historical `v1.0.0-rc.10` passed the earlier live suite against a real installed add-on on
      the sacrificial developer workspace. Verified 2026-08-11: dev smoke passed 3/3; the full live
      suite passed 11/11 with no skip or block; the running service recorded 11 matching webhook
      receipt and persistence metrics with no error line; and the real Clockify iframe rendered the
      deleted-entry list. The component console had zero visible messages. The Clockify parent page
      had its own migration-status 404 and sandbox warning. A final bounded read across all 10
      workspace users found zero active `RT-PROBE-` entries, and the original Force timer setting
      was restored. See `evidence/live-release-run.md`
      "Live run 16". **Production remains unverified.** Historical evidence follows: LV-01…LV-10 passed
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
- [x] Marketplace text package complete: manifest review, paste-ready listing copy, scope reasons,
      privacy text, and terminology record are present in `implementation/marketplace/`. The short
      description is 119/140 characters; the long description is 1,482/1,500 characters.
- [ ] Marketplace release inputs complete. **Open**: a reviewable 300 × 300 icon is present, but
      other image assets, screenshots, production and public URLs, monitored contacts, portal
      taxonomy, terms, legal approval, and the submission action are not supplied. Text-package
      completeness is not production proof.
- [x] Historical rollback drill executed and recorded (evidence/live-release-run.md §2.3,
      `implementation/reports/PASS-05.md` "Rollback drill") — a real Docker build/run sequence
      including a deliberately incompatible drill-only migration, executed and reversed for real,
      not a dry run. Scope caveat: the pass file's "verify `/healthz` + one component load" was
      satisfied by `/healthz`, the served assets, and the `/component` verified-claims boundary
      (401 without a token). The **authenticated** component render was out of scope for this drill;
      it has since been done separately on the developer environment (evidence "Live run 7").
- [x] Historical GitHub release tagged with notes — `v1.0.0-rc.9`, a **release candidate**, not
      `v1.0.0`. rc.6 fixed the component CSP defect and rc.7 the false P-LOCK-REG warning; both
      were found by driving the addon and the workspace through a real browser (evidence "Live
      run 7" and "Live run 8"), which is why the candidate series moved twice after the passes
      closed. rc.8 carried the UI sweep, and rc.9 the `clockify-sdk-ts-115` 4.0.0 upgrade and the
      name filters.
      docs/15 defines `v1.0.0` as the Marketplace-submission release; the box above still shows
      production unverified, so calling this `v1.0.0` would assert it. The tag notes state exactly
      what was and was not proved.
- [x] Historical 1.3.0/5.1.0 release candidate tagged as `v1.0.0-rc.10`. The tag resolves to PR 22's
      merge commit `1917dfed5960750499eaecc5740bf718bf267b44`. PR CI and post-merge main CI passed.
      GitHub published the release as a prerelease. Its notes state the developer-only proof,
      cleanup result, and open production and Marketplace limits. See `evidence/live-release-run.md`
      "Live run 16".
- [x] `v1.0.0-rc.14` is a published developer prerelease. Its annotated tag peels to
      `2d5e7fbf3507d520456d60f69f70e29e78d9edb9`. Strict live testing passed 45 tests with zero
      skips, and cleanup found zero test entries, tags, or custom fields. The developer deployment
      is healthy. Railway backup creation, backup locking, and an isolated restore are **NOT
      PROVEN — explicitly waived for RC.14**. Production, Marketplace, stable-release, and
      disaster-recovery readiness remain unproven. The later documentation receipt commit is not
      the RC.14 application candidate.

## Next-candidate gates

None of these boxes is checked by the work on `main` since `v1.0.0-rc.14`: `d29f53d` and `1743857`
are documentation and a test-harness fix on an **evaluation** deployment, not a release candidate,
and a gate met on an evaluation deployment does not transfer to a later candidate. What the
2026-08-23 run on `1743857` did establish, recorded in docs/15:

- The strict live gate passed and was reproduced three times — 13 files, 45 tests, exit 0, zero
  skips and zero blocked rows — with valid LV-01B and LV-02B receipts naming that exact candidate,
  that deployment, and the `6a8a5582…` installation. It also found and closed the reason the suite could
  not run at all after migration 0004.
- The cleanup scan covered all 10 workspace users including deactivated ones, every page, and
  active and archived tags and custom fields, and found zero `RT-PROBE-` artifacts with zero read
  failures.
- Node 22 typecheck, lint, 502 offline tests, 111 E2E tests, and both npm audits passed.

Still not run on any commit since `v1.0.0-rc.14`: reachable-ref secret scanning, the local Docker
health and `SIGTERM` gates, and the version-2 migration and rollback drill.

- [ ] The exact next candidate passes Node 22 typecheck, lint, offline tests, `npm run test:e2e`,
      both npm audits, redacted reachable-ref secret scanning, and the local Docker health and
      `SIGTERM` gates. Record candidate-bound receipts. Local evidence does not prove a deployed
      candidate or a Clockify developer installation.
- [ ] The exact next candidate has valid LV-01B and LV-02B receipts. LV-02B names the source ID
      printed by the separate LV-02A trigger. `npm run test:live:release` passes with zero skips.
- [ ] The release cleanup scan covers current and deactivated users and finds zero active `RT-PROBE-` entries.
- [ ] The exact next candidate has a local version-2 migration and rollback drill. The drill stops
      the candidate, restores a copy of the preserved version-2 backup, starts the recorded prior
      image, and verifies the seeded row. `PRAGMA integrity_check` returns `ok`.
- [ ] Before a later candidate, prove Railway platform backup/PITR and isolated Railway platform
      restore, or obtain an explicit candidate-only waiver. The RC.14 waiver applies only to
      RC.14. It does not prove production disaster-recovery readiness or authorize a Railway plan
      upgrade.
- [ ] Before a later candidate is published, the operator records an authorization for its exact
      scope, developer-only deployment, release tag, reachable-ref Gitleaks bound, and backup and
      restore decision. Do not reuse the RC.14 authorization, deployment proof, or waiver.
