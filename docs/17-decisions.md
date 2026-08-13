# 17 — Decisions

One-line summaries with links. The ADRs hold context, evidence, and consequences. Changing a
decision requires editing the ADR (status + date) — never silent drift.

| ADR | Decision | Rejected alternatives |
|---|---|---|
| ADR-001 | The product recreates new entries; it never "restores" | Any identity-preserving fiction |
| ADR-002 | `TIME_ENTRY_DELETED` is the only deleted-entry source | `/entities/deleted` polling; created/updated feed tracking; pre-delete snapshots |
| ADR-003 | Webhook dedup = natural-key insert-if-absent; no inbox table, no lease store | SDK idempotency lease; separate inbox; `idempotency-key` dedup |
| ADR-004 | All creates go through `createForUser` (user-scoped route) | Plain route for own entries (its `userId` is ignored) |
| ADR-005 | SQLite (WAL) via `better-sqlite3`, SQL-file migrations | Postgres/MySQL now; ORM; KV stores |
| ADR-006 | Recreation plans are immutable rows, revalidated before mutation | Recompute-at-execute; trusting the first preflight |
| ADR-007 | Ambiguous creates: baseline-delta reconcile, bounded, user-resolved, never auto-retried | Blind retry; immediate FAILED; auto-deleting candidates |
| ADR-008 | Two-rule policy from verified claims (admin, or owner==viewer) | Generic RBAC; client-supplied roles |
| ADR-009 | Discard raw payloads at the boundary; persist the normalized source and the derived recovery records in docs/08 | Raw payload retention for "debugging" |
| ADR-010 | No background workers: reconcile is lazy (view/manual), lease expiry is claim-time | Sweeper daemon; cron; job queue |

## Standing rejections

- Microservices, event buses, CQRS, event sourcing, Redis, distributed locks, workflow engines,
  plugin systems — no requirement justifies them (evidence: the whole product is one ingestion
  write and one mutation path).
- Owner substitution — no evidence for safe semantics (docs/07 §3).
- Entry updates of any kind — recreation only creates; the PUT edit path (E3) is deliberately
  unused.
- Per-entry rate preservation — impossible by platform design (W6, R9).
