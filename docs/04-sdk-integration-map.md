# 04 — SDK integration map

Two read-only source SDKs. Pinned commits at planning time:

| SDK | Package | Version | Commit |
|---|---|---|---|
| `~/Downloads/working/addons-me/addon-ts-sdk` (`addon-sdk/` workspace) | `@apet97/clockify-addon-sdk` | 1.2.0 | `d86e45971a579a4fb2b12b9a85ed5b567322f7b7` |
| `~/Downloads/working/addons-me/clockify-ts-sdk` (`wrapper/` workspace) | `clockify-sdk-ts-115` | 2.0.0 | `b33e5b0227ece3de613adf6071039cc648bc35c8` (inspected); HEAD later advanced externally to `8cac46e9…` (docs-only commits; zero diff in the load-bearing paths, verified 2026-08-08) |

Node `>=22.13.0` for both. Rule: use the SDK for its responsibility; never duplicate it; never work
around a defect in the app — fix upstream first (AGENTS.md).

## Addon platform (`@apet97/clockify-addon-sdk`)

| Capability | Import subpath | Export/API | Source (addon-sdk/src) | Evidence |
|---|---|---|---|---|
| Manifest definition | `.` / `./clockify` | `ClockifyManifest.builder()` (schema 1.5 canonical), `ClockifyScope`, plan helpers | `clockify/clockify-manifest.ts`, `clockify/generated/v1_5.ts` | `tests/builders.test.ts`, parity tests |
| Manifest validation at boot | `./clockify` | `createValidatedClockifyAddon(manifest)` | `clockify/clockify-addon.ts` | `tests/manifest-validation.test.ts` |
| Webhook registration | `./clockify` | `addon.registerWebhook(webhook, handler)`; builder `onTimeEntryDeleted().path(...)` | `clockify/clockify-addon.ts`, `generated/v1_5.ts` | `tests/clockify-dispatch.test.ts` |
| Webhook verification | `./clockify` | `withClockifyVerifiedWebhookRequest(parser, {expectedEventType, getExpectedWebhookAuthToken}, handler)` | `clockify/clockify-request-handlers.ts`, `clockify-request-verifiers.ts` | `tests/request-verification.test.ts`, `tests/parity/mileage-webhook.test.ts` |
| JWT parser | `./clockify` | `createClockifySignatureParser(addonKey)` (pinned platform key) | `clockify/clockify-signature-parser.ts`, `clockify-public-key.ts` | `tests/signature.test.ts`, `tests/public-key.test.ts` |
| Component registration | `./clockify` | `registerComponent(component, handler)`; builder `.sidebar().allowEveryone().path(...).label(...)` | `clockify/clockify-addon.ts`, `generated/v1_5.ts` | `tests/clockify.test.ts` |
| Component verification (viewer identity) | `./clockify` | `withClockifyVerifiedComponentRequest` (query `?auth_token`, requires `exp`); claims: `user`, `workspaceId`, `workspaceRole`, `theme`, `language`, URLs | `clockify/clockify-request-handlers.ts` | `tests/request-verification.test.ts` |
| API-call token verification | `./clockify` | `verifyClockifyToken` | `clockify/clockify-request-verifiers.ts` | same |
| Role predicate | `./clockify` | `isClockifyAdminRole(role)` (owner/admin) | `clockify/clockify-request-wire.ts` | `snippets/secure-server/index.ts` |
| Lifecycle handlers | `./clockify` | `withClockifyInstalledLifecycleRequest`, `…StatusChanged`, `…Deleted`; payload guards; `clockifyLifecyclePayloadMatchesClaims` | `clockify/clockify-request-handlers.ts`, `clockify-lifecycle.ts` | `tests/lifecycle-helpers.test.ts` |
| Installation persistence contract | `./clockify` | `ClockifyInstallationStore` (`load/save/delete` + generation guard); `ClockifyInstallationContext` | `clockify/clockify-installation-store.ts` | `tests/installation-store.test.ts` |
| Token encryption at rest | `./clockify` | `wrapClockifyInstallationStoreWithEncryption(store, codec)`, `createClockifyAesGcmTokenCodec(key)` | `clockify/clockify-installation-store.ts` | same |
| Secure iframe responses | `./clockify` | `createClockifyHtmlResponse` (CSP, `frame-ancestors`), `createClockifyJsonResponse`, `buildClockifySecurityHeaders`, `resolveClockifyPublicOrigin` | `clockify/clockify-security.ts`, `clockify-public-origin.ts` | `tests/secure-server-example.test.ts` |
| HTTP server | `./adapters/node` | `createNodeHttpAddonServer(addon, {maxBodyBytes, onError})` | `adapters/node-http.ts` | `tests/adapters-node-server.test.ts` |
| Iframe bridge | `./ui` | `createClockifyBridge` (`navigate`, `showToast`, `refreshAddonToken`), `applyClockifyTheme`, `applyClockifyLanguage`, `formatClockifyDate` | `ui/index.ts` | `tests/ui.test.ts` |
| Error redaction hook | `.` | `AddonOptions.onError` + `redactAddonRequest` (strips tokens before reporting) | `shared/addon.ts` | `tests/router.test.ts` |

