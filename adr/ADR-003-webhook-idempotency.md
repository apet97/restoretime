# ADR-003 — Natural-key idempotent ingestion

- Status: accepted 2026-08-08
- Context: Delivery is at-least-once; `idempotency-key` changes per attempt (W10). The addon SDK
  ships a generic idempotency lease store. The ingestion effect is exactly one write: create the
  recoverable row.
- Decision: Ingestion runs one database transaction. It uses `INSERT OR IGNORE` on
  `recoverable_entries`, keyed by `UNIQUE(workspace_id, source_entry_id)`. When the deleted entry is
  itself a prior recreation, the same transaction can also attach the lineage parent. The dedup
  decision and all ingestion effects commit together. No inbox table, lease store, or event log.
- Consequences: The SDK lease store is deliberately unused (recorded in docs/04). Dismissal must
  keep a DISMISSED row, because a genuine duplicate can arrive after a 2xx (W10) and must not
  resurrect the entry.
- Evidence: docs/01 W10; advisor review 2026-08-08 (transactional dedup+effect requirement —
  satisfied by construction here).
