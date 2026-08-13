# 05 — Architecture

## Shape

One Node 22 + TypeScript process. One SQLite database (WAL). One Clockify sidebar component
(iframe). No background workers, no queues, no caches, no second service.

```text
                    CLOCKIFY PLATFORM
                          │
               TIME_ENTRY_DELETED (RS256 JWT + per-installation token)
                          ▼
              POST /webhooks/time-entry-deleted        ── verified by addon SDK
                          │
                          ▼
                 normalize payload (guard)             ── contract-tested against fixtures
                          │
                          ▼
              insert-if-absent recoverable_entries     ── UNIQUE(workspace_id, source_entry_id)
                          │                                 same statement = dedup + effect
                          ▼
                        SQLite ────────────────────────────────┐
                          ▲                                    │
                          │                                    │
Clockify sidebar iframe   │  GET /component (verified JWT)     │
        │                 │                                    │
        ▼                 │                                    │
  /api/* calls (Bearer component JWT, verified per call)       │
        │                                                      │
        ▼                                                      │
  authorization (claims: user, workspaceId, workspaceRole)     │
        │                                                      │
        ▼                                                      │
  preflight ──► current-state lookups via clockify-ts-sdk      │
        │        (users, project, tasks, tags, custom fields,  │
        │         workspace settings)                          │
        ▼                                                      │
  RecreationPlan (immutable row, hash-pinned)                  │
        │                                                      │
        ▼  user confirms                                       │
  revalidate mutable deps ──► stale? → new plan                │
        │                                                      │
        ▼                                                      │
  atomic claim (lease) ──► timeEntries.createForUser           │
        │                                                      │
        ├── 201 ──► timeEntries.get ──► diff vs plan ──► RECREATED
        ├── 4xx ──► FAILED (mapped reason)                     │
        └── uncertain/unknown result ──► AMBIGUOUS ──► baseline-delta reconcile
```

## Processes and modules

One process, layered by dependency direction. No interfaces without two consumers; no dependency
inversion for its own sake. Routing constraint: the SDK router matches exact `method:path` only
(docs/04) — the API uses exact paths with `entryId` in body/query (docs/03 §5).

```text
src/
  server.ts            composition root: manifest, addon, routes, db, boot
  manifest.ts          ClockifyManifest builder (scopes, webhook, component, lifecycle)
  platform/
    installations.ts   ClockifyInstallationStore over SQLite (+ SDK encryption wrapper)
    verify.ts          parser singletons, app-API auth middleware (verifyClockifyToken)
  ingest/
    webhook.ts         route handler: verify → guard → normalize → insert-if-absent → 204
    deleted-entry.ts   payload guard + normalization to DeletedTimeEntry
  domain/
    entry.ts           DeletedTimeEntry model + types
    policy.ts          authorization predicates (pure)
    preflight.ts       plan builder (pure decision fn over fetched state)
    fidelity.ts        fidelity classification (pure)
    plan.ts            plan types, hashing, staleness compare (pure)
  clockify/
    client.ts          createClockifyClient wiring per installation
    preflight-data.ts  the exact lookup set for preflight
    recreate.ts        createForUser + get + reconcile reads
  store/
    db.ts              sqlite open, migrate, pragma
    migrations/        0001_init.sql …
    entries.ts         recoverable_entries queries (claim, transition, list, lineage)
    plans.ts           recreation_plans queries
    attempts.ts        recreation_attempts queries
  api/
    routes.ts          /api/* handlers (list, detail, preflight, recreate, reconcile, dismiss, options)
    views.ts           HTML shell + escaping helpers
  ui/                  iframe TS (vanilla, esbuild bundle): list, detail, confirm, result
```

## Key decisions (pointers)

- ADR-001 recreation-not-restoration; ADR-002 webhook-only source (no `/entities/*` feeds);
  ADR-003 natural-key idempotent ingestion (no inbox table, no lease store);
  ADR-004 user-scoped create route only; ADR-005 SQLite + better-sqlite3;
  ADR-006 immutable plans with revalidation; ADR-007 ambiguity protocol;
  ADR-008 authorization model; ADR-009 normalized-only persistence (no raw payload hoarding).

## Runtime data flow invariants

1. The webhook handler performs one atomic transaction: the `INSERT OR IGNORE` into
   `recoverable_entries` plus, only when a row was inserted, the lineage-link
   `UPDATE parent_recoverable_id`. Dedup and effect commit or roll back together, so a crash can
   never ack a delivery that was not persisted. A link is written only when the parent and child
   have the same owner (advisor-reviewed).
2. Every `/api/*` route derives `workspaceId` and the viewer from the verified JWT only. Path and
   body parameters never carry workspace or user identity.
3. Only the recreate path creates Clockify entries. Reconciliation only links existing Clockify
   IDs to rows. The webhook path never creates Clockify entries. There is exactly one mutation
   path (advisor-reviewed).
4. A `RECREATING` claim holds a UUID token and a 60-second lease. Result writes fence on the
   token. The detail view or the next claim recovers an expired lease. If no attempt started, the
   detail view returns the row to `IDLE`; a new claim instead replaces the expired token and keeps
   the row `RECREATING`. If an attempt started, recovery uses its stored outcome or changes the row
   to `AMBIGUOUS` and does not issue a new claim. The app does not retry an uncertain create
   request. No sweeper process is used.
5. All rendering escapes Clockify-controlled strings. `createClockifyHtmlResponse` sets CSP and
   `frame-ancestors`.
6. Logs carry IDs, states, and error codes. Never webhook bodies, entry descriptions, or tokens
   (the SDK `onError` redaction covers platform headers; app loggers follow the same rule).

## Configuration

Environment variables (no config files):

| Variable | Purpose |
|---|---|
| `PORT` | HTTP listen port |
| `PUBLIC_BASE_URL` | Addon public HTTPS origin (manifest `baseUrl`, CSP) |
| `CLOCKIFY_PARENT_ORIGIN` | Clockify app origin of the environment (production `https://app.clockify.me`, developer `https://developer.clockify.me`). Feeds CSP `frame-ancestors` and the iframe bridge `parentOrigin` |
| `DATABASE_PATH` | SQLite file path |
| `ADDON_KEY` | Manifest key; JWT `sub` check |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key for the installation token codec |
| `LOG_LEVEL` | `info` default |

No secrets beyond the encryption key. Installation tokens arrive at runtime and are stored
encrypted.

The RC.11 Railway deployment also sets `RESTORETIME_CANDIDATE_ID` to the full 40-character merged
Git commit and sets `RAILWAY_RUN_UID=1000`. These values are non-secret platform metadata.
`loadConfig()` does not read them. The candidate-bound live handoff reads the candidate ID only
through `railway ssh` and rejects a deployment whose value does not match
`CK_LIVE_CANDIDATE_ID` (docs/13 and docs/15).
