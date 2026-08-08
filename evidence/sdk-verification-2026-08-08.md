# SDK source verification — 2026-08-08 (second adversarial pass)

Independent re-verification of every load-bearing SDK claim in the blueprint, against the
published packages and source of the two read-only SDK repos. Purpose: make the blueprint
mechanically implementable by a weaker implementation model.

## Method

- Verified exports/signatures against `addon-ts-sdk/addon-sdk/src/**` at the pinned commit
  `d86e45971a579a4fb2b12b9a85ed5b567322f7b7`, and against the installed npm package
  `@apet97/clockify-addon-sdk@1.2.0` (registry tarball; `npm view` resolved the same version).
- Verified routes/models against `clockify-ts-sdk/wrapper/src/**` and `wrapper/docs/**` at
  `b33e5b0227ece3de613adf6071039cc648bc35c8`.
- Cross-checked wiring patterns against the SDK snippets (`secure-server`, `expense-webhook`,
  `fetch-basic`) and the production sibling addons `ai-assistant-addon-marketplace-1.0.0` and
  `clockify-http-actions`.
- Independent advisor review requested via `openclaw agent` failed (provider auth broken:
  `openai isn't accepting your saved login`). The corrections below rest on direct source
  inspection only. The advisor request file was folded into this file's fact list.

## Findings (all verified; each is now folded into the affected docs)

| # | Finding | Where fixed |
|---|---|---|
| 1 | `ClockifyManifest.builder()` does not exist; the const object exposes `v1_5Builder()`/`v1_4Builder()`/`v1_6Builder()` (`clockify-manifest.ts`); same for `ClockifyComponent`/`ClockifyWebhook`/`ClockifyLifecycleEvent` | docs/04, PASS-01 |
| 2 | The router matches exact `method:path` only (`shared/addon.ts` `handle()`): no path params/wildcards; middleware runs only after an exact match; 404/405 synthesized | docs/03 §5, docs/04, docs/05, docs/09, PASS-02, IMPLEMENTER, AGENTS |
| 3 | `withClockifyVerifiedWebhookRequest(parser, options, handler)` — options second; lookup callback receives `{workspaceId, addonId, eventType}`, no path | docs/03 §1, docs/04, PASS-02 |
| 4 | `withClockifyVerifiedComponentRequest(parser, handler, options?)` — handler second (argument order differs from the webhook wrapper) | docs/04, PASS-01 |
| 5 | `verifyClockifyToken(parser, token, {requireExpiration: true})`; jose `jwtVerify` enforces `exp` in `parseClaims`; the app extracts the Bearer token itself | docs/03 §5, PASS-01 |
| 6 | `users.list` request type has REQUIRED `"include-roles"`; on the workspace-scoped route the user's `status` field carries membership status, typed `AccountStatus` in the SDK (drift; app compares `=== "ACTIVE"` only) | docs/03 note 1, docs/04, docs/07 §2, PASS-02 |
| 7 | `createClockifyClient` has no default timeout; exact outcome classes: `ClockifyApiTimeoutError`, `ClockifyApiError` with `statusCode === undefined` or `>= 500` → AMBIGUOUS; 4xx → FAILED; `getErrorCode` returns strings | docs/03 §3/§6, docs/04, docs/07 §8, PASS-02, docs/13 UT-M01 |
| 8 | The SDK webhook verifier never compares body vs claims `workspaceId`; the app must (400 on mismatch; store `claims.workspaceId`) | docs/03 §1, docs/12, PASS-02, TASK-02 |
| 9 | `installedAt` is a number set by the app (`{...payload, installedAt: Date.now()}`); DELETED payload has no generation → unconditional delete; store guard is store-level | docs/08, PASS-01, TASK-01 |
| 10 | Read retries: 408/429/500/502/503/504, GET/HEAD/OPTIONS, `maxRetries: 2` = 3 attempts total; POST/PATCH never retried (both retry layers) | docs/04 |
| 11 | A 201 create response is definitive; verification-read failure still means RECREATED with diff fallback to the 201 body | docs/03 §3, docs/07 §8–§9, docs/11, docs/13 IT-13, PASS-02, TASK-04 |
| 12 | New env `CLOCKIFY_PARENT_ORIGIN` (production `https://app.clockify.me`, developer `https://developer.clockify.me`): `frame-ancestors` + bridge `parentOrigin` | docs/05, docs/12, docs/10, PASS-01, AGENTS |
| 13 | Refreshed component token arrives as window message `{title: "refreshAddonToken", body: <token>}` (production sibling `clockify-http-actions` `sidebar.js`); 25-min proactive refresh, 5 s bounded wait on 401, retry once | docs/10 §8, PASS-03, TASK-05 |
| 14 | `TimeEntry` carries `approvalRequestId` (never live-populated) and loose `customFieldValues` — read defensively | docs/03 note 3, docs/07 §9 |
| 15 | Webhook ingestion is installation-status-independent | docs/03 §1, PASS-02, TASK-02 |
| 16 | Sidebar components need `iconPath` (production-sibling evidence: without it the nav entry does not render) | PASS-01, docs/13 LV-01 |
| 17 | Live install capture on the developer environment (see `install-capture-2026-08-08.md`): R11 addon-token success path and W11 addon-mode delivery are PROVED; INSTALLED webhook paths can carry `//webhooks/...` (W17) | docs/01 R11/W11/W17/S5, docs/13 LV-02/LV-04 |

