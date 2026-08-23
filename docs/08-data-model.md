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
| `webhooks_json` | TEXT | encrypted per-webhook tokens keyed by the SDK's `normalizeClockifyWebhookPath()` result (the SDK model has no event field; live INSTALLED payloads can carry `//webhooks/...`, evidence/install-capture-2026-08-08.md) |
| `status` | TEXT | `ACTIVE`/`INACTIVE`, owned only by STATUS_CHANGED. A redelivered INSTALLED context does not overwrite it. |
| `installed_at` | INTEGER | epoch **milliseconds** (the SDK `ClockifyInstallationContext.installedAt` type is `number`); the app sets it to `Date.now()` at INSTALLED receipt (`{...payload, installedAt: Date.now()}` — the payload itself has no generation) |
| `broken_at` | TEXT | set when Clockify rejects the installation's token (401 code `4017`, docs/03 §6); distinct from `status` — different remedy (reinstall, not re-enable). A changed-token INSTALLED delivery clears it only when `installed_at` still matches that saved generation. Migration 0002 |

Store methods mirror the SDK in-memory semantics exactly: `load` → SELECT;
`save` → UPSERT that **skips** when the existing row's `installed_at` is strictly newer than the
incoming context's (`current.installedAt > context.installedAt`); `delete` → returns
`deleted | missing | stale`, where `stale` means the caller supplied `installedAt` and it differs
from the row's. The lifecycle DELETED handler passes **no** `installedAt` (the DELETED payload
carries no generation) → unconditional delete. The generation-guard behaviors are unit-tested at
the store level (PASS-01), never via lifecycle payloads.

`broken_at` records a rejected Clockify connection, not a disabled add-on. A same-token INSTALLED
redelivery preserves it. A changed-token INSTALLED delivery can clear it only with an
`installed_at`-matched update after the encrypted store saves that generation. `STATUS_CHANGED ->
ACTIVE` leaves `broken_at` unchanged, because re-enable and reinstall have different remedies.

### `recoverable_entries`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | internal UUID |
| `workspace_id` | TEXT NOT NULL | tenant boundary |
| `addon_id` | TEXT NOT NULL | installation generation that captured this row; with `workspace_id` it is the ownership key every read and write scopes by (migration 0004) |
| `source_entry_id` | TEXT NOT NULL | deleted Clockify entry id |
| `owner_id` | TEXT NOT NULL | authorization + recreate target |
| `detected_at` | TEXT NOT NULL | server receipt time (W14) |
| `source_json` | TEXT NOT NULL | DeletedTimeEntry (docs/06) |
| `lifecycle_state` | TEXT NOT NULL | CHECK constraint, six states (docs/06) |
| `claim_token` | TEXT | fencing token of the active attempt |
| `claim_expires_at` | TEXT | 60 s lease |
| `new_entry_id` | TEXT | recreated entry id |
| `recreated_at` / `recreated_by` | TEXT | |
| `parent_recoverable_id` | TEXT REFERENCES `recoverable_entries(id)` | same-owner lineage |

Constraints:

- `UNIQUE(workspace_id, source_entry_id)` — duplicate webhook and duplicate-recovery guard (F2, F11).
  Deliberately workspace-wide rather than per generation: a Clockify time entry can be deleted
  exactly once, so the same `source_entry_id` cannot legitimately appear under two generations, and
  the wider rule is a strictly stronger guard. A superseded generation's rows are purged on
  install, so it never blocks a legitimate capture.
- `CREATE UNIQUE INDEX ... ON recoverable_entries(workspace_id, new_entry_id) WHERE new_entry_id IS NOT NULL`
  — double-adoption guard (advisor). Workspace-wide for the same reason.
- `INDEX(workspace_id, addon_id, owner_id)` — list queries.
- `INDEX(workspace_id, addon_id, detected_at DESC, id DESC)` — the keyset list order (docs/03).

