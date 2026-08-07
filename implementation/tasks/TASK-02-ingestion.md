# TASK-02 — Ingestion and normalization

- Pass: PASS-02
- Goal: verified `TIME_ENTRY_DELETED` → normalized `DeletedTimeEntry` → one atomic insert.
- Why: the webhook is the only data source (ADR-002); the insert is the only ingestion write
  (ADR-003).
- Prerequisites: TASK-01.
- Files/modules: `src/ingest/*`, `src/store/entries.ts` (insert-if-absent, lineage link),
  `tests/fixtures/webhook/`, `tests/contract/*`, `tests/unit` normalization tests.
- Interfaces: `withClockifyVerifiedWebhookRequest`; `DeletedTimeEntry` per docs/06.
- Behavior: verify → guard → normalize → `INSERT OR IGNORE` (+ lineage link in the same tx) → 204.
  Malformed body → 400 + structured log (no payload). Unknown installation → 401.
- Failure behavior: DB error → 500 (redelivery retries; insert is idempotent).
- Tests: CT-01…CT-05, UT-N01, UT-N02, UT-L01, IT-01, IT-02, IT-10.
- Acceptance: fixtures pass; duplicate deliveries are no-ops; dismissed rows absorb redelivery.
