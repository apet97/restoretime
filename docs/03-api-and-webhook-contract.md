# 03 — API and webhook contract

Everything the application relies on. Each item names the exact SDK method. Evidence references:
`docs/01-evidence-baseline.md`.

## 1. Inbound: `TIME_ENTRY_DELETED` webhook

- Declaration: manifest webhook via addon SDK builder `.onTimeEntryDeleted().path("/webhooks/time-entry-deleted")`.
- Verification: `withClockifyVerifiedWebhookRequest(parser, { expectedEventType: "TIME_ENTRY_DELETED", getExpectedWebhookAuthToken })`.
  The per-installation webhook token comes from the `INSTALLED` lifecycle payload (`webhooks[]`,
  keyed by webhook `path` — the SDK's `ClockifyLifecycleWebhookToken` is `{path, webhookType,
  authToken}`, with no event field; v1 declares exactly one webhook).
  The SDK performs the RS256 JWT check and the constant-time token compare (W11).
- Body: flat time-entry object. Full field-by-field contract: webhook campaign `payload-contract.md`.
  Normalization input rules:
  - `id`, `workspaceId`, `userId`, `description`, `billable`, `projectId`, `type`, `isLocked`,
    `currentlyRunning` — top level.
  - `timeInterval.start` (required), `timeInterval.end` (null when running), `timeInterval.timeZone`,
    `zonedStart`/`zonedEnd` (display only).
  - `project.name`, `project.clientName`, `project.archived`; `task.id`, `task.name` (or `task:null`);
    `tags[].id`, `tags[].name`; `user.name`.
  - `customFieldValues[]`: `{customFieldId, name, value}`; per-item `type` absent (W7).
  - Absent: `taskId`, `tagIds` (top level), `createdAt`, `updatedAt`, deletion time, actor (W13, W14).
- Ack: 2xx only after the recoverable row is persisted. Any non-2xx invites redelivery (W10).
- Duplicates: same `id` + event type can arrive more than once; insert-if-absent is the dedup (W10).

## 2. Outbound reads (preflight and verification)

All through `clockify-sdk-ts-115` (`createClockifyClient({ addonToken })`, R11). The client retries
reads on 408/429/5xx with backoff by default; that behavior is kept (N7).

| Purpose | SDK method | Route |
|---|---|---|
| Workspace settings (forceProjects, locks, billable permission) | `workspaces.get` | `GET /workspaces/{ws}` |
| Owner existence/status | `users.list` (status=ALL, memberships) | `GET /workspaces/{ws}/users` |
| Project current state | `projects.get` (404 = gone) | `GET /workspaces/{ws}/projects/{id}` |
| Replacement project options | `projects.list` | `GET /workspaces/{ws}/projects` |
| Task current state + options | `tasks.list` / `tasks.get` | `GET /workspaces/{ws}/projects/{pid}/tasks[/{id}]` |
| Tag current state + options | `tags.list` | `GET /workspaces/{ws}/tags` |
| Custom-field definitions (type, defaults, status) | `customFields.listForWorkspace` (`entity-type=TIMEENTRY`) | `GET /workspaces/{ws}/custom-fields` |
| Post-create verification | `timeEntries.get` | `GET /workspaces/{ws}/time-entries/{id}` |
| Ambiguity reconciliation (baseline + delta) | `timeEntries.listForUser` (`start`, `end`, `description`) | `GET /workspaces/{ws}/user/{uid}/time-entries` |

Notes:

- There is no global time-entry list route; reconciliation is per-user, which matches the
  reconciliation design (the owner's list only).
- The per-user list response model (`TimeEntry`) carries no `createdAt` (W14). Reconciliation uses
  baseline-delta, not a created-after filter (docs/07 §8).
- `entityChangesExperimental.*` is never called (ADR-002). The SDK's `listDeleted` response type is
  also known-wrong vs live (wrapper vs bare array); irrelevant because the feed is banned.

## 3. Outbound write (recreation)

- Method: `timeEntries.createForUser` → `POST /workspaces/{ws}/user/{userId}/time-entries` (R1).
- Body sent: `{workspaceId, userId, start, end?, description?, billable?, projectId?, taskId?,
  tagIds?, customFields?}`.
  - `end` omitted only when the user explicitly chose "recreate as running timer" (W12, R2).
  - `customFields` is included only per the P-CF rules: source values that differ from current
    defaults, plus user-entered values, as `[{customFieldId, sourceType:"WORKSPACE", value}]`
    (R5). The response-shaped key `customFieldValues` is never sent — it is silently ignored.
  - `type` is never sent: the create default is `REGULAR` and only `REGULAR` sources are
    recreated (R17).
- Retry: never. The SDK never retries POST (matches N7). A transport failure or 5xx is AMBIGUOUS
  (docs/07 §8). A 4xx is FAILED with a mapped reason (R15).
- Response: created entry. Verification still fetches it with `timeEntries.get` and diffs against
  the plan (F12); a 201 body alone is not the final check.

## 4. Lifecycle (inbound)

| Event | Path | Handling |
|---|---|---|
| `INSTALLED` | `/lifecycle/installed` | Verify (`withClockifyVerifiedLifecycleRequest` family), persist installation context encrypted (S3), including per-webhook tokens. |
| `STATUS_CHANGED` | `/lifecycle/status-changed` | Persist status. INACTIVE installations keep data; the component shows a disabled notice. |
| `DELETED` | `/lifecycle/deleted` | Verify, then hard-delete the installation and all workspace data (F17, docs/08). |
| `SETTINGS_UPDATED` | not declared | The addon declares no custom settings in v1. |

## 5. Component (inbound)

- `GET /component` via `registerComponent` + `withClockifyVerifiedComponentRequest`. Serves the
  iframe HTML shell with SDK security headers (`createClockifyHtmlResponse`, `frame-ancestors` set
  to the Clockify app origin).
- App API routes (`/api/*`) verify the same JWT per call:
  `verifyClockifyToken(parser, token, { requireExpiration: true })` — the option matters: the SDK
  default is `false`, and only the component-request verifier forces it. No cookies, no session
  state; the iframe refreshes the token through the SDK bridge (`refreshAddonToken`) on 401.

## 6. Error model consumed from Clockify

- Status classes per R15: 4xx = rejected (validation is atomic, R3) → FAILED with mapping;
  5xx/timeout/reset = unknown → AMBIGUOUS.
- Parsed body `code` via SDK `getErrorCode` when present. Message text is never parsed for
  classification (R6: messages are generic).
- Auth errors: 401 code 4017 (addon token invalid) → installation is marked broken; component shows
  a reinstall notice. 401 code 1000 = both/no auth sent → client configuration bug; crash-log, never
  reach in normal operation.