### `recreation_plans`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `recoverable_entry_id` | TEXT NOT NULL REFERENCES | |
| `created_by` | TEXT NOT NULL | viewer user id |
| `created_at` | TEXT NOT NULL | |
| `source_hash` | TEXT NOT NULL | sha256 of normalized source |
| `choices_json` | TEXT NOT NULL | the choices the plan was built from — revalidation (docs/07 §7) reruns preflight with the identical choices, which is not implementable without storing them |
| `resolution_json` | TEXT NOT NULL | per-dependency outcome |
| `planned_request_json` | TEXT NOT NULL | exact createForUser body |
| `warnings_json` / `blockers_json` / `action_required_json` | TEXT NOT NULL | |
| `presentation_json` | TEXT NULL | Current labels and preview values for this plan. It must not duplicate source custom-field values. NULL identifies a plan created before migration 0003; it needs a fresh preflight before recreation. |
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
4. An attempt row exists for every transition out of RECREATING — with one carve-out: a fenced
   release of a claim that never issued a Clockify call (`releaseClaim`: a racing confirm consumed
   the plan first, or the baseline read hit the page bound) puts back the pre-claim state with no
   attempt row, because nothing was attempted.
5. `source_json` never contains tokens, raw payload envelopes, or rate objects.

## Retention and deletion

- Normalized deleted-entry rows remain after recreation or dismissal. Those actions update the
  lifecycle state; they do not delete `source_json`. There is no time-based expiry in v1. The rows
  remain until uninstall, so volume grows with deleted entries while the add-on stays installed.
- `source_json` keeps `timeZone` and `clientName` as part of the deletion record. The current UI
  does not render these two fields.
- Each preflight creates a new plan and marks the prior ACTIVE plan STALE. Before it does this, it
  deletes older STALE or CONSUMED plans for that deleted entry when they have no attempt. Plans
  linked to attempts remain for audit until uninstall. This bounded cleanup is part of preflight;
  there is no worker or sweeper (ADR-010).
- Every `recoverable_entries` row carries `addon_id`: the installation generation that captured
  it. Clockify issues a fresh `addonId` per install, so `(workspace_id, addon_id)` is one
  installation lifetime while `workspace_id` alone is only the tenant. Plans and attempts inherit
  the scope through their entry.
- Uninstall (`DELETED` lifecycle): hard-delete the installation row and every domain-table row
  **that installation owns**, in one transaction, scoped by `(workspace_id, addon_id)`. An event
  naming a generation this app no longer holds is acknowledged as stale and purges only that
  generation's leftovers. Never delete by workspace alone: a delayed event for a superseded
  generation would otherwise erase the current one's recovery data. (F17)
- Install (`INSTALLED` lifecycle): a new `addonId` for a workspace supersedes every older
  generation there — Clockify allows one installation of an add-on per workspace at a time, so a
  new identity proves the previous one was removed. Its rows are purged in the same transaction,
  which is what stops a missed `DELETED` from retaining deleted-entry data indefinitely.
- Webhook ingestion is fenced on the installation row: the insert is a single
  `INSERT ... SELECT ... WHERE EXISTS (...)`, so a delivery whose verification began before an
  uninstall and finished after it writes nothing. It is acknowledged (a retry cannot succeed) and
  counted as `webhook_after_uninstall`, never as a created row.
  The purge is delivery-dependent: it only runs when Clockify's `DELETED` call reaches this
  process. A workspace uninstalled while the host is unreachable stays removed on Clockify's side
  and keeps its rows here, and nothing reconciles the two afterwards — observed live (evidence
  "Live run 11"). v1 accepts this; a reconciliation pass is the fix if it ever matters.
- The uninstall transaction affects the active database. It does not rewrite backup files that
  already exist. Backup access and retention are deployment-operator responsibilities (docs/14).
- Dismissal keeps a DISMISSED row (duplicate deliveries must not resurrect it, W10). Undismiss
  returns the entry to IDLE.
- Sensitive content: descriptions and custom-field values can hold business data. The normalized
  copy is in `source_json`. A plan can also copy values into `choices_json` and
  `planned_request_json`; attempt baselines, reconciliation results, and diffs can identify live
  entries. `presentation_json` stores current labels and preview values, but it must not duplicate
  source custom-field values. A definitive attempt outcome clears its baseline and reconciliation
  evidence. An ambiguous attempt keeps that evidence only until a definitive resolution clears
  it. These values are never log fields. Backups inherit the sensitivity of the database file
  (docs/14).

## Why SQLite (ADR-005 summary)

One process, low write volume (deletion events), ACID transactions, zero infrastructure. The claim
CAS, unique constraints, and partial indexes used above are all single-statement SQLite features.
Backups = copy the file (with WAL checkpoint). If a future deployment needs multi-instance HA,
port the four tables to Postgres — the data layer is ~4 small query modules, so no abstraction is
built now for that hypothetical.
