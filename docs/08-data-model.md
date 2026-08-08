# 08 — Data model

One SQLite database, WAL mode, `foreign_keys=ON`. Migrations are numbered SQL files under
`src/store/migrations/`, applied in order at boot (`user_version` pragma tracks). No ORM;
`better-sqlite3` with prepared statements.

## Tables

### `installations`

Implements the addon SDK `ClockifyInstallationStore` contract. The SDK encryption wrapper
(`wrapClockifyInstallationStoreWithEncryption`) encrypts `auth_token` and nested webhook tokens
before rows are written.

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | TEXT | PK part 1 |
| `addon_id` | TEXT | PK part 2 |
| `addon_user_id` | TEXT | from INSTALLED payload |
| `as_user` | TEXT | from INSTALLED payload |
| `api_url` | TEXT | per-installation API base |
| `auth_token` | TEXT | encrypted by the SDK codec |
| `webhooks_json` | TEXT | encrypted per-webhook tokens keyed by **normalized** webhook path (the SDK model has no event field; live INSTALLED payloads can carry `//webhooks/...` — normalize by collapsing repeated slashes before storing/looking up, evidence/install-capture-2026-08-08.md) |
| `status` | TEXT | `ACTIVE`/`INACTIVE` (STATUS_CHANGED) |
| `installed_at` | INTEGER | epoch **milliseconds** (the SDK `ClockifyInstallationContext.installedAt` type is `number`); the app sets it to `Date.now()` at INSTALLED receipt (`{...payload, installedAt: Date.now()}` — the payload itself has no generation) |

Store methods mirror the SDK in-memory semantics exactly: `load` → SELECT;
`save` → UPSERT that **skips** when the existing row's `installed_at` is strictly newer than the
incoming context's (`current.installedAt > context.installedAt`); `delete` → returns
`deleted | missing | stale`, where `stale` means the caller supplied `installedAt` and it differs
from the row's. The lifecycle DELETED handler passes **no** `installedAt` (the DELETED payload
carries no generation) → unconditional delete. The generation-guard behaviors are unit-tested at
the store level (PASS-01), never via lifecycle payloads.

### `recoverable_entries`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | internal UUID |
| `workspace_id` | TEXT NOT NULL | tenant boundary |
| `source_entry_id` | TEXT NOT NULL | deleted Clockify entry id |
| `owner_id` | TEXT NOT NULL | authorization + recreate target |
| `detected_at` | TEXT NOT NULL | server receipt time (W14) |
| `source_json` | TEXT NOT NULL | DeletedTimeEntry (docs/06) |
| `lifecycle_state` | TEXT NOT NULL | CHECK constraint, six states (docs/06) |
| `claim_token` | TEXT | fencing token of the active attempt |
| `claim_expires_at` | TEXT | 60 s lease |
| `new_entry_id` | TEXT | recreated entry id |
| `recreated_at` / `recreated_by` | TEXT | |
| `parent_recoverable_id` | TEXT REFERENCES `recoverable_entries(id)` | lineage |

Constraints:

- `UNIQUE(workspace_id, source_entry_id)` — duplicate webhook and duplicate-recovery guard (F2, F11).
- `CREATE UNIQUE INDEX ... ON recoverable_entries(workspace_id, new_entry_id) WHERE new_entry_id IS NOT NULL`
  — double-adoption guard (advisor).
- `INDEX(workspace_id, owner_id)`, `INDEX(workspace_id, detected_at)` — list queries.

### `recreation_plans`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `recoverable_entry_id` | TEXT NOT NULL REFERENCES | |
| `created_by` | TEXT NOT NULL | viewer user id |
| `created_at` | TEXT NOT NULL | |
| `source_hash` | TEXT NOT NULL | sha256 of normalized source |
| `resolution_json` | TEXT NOT NULL | per-dependency outcome |
| `planned_request_json` | TEXT NOT NULL | exact createForUser body |
| `warnings_json` / `blockers_json` | TEXT NOT NULL | |
| `fidelity` | TEXT NOT NULL | FULL/ADJUSTED/PARTIAL/IMPOSSIBLE |
| `status` | TEXT NOT NULL | ACTIVE/STALE/CONSUMED |

### `recreation_attempts`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | also the claim token value |
| `plan_id` | TEXT NOT NULL REFERENCES | |
| `recoverable_entry_id` | TEXT NOT NULL REFERENCES | |
| `started_at` / `finished_at` | TEXT | |
| `outcome` | TEXT | SUCCESS/FAILED/AMBIGUOUS |
| `new_entry_id` | TEXT | when known |
| `error_status` / `error_code` / `error_message` | INTEGER/TEXT | Clockify error mapping |
| `baseline_json` | TEXT | entry IDs present before the create (ambiguity baseline) |
| `reconcile_json` | TEXT | last reconcile summary (counts, candidate ids) |
| `diff_json` | TEXT | post-create verification differences |

## Invariants

1. A row in `recoverable_entries` is created only by the webhook insert-if-absent.
2. `RECREATED` implies `new_entry_id` present and one SUCCESS attempt pointing at it.
3. At most one ACTIVE plan per entry (partial unique index).
4. An attempt row exists for every transition out of RECREATING.
5. `source_json` never contains tokens, raw payloads, or rate objects.

## Retention and deletion

- Rows live until recreation, dismissal, or uninstall. There is no time-based expiry in v1; volume
  is bounded by how often users delete entries.
- Uninstall (`DELETED` lifecycle): hard-delete the installation row and all rows in the three
  domain tables for the workspace, in one transaction. (F17)
  The purge is delivery-dependent: it only runs when Clockify's `DELETED` call reaches this
  process. A workspace uninstalled while the host is unreachable stays removed on Clockify's side
  and keeps its rows here, and nothing reconciles the two afterwards — observed live (evidence
  "Live run 11"). v1 accepts this; a reconciliation pass is the fix if it ever matters.
- Dismissal keeps a DISMISSED row (duplicate deliveries must not resurrect it, W10). Undismiss
  returns the entry to IDLE.
- Sensitive content: entry descriptions and custom-field values can hold business data. They exist
  only in `source_json`, never in logs. Backups inherit the database file; document the sensitivity
  in operations (docs/14).

## Why SQLite (ADR-005 summary)

One process, low write volume (deletion events), ACID transactions, zero infrastructure. The claim
CAS, unique constraints, and partial indexes used above are all single-statement SQLite features.
Backups = copy the file (with WAL checkpoint). If a future deployment needs multi-instance HA,
port the four tables to Postgres — the data layer is ~4 small query modules, so no abstraction is
built now for that hypothetical.
