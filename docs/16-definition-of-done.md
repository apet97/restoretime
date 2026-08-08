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
- [ ] A confirmed, valid plan recreates the entry through `createForUser`; the success view shows
      the new entry, fidelity, and differences (F9, F12; LV-03, LV-04). **Reason unchecked**: the
      mechanics are proven offline (F9/F12, `tests/integration/mutation.test.ts`,
      `tests/e2e/component-flow.test.ts`'s success view); this box also names LV-03/LV-04 as
      evidence, and those have not run — blocked on `CK_LIVE_API_KEY` (evidence/live-release-run.md
      §1).
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

- [ ] `npm run typecheck`, `lint`, `test`, `build` green on `main`. **Reason unchecked**: all four
      are green, re-verified on this pass's commits (33 test files, 299 tests, 0 typecheck/lint
      errors) — but on this pass's branch, not yet merged to `main`
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

- [ ] Live suite LV-01…LV-10 passes on the production build against the sacrificial workspace
      (LV-10 proves the ambiguity protocol live; it is not optional). **Reason unchecked**: blocked
      — `CK_LIVE_API_KEY` (all rows) and `CK_LIVE_ADDON_BASE_URL` (LV-01/LV-02) are not present in
      this environment. All ten rows are implemented and run (report blocked by exact variable
      name, `npm run test:live` exits 0 with zero rows exercised) — see
      evidence/live-release-run.md §3 and `implementation/reports/PASS-05.md` for the row-by-row
      status. This is the release-blocking gap; nothing stands in for it.
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
      not a dry run.
- [ ] GitHub release tagged with notes. **Reason unchecked**: the tag is created only after every
      gate passes (`implementation/passes/PASS-05-release.md` "Git requirements"), and the live
      suite above has not passed — it is blocked, not green. Tagging was not attempted.
