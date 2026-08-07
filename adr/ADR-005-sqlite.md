# ADR-005 — SQLite with better-sqlite3

- Status: accepted 2026-08-08
- Context: One process; write volume bounded by deletion events; the design needs atomic CAS
  claims, unique constraints, and partial indexes — all single-statement SQLite features.
- Decision: SQLite in WAL mode via `better-sqlite3` (synchronous prepared statements, no ORM).
  Migrations are numbered SQL files tracked by `user_version`.
- Consequences: Single-writer at a time, which matches one ingestion write and rare recreations.
  Backup is a file copy after `wal_checkpoint`. A future multi-instance deployment would require
  Postgres; no abstraction is built for that now — the data layer is four small query modules.
- Evidence: docs/08 invariants; N6.
