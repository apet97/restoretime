# ADR-004 — User-scoped create route for every recreation

- Status: accepted 2026-08-08
- Context: The plain create route ignores a `userId` body field (entries always belong to the
  caller). The user-scoped route `POST /workspaces/{ws}/user/{userId}/time-entries` creates for the
  target user — verified live for another user (DSWH2; architect probe L1) and for self (L2). The
  SDK exposes it as `timeEntries.createForUser`.
- Decision: Every recreation — self or admin-for-user — calls `createForUser` with the source
  owner. One code path; the owner is always explicit.
- Consequences: The plain `timeEntries.create` is never used. Whether an addon token may create for
  any workspace user is verified by the release live suite (LV-04); a restriction surfaces as a
  mapped failure, never a silent owner change.
- Evidence: docs/01 R1, R3; live addendum L1/L2.
