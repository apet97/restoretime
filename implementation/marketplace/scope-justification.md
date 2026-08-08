# Scope justification (docs/15 "Scopes requested (minimum set)")

Every scope below is read-only except `TIME_ENTRY_WRITE`, and every scope maps to a specific,
traceable call site — no scope is requested "for future use" (AGENTS.md rule 15: no speculative
features).

| Scope | Why it is requested | Where it is used |
|---|---|---|
| `TIME_ENTRY_READ` | Reads the deleted entry's current-state dependents at preflight time (does the project/task/tag/custom-field still exist), and verifies a create by reading the new entry back | `src/clockify/preflight-data.ts` (`fetchEntryWorkspaceState`), `src/clockify/recreate.ts` (`timeEntries.get`, `listForUser` baseline/reconcile reads) |
| `TIME_ENTRY_WRITE` | The one mutation the product performs: creating the new (recreated) time entry | `src/clockify/recreate.ts` `executeCreate` → `timeEntries.createForUser` (docs/03 §2, ADR-004: user-scoped create route only — the product never uses the plain, non-user-scoped create route) |
| `PROJECT_READ` | Preflight must know whether the source project still exists, and whether it is archived (P-PROJ-GONE, P-PROJ-ARCH) | `src/clockify/preflight-data.ts` |
| `TASK_READ` | Same, for the source task (P-TASK-GONE, P-TASK-CTX) | `src/clockify/preflight-data.ts` |
| `TAG_READ` | Same, for each source tag (P-TAG-GONE, P-TAG-ARCH) | `src/clockify/preflight-data.ts` |
| `USER_READ` | Confirms the entry's owner is still an active workspace member before recreating on their behalf (P-OWNER); needed for every recreation, not only admin-driven ones | `src/clockify/preflight-data.ts` `fetchSharedWorkspaceData` |
| `CUSTOM_FIELDS_READ` | Reads the workspace's current custom-field definitions (active/inactive, allowed values, required, default) to resolve P-CF-* rules before any value is sent | `src/clockify/preflight-data.ts` |
| `WORKSPACE_READ` | Reads workspace-level settings that preflight rules depend on: `forceProjects`, `forceTasks`, `forceTags`, `forceDescription`, `onlyAdminsCanChangeBillableStatus`, `defaultBillableProjects`, `timeTrackingMode`, lock settings | `src/clockify/preflight-data.ts` `fetchSharedWorkspaceData` |

## What is deliberately NOT requested

- No `PROJECT_WRITE`/`TASK_WRITE`/`TAG_WRITE`/`CUSTOM_FIELDS_WRITE`: the product never creates or
  modifies a project, task, tag, or custom-field definition — only a time entry.
- No approval, invoice, or report scopes: recreated entries are never part of an approval request
  or invoice by design (ADR-001, docs/00 "Always different on the new entry").
- No `/entities/*` feed access of any kind (ADR-002): the deletion webhook is the only source of
  deleted-entry data.

## Minimum-subscription plan

FREE (`minimalSubscriptionPlan`, docs/15). No feature in this product depends on a paid Clockify
plan; nothing in the review evidence to date suggests otherwise.