## Verified-correct claims (no change)

- `createClockifySignatureParser(addonKey)` defaults to the pinned platform PEM; SHA-256
  fingerprint constant exported.
- `ClockifyInstallationStore` contract: `load`/`save`/`delete` returning
  `"deleted" | "missing" | "stale"`; `wrapClockifyInstallationStoreWithEncryption` +
  `createClockifyAesGcmTokenCodec`.
- `createNodeHttpAddonServer(addon, {maxBodyBytes, onError})`; default body cap 1 MiB; JSON body
  parse with `rawBody` retained; duplicate `content-length` → 400.
- `timeEntries.createForUser` is the only create method modeling `customFields`
  (`Record<string, unknown>[]` items, app-constructed per R5); `timeEntries.get`; `listForUser`
  supports `description` + `page`/`page-size`; `iterAll`/`iterPages` pagination helpers exported
  from the package root.
- `ClockifyLifecycleWebhookToken = {path, webhookType: "ADDON", authToken}`; INSTALLED payload
  shape `{addonId, authToken, workspaceId, asUser, apiUrl, addonUserId, webhooks?}`.
- Testing subpath exports: `generateTestKeys`, `signTestToken`, `createTestComponentRequest`,
  `createTestLifecycleRequest`, `createTestWebhookRequest`, `buildInstalledPayload`.
- Bridge: `createClockifyBridge({window, parentOrigin})` → `subscribe`, `refreshAddonToken`,
  `navigate("tracker")`, `showToast(type, message)`, `preview`, `dispose`.
- Workspace settings model carries `forceProjects/forceTasks/forceTags/forceDescription`,
  `onlyAdminsCanChangeBillableStatus`, `defaultBillableProjects`, `lockTimeEntries`,
  `automaticLock`, `timeTrackingMode` (typed).
- Registry: `@apet97/clockify-addon-sdk@1.2.0` and `clockify-sdk-ts-115@2.0.0` exist on npm at
  the pinned commits' content (resolved via `npm view`); PASS-01 should still record checksums
  of the installed tarballs.

## Independent-review status

The planned independent advisor pass (`openclaw agent`, DeepSeek) did not run: the gateway's
OpenAI provider auth failed (`openai isn't accepting your saved login`, 401 on token refresh).
Re-run when provider auth is restored. The harness code-review agent was not used; all claims
above were verified directly against source by the architect.
