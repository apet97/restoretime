# 03 — API and webhook contract

Everything the application relies on. Each item names the exact SDK method. Evidence references:
`docs/01-evidence-baseline.md`.

## 1. Inbound: `TIME_ENTRY_DELETED` webhook

- Declaration: manifest webhook via addon SDK builder `.onTimeEntryDeleted().path("/webhooks/time-entry-deleted")`.
- Verification: `withClockifyVerifiedWebhookRequest(parser, options, handler)` where
  `options = { expectedEventType: "TIME_ENTRY_DELETED", getExpectedWebhookAuthToken }`.
  The lookup receives `{ workspaceId, addonId, eventType }` — no path. The app maps
  `eventType "TIME_ENTRY_DELETED" → path "/webhooks/time-entry-deleted"` via the single declared
  webhook constant (v1 declares exactly one webhook), loads the installation, and returns the
  stored token whose `webhooks[].path` matches. The per-installation webhook token comes from the
  `INSTALLED` lifecycle payload (`webhooks[]`, stored keyed by webhook `path` — the SDK's
  `ClockifyLifecycleWebhookToken` is `{path, webhookType, authToken}`, with no event field).
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
- Workspace match (app-side, not SDK): the SDK verifies signature, event type, and the stored
  token, but never compares the body to the claims. The handler compares
  `body.workspaceId === claims.workspaceId`; a mismatch → 400 + structured log, no row. The row
  always stores `claims.workspaceId`, never the body's.
- Installation status: ingestion is status-independent. A webhook for an INACTIVE installation
  still persists (data is kept; the component shows a disabled notice, docs/10 §8).

## 2. Outbound reads (preflight and verification)

All through `clockify-sdk-ts-115` (`createClockifyClient({ addonToken })`, R11). The client retries
reads on 408/429/5xx with backoff by default; that behavior is kept (N7).

| Purpose | SDK method | Route |
|---|---|---|
| Workspace settings (forceProjects, locks, billable permission) | `workspaces.get` | `GET /workspaces/{ws}` |
| Owner existence/status | `users.list` with the exact request `{ workspaceId, status: "ALL", "include-roles": false, "page-size": 200 }` (see note 1) | `GET /workspaces/{ws}/users` |
| Project current state | `projects.get` (404 = gone) | `GET /workspaces/{ws}/projects/{id}` |
| Replacement project options | `projects.list` | `GET /workspaces/{ws}/projects` |
| Task current state + options | `tasks.list` / `tasks.get` | `GET /workspaces/{ws}/projects/{pid}/tasks[/{id}]` |
| Tag current state + options | `tags.list` | `GET /workspaces/{ws}/tags` |
| Custom-field definitions (type, defaults, status) | `customFields.listForWorkspace` (`entity-type=TIMEENTRY`) | `GET /workspaces/{ws}/custom-fields` |
| Post-create verification | `timeEntries.get` | `GET /workspaces/{ws}/time-entries/{id}` |
| Ambiguity reconciliation (baseline + delta) | `timeEntries.listForUser` (`start`, `end`, `description`) | `GET /workspaces/{ws}/user/{uid}/time-entries` |

Notes:

1. `users.list`: the generated request type marks `"include-roles": boolean` as **required** —
   always pass `false`. `"page-size": 200` is the API maximum; paginate with the SDK `iterAll`
   helper (`pageSize: 200, maxPages: 10`). On this workspace-scoped route the returned user's
   `status` field carries the **membership** status (values `PENDING`/`ACTIVE`/`DECLINED`/
   `INACTIVE`; live capture `agent-3/g0-users.json` shows `"ACTIVE"`, and the 2026-08-08
   install-capture probe returned `ACTIVE` for all ten dev-workspace users). The SDK types it
   `AccountStatus` (account-level) — recorded as typing drift in docs/04; the app only ever
   compares `status === "ACTIVE"`, so no workaround is needed. The `memberships` query param is
   not used: nothing consumes `memberships[]`.
