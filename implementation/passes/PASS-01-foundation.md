# PASS-01 — Foundation and platform boundaries

## Mission

Create a bootable addon skeleton with every Clockify platform boundary working end-to-end against
the addon SDK's test utilities: manifest, lifecycle (install/status/delete), encrypted installation
store on SQLite, verified component shell, verified app-API guard, and the CI/test harness. No
recovery behavior exists after this pass — the engine is PASS-02.

## Repository

`~/Downloads/working/addons-me/restoretime`. Read-only SDK sources:
`~/Downloads/working/addons-me/addon-ts-sdk`, `~/Downloads/working/addons-me/clockify-ts-sdk`
(never modify them).

## Authoritative reading order

1. `IMPLEMENTER.md` (repo root)
2. `docs/00-product.md`, `docs/01-evidence-baseline.md` (S-series especially)
3. `docs/04-sdk-integration-map.md` — exact exports to use
4. `docs/05-architecture.md` — module layout, config, invariants
5. `docs/08-data-model.md` — `installations` table only this pass
6. `docs/12-security.md`, `docs/13-testing.md`
7. `implementation/DEPENDENCIES.md` — the closed dependency list
8. `tools/install-capture/server.mjs` — **the proven wiring reference**. This dev tool installed
   live on the Clockify developer environment on 2026-08-08 (evidence/install-capture-2026-08-08.md).
   Copy its patterns, not its file layout. It shows, already working:
   the `ClockifyManifest.v1_5Builder()` / `ClockifyComponent.v1_5Builder()` /
   `ClockifyWebhook.v1_5Builder()` / `ClockifyLifecycleEvent.v1_5Builder()` chains that produced
   the final manifest; the build-without-entities-then-register pattern
   (`registerComponent` / `registerWebhook` / `registerLifecycleEvent`);
   the verifier argument orders (`withClockifyVerifiedWebhookRequest(parser, options, handler)`
   vs `withClockifyVerifiedComponentRequest(parser, handler)`);
   `wrapClockifyInstallationStoreWithEncryption` + `createClockifyAesGcmTokenCodec` over a durable
   backend (`tools/install-capture/store.mjs`); `createClockifyHtmlResponse` with
   `frameAncestors`; and `createNodeHttpAddonServer`. It is superseded by this pass and is never
   shipped.

## Current expected state

Planning blueprint only: `docs/`, `adr/`, `implementation/`, `evidence/`, empty `src/` and
`tests/` with `.gitkeep`. No `package.json`.

## Scope

- `package.json` (Node `>=22.13.0`, type module), `tsconfig.json` (strict +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), npm scripts:
  `build`, `start`, `dev`, `test`, `typecheck`, `lint` (tsc-based lint is enough; add no linter
  package unless you justify it in the report).
- Install both SDKs from the npm registry (`implementation/DEPENDENCIES.md` §Registry note — the
  decision is closed, do not re-open it). Record in the final report: resolved versions, both
  `integrity` hashes from `package-lock.json`, and `git status --porcelain` for each read-only SDK
  repo (must be empty).
- `src/server.ts` composition root; `src/manifest.ts`:
  - schema 1.5 via `ClockifyManifest.v1_5Builder()` (there is NO `builder()` — fact 1); key
    from `ADDON_KEY`; `baseUrl` from `PUBLIC_BASE_URL`; manifest `iconPath` `/icon.svg`
    (sidebar nav entry requires an icon — fact 16);
  - scopes: TIME_ENTRY READ/WRITE, PROJECT/TASK/TAG/USER/CUSTOM_FIELDS/WORKSPACE READ;
  - `minimalSubscriptionPlan`: FREE;
  - one webhook: `onTimeEntryDeleted().path("/webhooks/time-entry-deleted")` (handler is a
    stub that returns 500 so Clockify retries — ingestion does not exist yet);
  - one component: `sidebar().allowEveryone().path("/component").label("Time Entry
    Recovery").iconPath("/icon.svg")`;
  - lifecycle: installed `/lifecycle/installed`, deleted `/lifecycle/deleted`,
    status-changed `/lifecycle/status-changed`;
  - Manifest construction pattern: build the manifest with scalar fields + scopes only (no
    entities), then `addon.registerComponent(...)` / `addon.registerWebhook(...)` /
    `addon.registerLifecycleEvent(...)` — registration adds the entity to the served manifest
    (fact 2). Use `createValidatedClockifyAddon(manifest)` for boot validation.
  - boot validation via `createValidatedClockifyAddon`.
- `src/store/db.ts` + `src/store/migrations/0001_init.sql`: SQLite WAL, `foreign_keys=ON`,
  `user_version` tracking. Migration 0001 creates `installations` exactly per docs/08.
- `src/platform/installations.ts`: `ClockifyInstallationStore` over SQLite, wrapped with
  `wrapClockifyInstallationStoreWithEncryption` + `createClockifyAesGcmTokenCodec`
  (`TOKEN_ENCRYPTION_KEY`). Unit-test the generation-guard semantics.
- Lifecycle handlers with the SDK `withClockify*LifecycleRequest` wrappers: INSTALLED persists
  `{...payload, installedAt: Date.now()}` (fact 9) incl. per-webhook tokens; STATUS_CHANGED
  updates `status`; DELETED deletes unconditionally — `delete({workspaceId, addonId})` with NO
  `installedAt` (the payload carries no generation). The generation guard (save skips when
  current `installedAt` is newer; delete returns `stale` on mismatch) is unit-tested at the
  STORE level only, never via lifecycle payloads. Domain tables arrive in PASS-02; write the
  cascade hook now as a no-op placeholder function with a test that it is called.
