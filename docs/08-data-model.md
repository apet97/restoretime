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
| `webhooks_json` | TEXT | encrypted per-webhook tokens keyed by webhook path (SDK model has no event field) |
| `status` | TEXT | `ACTIVE`/`INACTIVE` (STATUS_CHANGED) |
| `installed_at` | TEXT | generation guard for out-of-order uninstall |

Store methods map: `load` → SELECT; `save` → UPSERT skipping rows older than current
`installed_at` (SDK semantics); `delete` → generation-guarded delete returning
`deleted|missing|stale`.

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