2. There is no global time-entry list route; reconciliation is per-user, which matches the
   reconciliation design (the owner's list only).
3. The per-user list response model (`TimeEntry`) carries no `createdAt` (W14). Reconciliation uses
   baseline-delta, not a created-after filter (docs/07 §8). `TimeEntry` includes an
   `approvalRequestId` field that live items never carry (15-field item, R9) — the app never
   reads it. `customFieldValues` items are loosely typed (`Record<string, unknown>[]`); the app
   reads them defensively as `{ customFieldId: string, value: unknown }`.
4. `entityChangesExperimental.*` is never called (ADR-002). The SDK's `listDeleted` response type is
   also known-wrong vs live (wrapper vs bare array); irrelevant because the feed is banned.
5. Every list read that can exceed one page (`users.list`, `tags.list`, `projects.list`,
   `tasks.list`, `customFields.listForWorkspace`, reconcile/baseline `timeEntries.listForUser`)
   paginates via the SDK `iterAll` helper with `pageSize: 200` and a page bound (`maxPages: 10`);
   a read that hits the bound fails the preflight with "workspace too large to verify; try
   again" rather than guessing.

## 3. Outbound write (recreation)

- Method: `timeEntries.createForUser` → `POST /workspaces/{ws}/user/{userId}/time-entries` (R1).
- Client construction (docs/04): `createClockifyClient({ addonToken, baseUrl, timeoutInSeconds: 30 })`.
  The `timeoutInSeconds: 30` is mandatory: the SDK default has no timeout, and the AMBIGUOUS class
  depends on timeouts firing. A request that outlives the 60 s claim lease is a bug, not a case.
- Body sent: `{workspaceId, userId, start, end?, description?, billable?, projectId?, taskId?,
  tagIds?, customFields?}`.
  - `end` omitted only when the user explicitly chose "recreate as running timer" (W12, R2).
  - `customFields` is included only per the P-CF rules: source values that differ from current
    defaults, plus user-entered values, as `[{customFieldId, sourceType:"WORKSPACE", value}]`
    (R5). The response-shaped key `customFieldValues` is never sent — it is silently ignored.
  - `type` is never sent: the create default is `REGULAR` and only `REGULAR` sources are
    recreated (R17).
- Retry: never. The SDK never retries POST (matches N7).
- Outcome classification (exact; the caught value is always an SDK error):
  - `ClockifyApiTimeoutError` → AMBIGUOUS (docs/07 §8).
  - `ClockifyApiError` with `statusCode === undefined` (transport failure: DNS, reset, TLS) →
    AMBIGUOUS.
  - `ClockifyApiError` with `statusCode >= 500` → AMBIGUOUS.
  - `ClockifyApiError` with a 4xx `statusCode` → FAILED with a mapped reason (R15). The reason
    keys on the parsed body code via `getErrorCode(err)`, which returns a **string** — compare
    against string literals (`"4030"`, `"1003"`, `"501"`, `"4017"`, `"4005"`), never numbers.
  - Any other thrown value is a bug: crash-log it and treat the attempt as AMBIGUOUS (the create
    may have committed; never guess).
- Response: created entry. Verification still fetches it with `timeEntries.get` and diffs against
  the plan (F12); a 201 body alone is not the final check. If the verification read fails after
  SDK read-retries, the 201 still determines RECREATED — the diff falls back to the 201 body and
  records "verification read unavailable" (docs/07 §8–§9; the diff is a report, never a gate).

## 4. Lifecycle (inbound)

| Event | Path | Handling |
|---|---|---|
| `INSTALLED` | `/lifecycle/installed` | Verify (`withClockifyVerifiedLifecycleRequest` family), persist installation context encrypted (S3), including per-webhook tokens. |
| `STATUS_CHANGED` | `/lifecycle/status-changed` | Persist status. INACTIVE installations keep data; the component shows a disabled notice. |
| `DELETED` | `/lifecycle/deleted` | Verify, then hard-delete the installation and all workspace data (F17, docs/08). |
| `SETTINGS_UPDATED` | not declared | The addon declares no custom settings in v1. |

## 5. Component and app API (inbound)

- `GET /component` via `registerComponent` + `withClockifyVerifiedComponentRequest(parser, handler)`
  — note the argument order: the component wrapper takes `(parser, handler, options?)`, while the
  webhook wrapper takes `(parser, options, handler)`. Serves the iframe HTML shell with SDK
  security headers: `createClockifyHtmlResponse(shell, { frameAncestors: [CLOCKIFY_PARENT_ORIGIN] })`.
- `CLOCKIFY_PARENT_ORIGIN` is an environment variable (exact Clockify app origin; production
  `https://app.clockify.me`, developer environment `https://developer.clockify.me`). The same
  value feeds the iframe bridge's `parentOrigin` (docs/10).
- App API routes (`/api/*`) verify the same JWT per call: the app extracts the token from the
  `Authorization: Bearer <token>` header and calls
  `verifyClockifyToken(parser, token, { requireExpiration: true })` (the option matters: the SDK
  default is `false`, and only the component-request verifier forces it). No cookies, no session
  state; the iframe refreshes the token through the SDK bridge on 401 (docs/10 §8).
- **Route shape (SDK constraint)**: the addon SDK router matches `${method}:${path}` exactly. It
  has no path parameters, no wildcards, and middleware runs only after an exact match. Every
  `/api/*` route below is therefore an exact path; the entry id travels in the JSON body (POST)
  or query (GET). `entryId` is a resource selector, never identity — all identity and workspace
  scope come from the verified claims, and every row lookup is scoped
  `WHERE id = :entryId AND workspace_id = claims.workspaceId` before the owner check (docs/09).

| Method | Exact path | Request | Response |
|---|---|---|---|
| GET | `/api/entries` | query: `userId`, `projectId`, `from`, `to`, `status`, `search`, `dismissed` (admin filters; validated, never widen workspace scope) | `{ entries: EntrySummary[], }` |
| GET | `/api/entries/detail` | query: `id` (entry id) | full detail (source, state, latest plan, attempts, lineage) |
| POST | `/api/entries/preflight` | body: `{ entryId, choices? }` | plan or `{ actionRequired: [...] }` or `{ blockers: [...] }` |
| POST | `/api/entries/recreate` | body: `{ entryId, planId }` | attempt result (RECREATED/FAILED/AMBIGUOUS) |
| POST | `/api/entries/reconcile` | body: `{ entryId }` | reconcile summary (30 s throttle) |
| POST | `/api/entries/mark-not-created` | body: `{ entryId }` | requires AMBIGUOUS + bounded window (docs/07 §8) |
| POST | `/api/entries/resolve-ambiguous` | body: `{ entryId, newEntryId }` | adoption or 409 on unique-index conflict |
| POST | `/api/entries/dismiss` / `/api/entries/undismiss` | body: `{ entryId }` | 204 |
| POST | `/api/entries/bulk-preflight` | body: `{ entryIds }` (max 50) | per-entry preflight lines; admin-only route |
| POST | `/api/entries/bulk-recreate` | body: `{ planIds }` (max 50) | per-entry outcomes; admin-only route |
| GET | `/api/options` | query: `kind=projects\|tasks\|tags`, `projectId?` | current workspace entities for pickers |

- Static: `GET /static/app.js` (UI bundle), `GET /icon.svg` (manifest icon), `GET /healthz`
  (no auth, docs/14). All exact paths.
- Unknown `/api/*` paths → 404 (router default); wrong method on a known path → 405 with `Allow`.

## 6. Error model consumed from Clockify

- Status classes per R15: 4xx = rejected (validation is atomic, R3) → FAILED with mapping;
  5xx/timeout/transport = unknown → AMBIGUOUS. Exact classification: `ClockifyApiTimeoutError`;
  `ClockifyApiError` with `statusCode === undefined`; `ClockifyApiError` with `statusCode >= 500`.
- Parsed body `code` via SDK `getErrorCode` when present — it returns a **string**; compare
  against string literals (`"4030"`, `"1003"`, `"501"`, `"4017"`, `"4005"`, `"3000"`). Message
  text is never parsed for classification (R6: messages are generic).
- Auth errors: 401 code `"4017"` (addon token invalid) → installation is marked broken; component
  shows a reinstall notice. 401 code `"1000"` = both/no auth sent → client configuration bug;
  crash-log, never reach in normal operation.
- The Clockify client is constructed with `timeoutInSeconds: 30` (the SDK default has no timeout;
  the AMBIGUOUS protocol needs timeouts to fire).
