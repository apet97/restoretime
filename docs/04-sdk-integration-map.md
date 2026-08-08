# 04 — SDK integration map

Two read-only source SDKs. Pinned commits at planning time:

| SDK | Package | Version | Commit |
|---|---|---|---|
| `~/Downloads/working/addons-me/addon-ts-sdk` (`addon-sdk/` workspace) | `@apet97/clockify-addon-sdk` | 1.2.0 | `d86e45971a579a4fb2b12b9a85ed5b567322f7b7` |
| `~/Downloads/working/addons-me/clockify-ts-sdk` (`wrapper/` workspace) | `clockify-sdk-ts-115` | 2.0.0 | `b33e5b0227ece3de613adf6071039cc648bc35c8` (inspected); HEAD later advanced externally to `8cac46e9…` then `f2d82d1…` (docs-only + one error-name JSON claim fix; zero diff in the load-bearing paths — the app never matches error names, only `statusCode` and its own `clockifyErrorCode` — verified 2026-08-08) |

Node `>=22.13.0` for both. Rule: use the SDK for its responsibility; never duplicate it; never work
around a defect in the app — fix upstream first (AGENTS.md).

## Addon platform (`@apet97/clockify-addon-sdk`)

| Capability | Import subpath | Export/API | Source (addon-sdk/src) | Evidence |
|---|---|---|---|---|
| Manifest definition | `.` / `./clockify` | `ClockifyManifest.v1_5Builder()` (canonical; the const object has `v1_5Builder`/`v1_4Builder`/`v1_6Builder` — there is no `builder()`), `ClockifyScope`, `ClockifyComponent.v1_5Builder()`, `ClockifyWebhook.v1_5Builder()`, `ClockifyLifecycleEvent.v1_5Builder()` | `clockify/clockify-manifest.ts`, `clockify/clockify-models.ts`, `clockify/generated/v1_5.ts` | `tests/builders.test.ts`, parity tests |
| Manifest validation at boot | `./clockify` | `createValidatedClockifyAddon(manifest)` | `clockify/clockify-addon.ts` | `tests/manifest-validation.test.ts` |
| Webhook registration | `./clockify` | `addon.registerWebhook(webhook, handler)`; builder `onTimeEntryDeleted().path(...)` | `clockify/clockify-addon.ts`, `generated/v1_5.ts` | `tests/clockify-dispatch.test.ts` |
| Webhook verification | `./clockify` | `withClockifyVerifiedWebhookRequest(parser, {expectedEventType, getExpectedWebhookAuthToken}, handler)` — note the options argument is SECOND; the lookup callback receives `{workspaceId, addonId, eventType}` (no path). Stored webhook tokens are keyed by normalized path; the app maps `eventType → path` through the single declared webhook constant and normalizes paths (live: INSTALLED payloads can carry `//webhooks/...` — evidence/install-capture-2026-08-08.md) | `clockify/clockify-request-handlers.ts`, `clockify-request-verifiers.ts` | `tests/request-verification.test.ts`, `tests/parity/mileage-webhook.test.ts` |
| JWT parser | `./clockify` | `createClockifySignatureParser(addonKey)` (pinned platform key) | `clockify/clockify-signature-parser.ts`, `clockify-public-key.ts` | `tests/signature.test.ts`, `tests/public-key.test.ts` |
| Component registration | `./clockify` | `registerComponent(component, handler)`; builder `.sidebar().allowEveryone().path(...).label(...)` | `clockify/clockify-addon.ts`, `generated/v1_5.ts` | `tests/clockify.test.ts` |
| Component verification (viewer identity) | `./clockify` | `withClockifyVerifiedComponentRequest(parser, handler, options?)` — handler is SECOND (differs from the webhook wrapper). Query `?auth_token`, requires `exp`; claims: `user`, `workspaceId`, `workspaceRole`, `theme`, `language`, URLs | `clockify/clockify-request-handlers.ts` | `tests/request-verification.test.ts` |
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
| Recreate entry | `timeEntries.createForUser` | `POST /workspaces/{ws}/user/{uid}/time-entries` | `CreateForUserTimeEntriesRequestFlattened` (the request type is a **union** with a `{body: …}` envelope — always build the flattened variant) | `TimeEntry` | Live-verified route (R1). `customFields` sent per P-CF rules (R5) — this is the only SDK create method that models the field |
| Post-create fetch | `timeEntries.get` | `GET /workspaces/{ws}/time-entries/{id}` | — | `TimeEntry` | Verification diff input (F12) |
| Ambiguity reconcile | `timeEntries.listForUser` | `GET /workspaces/{ws}/user/{uid}/time-entries` | query `description` (never `start`/`end` windows — proved laggy for fresh entries, R10) | `TimeEntry[]` | Baseline-delta matching (docs/07 §8) |
| Owner check | `users.list` | `GET /workspaces/{ws}/users` | `UserDtoV1[]` | Exact request: `{ workspaceId, status: "ALL", "include-roles": false, "page-size": 200 }` + `iterPages` pagination. `"include-roles"` is REQUIRED by the generated type. On this route the user's `status` field carries the workspace **membership** status (PENDING/ACTIVE/DECLINED/INACTIVE) while the SDK types it as account-level `AccountStatus` — known typing drift, recorded for upstream; the app only compares `status === "ACTIVE"` |
| Project check/options | `projects.get` / `projects.list` | `GET …/projects[/{id}]` | — | `Project` | gone = 404 **or** 400 body code `501` ("Project doesn't belong to Workspace") — live-probed on a genuinely deleted project, evidence/error-shapes-2026-08-08.md; `archived` flag present |
| Task check/options | `tasks.get` / `tasks.list` | `GET …/projects/{pid}/tasks[/{id}]` | — | `Task` | `status` field |
| Tag check/options | `tags.list` | `GET /workspaces/{ws}/tags` | — | `Tag[]` | `archived` flag present |
| Custom-field definitions | `customFields.listForWorkspace` | `GET /workspaces/{ws}/custom-fields` | request field `"entity-type": ["TIMEENTRY"]` (**array** of `CustomFieldEntityType`; wire form is repeated `entity-type=TIMEENTRY`) | `CustomField[]` | `type`, `allowedValues`, `required`, `status`, `workspaceDefaultValue` (**not** `defaultValue`). `status` is `"INACTIVE" \| "VISIBLE" \| "INVISIBLE"` — no `"ACTIVE"`; active means `status !== "INACTIVE"` (S6, L6). All properties optional. `entityType` value is `TIMEENTRY` not `TIME_ENTRY` (DSWH2: wrong value → 501). Addon-token reachable (R23) |
| Workspace settings | `workspaces.get` | `GET /workspaces/{ws}` | — | `Workspace` (`workspaceSettings`) | `forceProjects`, `forceTasks`, `forceTags`, `forceDescription`, lock fields, billable permission (R12). Addon-token reachable — live-probed, 69 settings keys (R23). The account-level `workspaces.list` is addon-token restricted and is never called |

