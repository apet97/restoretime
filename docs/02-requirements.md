# 02 — Requirements

Requirements are numbered for traceability. Tests reference these IDs (docs/13).

## Functional

| ID | Requirement | Evidence/Decision |
|---|---|---|
| F1 | Receive `TIME_ENTRY_DELETED` webhooks from Clockify, verify authenticity, and persist a recoverable record before acknowledging. | W10, W11 |
| F2 | Treat duplicate deliveries as no-ops. | W10 |
| F3 | Normalize the webhook payload into a stable internal model at the ingestion boundary. | W1, W2 |
| F4 | List a regular user's own recoverable deleted entries. | Product roles |
| F5 | List all recoverable entries in the workspace for admins, with user/project/date/status filters and search. | Product roles |
| F6 | Show a deleted entry's original values with names (project, task, tags, owner). | W2 |
| F7 | Run a preflight that produces a deterministic recreation plan: permission, dependency resolution, warnings, blockers, fidelity, and an exact request preview. | docs/07 |
| F8 | Require the user to resolve missing dependencies by explicit choice where the API permits a substitute. | No-silent-changes |
| F9 | Recreate by creating a new time entry for the source owner through the user-scoped route. | R1, ADR-004 |
| F10 | Revalidate the plan's mutable dependencies immediately before the create call. Refuse a stale plan. | TOCTOU, docs/07 §7 |
| F11 | Prevent duplicate recreation of the same deleted entry, including concurrent requests. | R7, docs/07 §6 |
| F12 | After a successful create, fetch the new entry and compare it with the plan. Report differences. | R9, R12 |
| F13 | When the create outcome is unknown, mark the attempt AMBIGUOUS and reconcile. Never retry blindly. | R7, R10, docs/07 §8 |
| F14 | Record lineage: if a recreated entry is itself deleted and recreated, keep the chain A→B→C visible. | Domain model |
| F15 | Bulk recreation for admins: select entries, preflight each, confirm once, execute independently. | docs/10 §7 |
| F16 | Offer "recreate as running timer" only when the deleted entry was running, as an explicit choice. | W12 |
| F17 | On uninstall, delete the workspace's data per the retention policy. | docs/12, docs/08 |

## Non-functional

| ID | Requirement |
|---|---|
| N1 | All authorization decisions are server-side, from verified component claims. |
| N2 | No cross-workspace data access is possible, including by forged IDs. |
| N3 | Persist only the fields the product uses (docs/08). Never log webhook bodies or tokens. |
| N4 | Installation tokens are encrypted at rest with the addon SDK codec. |
| N5 | All Clockify-controlled strings are escaped before rendering. |
| N6 | One Node process, one SQLite database, no background workers (docs/05). |
| N7 | Reads from Clockify may retry on 429/5xx with backoff. Writes never auto-retry. |
| N8 | Every user-facing failure states: what happened, whether anything was created, what to do next. |

## Explicitly out of scope

- Restoration of entry identity, approval state, invoice links, rates, or audit history (impossible
  by platform design — R9).
- Per-entry custom-field value writes (not supported by the public API — R5).
- "Deleted by" attribution (the webhook carries no actor — W13).
- Real-time sync of any Clockify data other than deleted time entries.
- Use of `/entities/deleted`, `/entities/created`, `/entities/updated` (ADR-002).
- A generic event-processing framework, RBAC framework, or plugin system.