- `src/platform/verify.ts`: one signature-parser singleton; `withClockifyVerifiedComponentRequest`
  on the component route; an app-API middleware `requireViewer` built on
  `verifyClockifyToken(parser, token, { requireExpiration: true })` (401 on failure) that attaches
  `{userId, workspaceId, workspaceRole}` to the handler context. The option is mandatory: the SDK
  default is `false`, and only the component-request verifier forces expiration.
- Component route: serve a minimal HTML shell via `createClockifyHtmlResponse` with
  `frame-ancestors` set to the Clockify app origin; the shell loads `/static/app.js` (esbuild
  bundle stub that mounts the SDK `createClockifyBridge` and renders "RestoreTime is installed.").
- Static routes: `GET /icon.svg` serves the inline SVG icon (content-type `image/svg+xml`);
  `GET /static/app.js` serves the esbuild bundle stub.
- Config/env: `CLOCKIFY_PARENT_ORIGIN` (Clockify app origin of the environment) feeds
  `createClockifyHtmlResponse(shell, {frameAncestors: [CLOCKIFY_PARENT_ORIGIN]})` and the
  bridge `parentOrigin` (fact 12).
- `GET /healthz` (no auth) per docs/14. Structured JSON logger module (stdout; level from
  `LOG_LEVEL`); wire the SDK `onError` redaction hook to it.
- `src/api/routes.ts`: mount point with `requireViewer`; one placeholder route
  `GET /api/ping` → `{ok:true, userId, workspaceId, workspaceRole}` (proves the guard end-to-end;
  removed in PASS-02, note that in code).
- CI: `.github/workflows/ci.yml` running ci/typecheck/lint/test/build on Node 22.

## Explicit out of scope

Webhook ingestion logic, domain tables beyond `installations`, preflight, recreation, any UI
beyond the shell, any Clockify REST call, rate limiting, error trackers.

## Important interfaces

Use exactly the SDK surface from docs/04: `ClockifyManifest.v1_5Builder()`,
`createValidatedClockifyAddon`, `registerWebhook/registerComponent/registerLifecycleEvent`,
`withClockifyInstalledLifecycleRequest` / `…StatusChanged` / `…Deleted`,
`withClockifyVerifiedComponentRequest`, `verifyClockifyToken`, `isClockifyAdminRole`,
`ClockifyInstallationStore`, `wrapClockifyInstallationStoreWithEncryption`,
`createClockifyAesGcmTokenCodec`, `createNodeHttpAddonServer`, `createClockifyHtmlResponse`,
`createClockifyBridge`. If any export is missing or behaves differently, stop and report — do not
shim.

Exact call shapes: `withClockifyVerifiedWebhookRequest(parser, {expectedEventType,
getExpectedWebhookAuthToken}, handler)` — options second, lookup receives
`{workspaceId, addonId, eventType}`; `withClockifyVerifiedComponentRequest(parser, handler)` —
handler second (fact 3, 4); `verifyClockifyToken(parser, token, {requireExpiration: true})` with
the token extracted from `Authorization: Bearer ...` (fact 5).

## Safety invariants

- Tokens are encrypted at rest; the raw installation token never appears in logs or responses.
- The component route and `/api/*` reject unsigned/incorrectly-signed requests (401).
- `frame-ancestors` restricts embedding to the Clockify app origin.
- No secret in the repo; env-only config (docs/05 table).

## Tests (vitest)

- SDK `testing` subpath (`generateTestKeys`, `signTestToken`, request factories) for:
  valid/invalid/expired component token on `/component` and `/api/ping`; lifecycle INSTALLED →
  store round-trip (token decrypts to the original); DELETED removes the row; STATUS_CHANGED
  flips status; store-level generation-guard tests: save skips an older context; delete with
  a mismatched `installedAt` returns `stale`; delete without `installedAt` is unconditional
  (fact 9).
- Migration test: fresh DB reaches `user_version=1`; boot is idempotent.
- Webhook stub returns 500 (so redelivery semantics hold once PASS-02 lands).

## Commands/gates

`npm ci && npm run typecheck && npm run lint && npm run test && npm run build` all green.
Boot smoke: `PUBLIC_BASE_URL=https://example.invalid ADDON_KEY=restoretime TOKEN_ENCRYPTION_KEY=<32B> DATABASE_PATH=:memory: CLOCKIFY_PARENT_ORIGIN=https://app.clockify.me PORT=8791 npm start` serves `/manifest` (validate its JSON against
the SDK's schema validator) and `/healthz`.

## Git requirements

One branch `pass-01-foundation`; commits logically separated (toolchain / db+store / platform
wiring / ci). PR to `main`, CI green, squash-merge.

## Completion criteria

Every gate green; a signed INSTALLED payload persists an encrypted installation; a signed component
request serves the shell; an unsigned one gets 401; `/manifest` validates; CI runs on the PR.

## Final report format

`implementation/reports/PASS-01.md`: dependency decision + checksums; file tree created; test list
with results; gate outputs; deviations from this prompt (each with reason); known limitations;
exact commands a reviewer runs to verify.