**Transport behavior relied on**: reads retry 408/429/500/502/503/504 (GET/HEAD/OPTIONS only,
`maxRetries: 2` = up to 3 attempts, exponential backoff, `Retry-After`/`X-RateLimit-Reset`
honored); POST/PATCH are never retried by either retry layer (the composed-fetch layer rejects
POST in `retryableMethods` at construction). Errors are `ClockifyApiError` with `statusCode` +
parsed body; timeouts are `ClockifyApiTimeoutError` — which only fires when the app sets
`timeoutInSeconds` (the default is no timeout; the app passes `timeoutInSeconds: 30`).
`iterAll`/`iterPages` (package root, `wrapper/index.ts`) auto-paginate any list method
(`page`/`page-size`) with `{ pageSize, maxPages }` bounds. The app uses **`iterPages` only**: its
`{items, page, pageSize, hasNextPage}` envelope is the sole way to detect that the page bound was
hit, which the design requires (docs/03 note 5). `iterAll` yields items and cannot express it.

**Error-code extraction — do not use `getErrorCode`.** `getErrorCode(err)` returns the body `code`
only when it is a **string** (`errors.ts`: `typeof direct === "string"`). Clockify sends numbers.
Live-probed 2026-08-08: `400 → code 501` (number), `401 → code 4017` (number), `404 → no code` —
`getErrorCode` returned `undefined` in all three. The app owns a four-line normalizer
(`src/clockify/errors.ts` `clockifyErrorCode`, source in docs/03 §6) that reads `err.body.code`
(then `err.body.error.code`) and returns `String(code)`. This is not an SDK workaround
(AGENTS.md rule 5): the helper is correct for its documented string-code contract, and Clockify's
time-entry endpoints fall outside it.

**Upstream suggestion (non-blocking, do not wait on it)**: widen `getErrorCode` to accept numeric
body codes. Record it against `clockify-ts-sdk`; the app ships its own normalizer either way.

**Known SDK drift, not blocking**: `entityChangesExperimental.listDeleted` return type mismatches
live (wrapper object vs bare array); `listCreated`/`listUpdated` typed `string`. The product never
calls these (ADR-002). Record for upstream fix; do not consume.

**Known model inconsistency, handled in normalization**: `TimeEntriesTimeEntry.type` includes
`"TIME_OFF"`; `TimeEntry.type` uses `"TIMEOFF"`. The app normalizes webhook payloads itself and only
consumes `TimeEntry` from reads; the diff compares IDs and scalars, not the `type` enum beyond
`REGULAR` expectations (evidence: all captured entries were `REGULAR`).

**Blocking SDK defects**: none. Every required method exists with the live-verified route.

## Router constraint (read before designing routes)

The addon SDK router matches `${method}:${path}` **exactly** (`Addon.handle()` in
`shared/addon.ts`): no path parameters, no wildcards, no prefix matching. Middleware (`addon.use`)
runs only after an exact handler match; unknown paths get 404, wrong methods 405. Consequences:
all app routes are exact paths (docs/03 §5); `entryId` travels in the JSON body (POST) or query
(GET); handlers register via `addon.registerHandler(path, method, handler)`; `registerComponent` /
`registerWebhook` / `registerLifecycleEvent` register a handler AND add the descriptor to the
served manifest (identical redeclaration is a no-op — build the manifest without entities, then
register each entity with its verified wrapper).

## Testing subpath (`@apet97/clockify-addon-sdk/testing`)

Exports for harness code (PASS-01/PASS-03): `generateTestKeys()` (RS256 keypair),
`signTestToken(privateKey, addonKey, claims)`, `createTestComponentRequest(token, overrides)`,
`createTestLifecycleRequest(token, payload, overrides)`, `createTestWebhookRequest(token,
eventType, payload, overrides)`, `buildInstalledPayload(overrides)`.

## Environment coupling

`CLOCKIFY_PARENT_ORIGIN` (env var) must equal the Clockify app origin of the environment the
addon runs in: production `https://app.clockify.me`, developer environment
`https://developer.clockify.me` (verified 2026-08-08 install-capture). It feeds both
`createClockifyHtmlResponse({ frameAncestors: [...] })` and the iframe bridge `parentOrigin`.
The Clockify REST base comes from the installation's `apiUrl` via `resolveClockifyApiBaseUrl`
(live: `https://developer.clockify.me/api` → `https://developer.clockify.me/api/v1`).
