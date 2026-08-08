# 16 — Definition of done

The product is done when every statement is true and verified.

## Contracts

- [ ] `TIME_ENTRY_DELETED` ingestion verifies, normalizes, persists, and acks; duplicates are
      no-ops (IT-01, IT-02, CT-01…CT-05).
- [ ] A regular user sees only their own deleted entries; an admin sees the workspace's (IT-07).
- [ ] Preflight produces plans that match docs/07 rule-for-rule (UT-P01…P16).
- [ ] A confirmed, valid plan recreates the entry through `createForUser`; the success view shows
      the new entry, fidelity, and differences (F9, F12; LV-03, LV-04).
- [ ] Concurrent recreation of the same source is impossible (IT-03).
- [ ] An unknown-outcome create becomes AMBIGUOUS and resolves per docs/07 §8; no automatic retry
      exists anywhere (IT-04).
- [ ] Recreated-deleted-recreated chains show lineage (IT-06).
- [ ] Uninstall purges the workspace's data (IT-11).

## Quality bars

- [ ] `npm run typecheck`, `lint`, `test`, `build` green on `main`.
- [ ] No dependency beyond docs/05's list; no dead code; no TODO/FIXME in `src/`.
- [ ] Every user-facing string follows docs/10 terminology (recreate, never restore).
- [ ] No raw webhook payload, token, or description appears in any log line (verified by the
      PASS-04 log-audit test that captures logs across the full suite run).
- [ ] ADRs still match the code; deviations were re-decided, not drifted into.

## Release gates

- [ ] Live suite LV-01…LV-10 passes on the production build against the sacrificial workspace
      (LV-10 proves the ambiguity protocol live; it is not optional).
- [ ] Marketplace manifest review package complete (docs/15).
- [ ] Rollback drill executed and recorded.
- [ ] GitHub release tagged with notes.
