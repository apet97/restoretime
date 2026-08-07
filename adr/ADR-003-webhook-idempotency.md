# ADR-003 — Natural-key idempotent ingestion

- Status: accepted 2026-08-08
- Context: Delivery is at-least-once; `idempotency-key` changes per attempt (W10). The addon SDK
  ships a generic idempotency lease store. The ingestion effect is exactly one write: create the
  recoverable row.
- Decision: Dedup is `INSERT OR IGNORE` into `recoverable_entries` keyed
  `UNIQUE(workspace_id, source_entry_id)`. The dedup decision and the effect are the same
  statement, so a crash can never acknowledge work that was not persisted. No inbox table, no lease
  store, no event log.
- Consequences: The SDK lease store is deliberately unused (recorded in docs/04). Dismissal must
  keep a DISMISSED row, because a genuine duplicate can arrive after a 2xx (W10) and must not
  resurrect the entry.
- Evidence: docs/01 W10; advisor review 2026-08-08 (transactional dedup+effect requirement —
  satisfied by construction here).
