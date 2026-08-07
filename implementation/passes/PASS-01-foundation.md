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

## Current expected state

Planning blueprint only: `docs/`, `adr/`, `implementation/`, `evidence/`, empty `src/` and
`tests/` with `.gitkeep`. No `package.json`.

## Scope

- `package.json` (Node `>=22.13.0`, type module), `tsconfig.json` (strict +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), npm scripts:
  `build`, `start`, `dev`, `test`, `typecheck`, `lint` (tsc-based lint is enough; add no linter
  package unless you justify it in the report).
- Dependency decision per `implementation/DEPENDENCIES.md` §Registry note: registry vs vendored
  tarballs. Record the decision + checksums in the final report.
- `src/server.ts` composition root; `src/manifest.ts`:
  - schema 1.5 builder; key from `ADDON_KEY`; `baseUrl` from `PUBLIC_BASE_URL`;
  - scopes: TIME_ENTRY READ/WRITE, PROJECT/TASK/TAG/USER/CUSTOM_FIELDS/WORKSPACE READ;
  - `minimalSubscriptionPlan`: FREE;
  - one webhook: `onTimeEntryDeleted().path("/webhooks/time-entry-deleted")` (handler is a 501
    stub that returns 500 so Clockify retries — ingestion does not exist yet);
  - one component: `sidebar().allowEveryone().path("/component").label("Time Entry Recovery")`;
  - lifecycle: installed `/lifecycle/installed`, deleted `/lifecycle/deleted`,
    status-changed `/lifecycle/status-changed`;
  - boot validation via `createValidatedClockifyAddon`.
- `src/store/db.ts` + `src/store/migrations/0001_init.sql`: SQLite WAL, `foreign_keys=ON`,
  `user_version` tracking. Migration 0001 creates `installations` exactly per docs/08.
- `src/platform/installations.ts`: `ClockifyInstallationStore` over SQLite, wrapped with
  `wrapClockifyInstallationStoreWithEncryption` + `createClockifyAesGcmTokenCodec`
  (`TOKEN_ENCRYPTION_KEY`). Unit-test the generation-guard semantics.
- Lifecycle handlers with the SDK `withClockify*LifecycleRequest` wrappers: INSTALLED persists the
  context incl. per-webhook tokens; STATUS_CHANGED updates `status`; DELETED deletes the
  installation row (domain tables arrive in PASS-02; write the cascade hook now as a no-op
  placeholder function with a test that it is called).
- `src/platform/verify.ts`: one signature-parser singleton; `withClockifyVerifiedComponentRequest`
  on the component route; an app-API middleware `requireViewer` built on `verifyClockifyToken`
  (401 on failure) that attaches `{userId, workspaceId, workspaceRole}` to the handler context.
- Component route: serve a minimal HTML shell via `createClockifyHtmlResponse` with
  `frame-ancestors` set to the Clockify app origin; the shell loads `/static/app.js` (esbuild
  bundle stub that mounts the SDK `createClockifyBridge` and renders "RestoreTime is installed.").
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

Use exactly the SDK surface from docs/04: `ClockifyManifest.builder()`,
`createValidatedClockifyAddon`, `registerWebhook/registerComponent/registerLifecycleEvent`,
`withClockifyInstalledLifecycleRequest` / `…StatusChanged` / `…Deleted`,
`withClockifyVerifiedComponentRequest`, `verifyClockifyToken`, `isClockifyAdminRole`,
`ClockifyInstallationStore`, `wrapClockifyInstallationStoreWithEncryption`,
`createClockifyAesGcmTokenCodec`, `createNodeHttpAddonServer`, `createClockifyHtmlResponse`,
`createClockifyBridge`. If any export is missing or behaves differently, stop and report — do not
shim.

## Safety invariants

- Tokens are encrypted at rest; the raw installation token never appears in logs or responses.
- The component route and `/api/*` reject unsigned/incorrectly-signed requests (401).
- `frame-ancestors` restricts embedding to the Clockify app origin.
- No secret in the repo; env-only config (docs/05 table).

## Tests (vitest)

- SDK `testing` subpath (`generateTestKeys`, `signTestToken`, request factories) for:
  valid/invalid/expired component token on `/component` and `/api/ping`; lifecycle INSTALLED →
  store round-trip (token decrypts to the original); DELETED removes the row; STATUS_CHANGED
  flips status; out-of-order DELETED with older `installedAt` returns `stale` and keeps the row.
- Migration test: fresh DB reaches `user_version=1`; boot is idempotent.
- Webhook stub returns 500 (so redelivery semantics hold once PASS-02 lands).

## Commands/gates

`npm ci && npm run typecheck && npm run lint && npm run test && npm run build` all green.
Boot smoke: `PUBLIC_BASE_URL=https://example.invalid ADDON_KEY=restoretime TOKEN_ENCRYPTION_KEY=<32B> DATABASE_PATH=:memory: PORT=8791 npm start` serves `/manifest` (validate its JSON against
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