**Provided but not used in v1** (recorded so nobody adds them speculatively): `ClockifyAddonClient`
(addon settings exchange — no custom settings in v1), `ClockifyIdempotencyLeaseStore` /
`runClockifyIdempotentWebhook` (superseded by natural-key idempotent persistence, ADR-003), custom
settings builders, express/fetch adapters (node adapter chosen), `exchangeUserToken`.

**Not provided by the SDK, built by the app**: durable `ClockifyInstallationStore` over SQLite;
webhook payload guard (body is `unknown`); HTML escaping; role-enforcement wrapper (the SDK ships
the predicate only).

## Clockify REST (`clockify-sdk-ts-115`)

Client construction: `createClockifyClient({ addonToken: <installation authToken>, baseUrl })`.
Exactly-one-auth is enforced by the SDK (R11). `baseUrl` comes from the installation `apiUrl`
normalized by the addon SDK `resolveClockifyApiBaseUrl`.

| Product need | SDK method | Route | Request model | Response model | Notes |
|---|---|---|---|---|---|
| Recreate entry | `timeEntries.createForUser` | `POST /workspaces/{ws}/user/{uid}/time-entries` | `CreateForUserTimeEntriesRequest` | `TimeEntry` | Live-verified route (R1). App sends no `customFields` (R5) |
| Post-create fetch | `timeEntries.get` | `GET /workspaces/{ws}/time-entries/{id}` | — | `TimeEntry` | Verification diff input (F12) |
| Ambiguity reconcile | `timeEntries.listForUser` | `GET /workspaces/{ws}/user/{uid}/time-entries` | query `start`,`end`,`description` | `TimeEntry[]` | Baseline-delta matching (docs/07 §8) |
| Owner check | `users.list` | `GET /workspaces/{ws}/users` | query `status=ALL`, `memberships` | `UserDtoV1[]` | Membership status = workspace membership |
| Project check/options | `projects.get` / `projects.list` | `GET …/projects[/{id}]` | — | `Project` | 404 = gone; `archived` flag present |
| Task check/options | `tasks.get` / `tasks.list` | `GET …/projects/{pid}/tasks[/{id}]` | — | `Task` | `status` field |
| Tag check/options | `tags.list` | `GET /workspaces/{ws}/tags` | — | `Tag[]` | `archived` flag present |
| Custom-field definitions | `customFields.listForWorkspace` | `GET /workspaces/{ws}/custom-fields` | query `entity-type=TIMEENTRY` | `CustomField[]` | Type/allowedValues/required/status/default; `entityType` value is `TIMEENTRY` not `TIME_ENTRY` (DSWH2: wrong value → 501) |
| Workspace settings | `workspaces.get` | `GET /workspaces/{ws}` | — | `Workspace` (`workspaceSettings`) | `forceProjects`, `forceTasks`, `forceTags`, `forceDescription`, lock fields, billable permission (R12) |

**Transport behavior relied on**: reads retry 408/429/5xx (default 2 attempts, backoff,
`Retry-After` honored); POST/PATCH are never retried; errors are `ClockifyApiError` with
`statusCode` + parsed body; `getErrorCode(err)` extracts body `code` (wrapper `./errors`).

**Known SDK drift, not blocking**: `entityChangesExperimental.listDeleted` return type mismatches
live (wrapper object vs bare array); `listCreated`/`listUpdated` typed `string`. The product never
calls these (ADR-002). Record for upstream fix; do not consume.

**Known model inconsistency, handled in normalization**: `TimeEntriesTimeEntry.type` includes
`"TIME_OFF"`; `TimeEntry.type` uses `"TIMEOFF"`. The app normalizes webhook payloads itself and only
consumes `TimeEntry` from reads; the diff compares IDs and scalars, not the `type` enum beyond
`REGULAR` expectations (evidence: all captured entries were `REGULAR`).

**Blocking SDK defects**: none. Every required method exists with the live-verified route.
