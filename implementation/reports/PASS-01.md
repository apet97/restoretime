# PASS-01 — Foundation and platform boundaries

Branch `pass-01-foundation`, branch point `ed28702`. Node 22.23.1.

## 1. How this pass was produced

Two implementers built PASS-01 independently from the identical brief, in isolated git worktrees.
Both delivered a complete pass with green gates. This report's author judged them, chose one, and
then merged the better parts of the other into it. The merged result is what the branch contains.

### Candidate comparison

| Criterion | Candidate A | Candidate B | Chosen |
|---|---|---|---|
| Webhook boundary | Bare 500 stub, no verification | `withClockifyVerifiedWebhookRequest` around a 500 stub | **B** |
| INSTALLED redelivery vs status | `ON CONFLICT … SET status='ACTIVE'` reverts an INACTIVE status | `status` excluded from the conflict update | **B** |
| `CLOCKIFY_PARENT_ORIGIN` validation | Hand-rolled `URL` origin check in `config.ts` | SDK `buildClockifySecurityHeaders` at boot | **B** |
| `src/ui` typecheck | Excluded from every project | Own DOM project (`tsconfig.ui.json`) | **B** |
| `npm run test` scope | `tests/unit` only | `tests/unit tests/contract tests/integration` (docs/13) | **B** |
| Main-module detection | String-concatenated `file://` path | `pathToFileURL(process.argv[1]).href` | **B** |
| `src/api/routes.ts` | Absent; `/api/ping` inline in `server.ts` | Present, matching docs/05 layout | **B** |
| `lint` | `tsconfig.lint.json` adds `noUnused*`/`noImplicitReturns` | Identical to `typecheck` (no added check) | **A** |
| `/healthz` | Probes the database | Static `{status:"ok"}` | **A** |
| Missing static bundle | Caught, actionable 500 | Uncaught read error | **A** |
| `/api/ping` response | `createClockifyJsonResponse` (SDK security headers) | Plain object | **A** |
| CI Node version | `node-version-file: .nvmrc` + npm cache | Hard-coded `"22"` | **A** |

Candidate B won on criterion 1 (correctness against the specification): candidate A carries a real
defect — a redelivered `INSTALLED` payload silently reverts a status that `STATUS_CHANGED` set —
and A omits the webhook verification whose exact call shape the pass file's "Important interfaces"
section specifies. B's tests are also sharper: one test exists purely to fail if
`requireExpiration: true` is ever dropped, and another exists purely to catch A's status-revert
bug. Every row marked **A** above was then grafted onto B.

### Author's own changes on top of the merge

- `vitest.config.ts` excludes `.claude/**` and `tools/**`. The npm scripts pass directory names as
  vitest *filename filters* (substring matches), so a checked-out worktree under `.claude/` was
  being collected: the first merged run reported 99 tests across 13 files, of which 64 tests in 8
  files belonged to the two discarded drafts. Without this exclusion the test gate does not measure
  this repository.
- `tsconfig.lint.ui.json` so the lint rules also cover the browser bundle project.
- A second `/healthz` test that closes the database and asserts 500, so the database probe has
  teeth rather than being an unasserted extra field.

## 2. Dependency decision and checksums

Both SDKs come from the npm registry (`implementation/DEPENDENCIES.md` §Registry note — closed).
Resolved versions and `package-lock.json` integrity hashes:

| Package | Version | Integrity |
|---|---|---|
| `@apet97/clockify-addon-sdk` | 1.2.0 | `sha512-V2OXR6dzKdTfBwOWaHV77gxh8rcKczQf4cyz/1oQQeuPG/8R0LcT8/pIKiMs+/avMsfY5aJptEF5fqHU6afuZg==` |
| `clockify-sdk-ts-115` | 2.0.0 | `sha512-kcE/vw7Gp27gDoWGZ6dztlO1e4FgEGbAwHhQXpAA3odemJCPqyIjlYnQ0+vQDiTiu+cvTjN+Qny4ULY4kV8mug==` |
| `better-sqlite3` | 11.10.0 | `sha512-EwhOpyXiOEL/lKzHz9AW1msWFNzGc/z+LzeB3/jnFJpxu+th2yqvzsSWas1v9jgs9+xiXJcD5A8CJxAG2TaghQ==` |
| `typescript` (dev) | 5.9.3 | `sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==` |
| `vitest` (dev) | 3.2.7 | `sha512-KrxIJ62Fd89gfysR4WotlgZABiz2dqFPgqGzX7s+CwsqLFomRH7777ZcrOD6+WVAh7khPQP41A+BKbpcJFrdEg==` |
| `esbuild` (dev) | 0.25.12 | `sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==` |

No package outside `implementation/DEPENDENCIES.md` was installed.

### Read-only SDK repositories

`git status --porcelain` at the end of the pass:

```
$ git -C ~/Downloads/WORKING/addons-me/addon-ts-sdk status --porcelain
$ git -C ~/Downloads/WORKING/addons-me/clockify-ts-sdk status --porcelain
```

Both empty. One observation worth recording: while this pass ran, a **separate** session on the
same host worked in `clockify-ts-sdk` (branch `harvest-sibling-repos`, commits `c9c3ca7` and
`30e0eab`, 04:30–04:43). No agent of this pass wrote to either repository. One of those commits
widens the local `getErrorCode` to accept numeric body codes, which would contradict the
AGENTS.md rule 5 carve-out if it were released. It is not: the **published**
`clockify-sdk-ts-115@2.0.0` that this repository installs still returns `undefined` for a numeric
body code. Verified directly against the installed package:

```
numeric code -> undefined
string code  -> "501"
no code      -> undefined
```

The app-owned `clockifyErrorCode` normalizer (PASS-02) therefore remains necessary and correct.

### Node version

`better-sqlite3@^11` ships no prebuild for Node 26 and its node-gyp fallback fails against the
Node 26 V8 headers. Node 22.23.1 resolves prebuilt `better-sqlite3@11.10.0`. `.nvmrc` pins `22`
and CI reads the version from that file, so local gates and CI cannot diverge. This is an
environment pin, not a dependency change.

## 3. File tree

```
.nvmrc                                  Node 22 pin
.github/workflows/ci.yml                typecheck/lint/test/build on the .nvmrc Node
package.json  package-lock.json
tsconfig.json                           server + tests (strict, noUncheckedIndexedAccess,
                                        exactOptionalPropertyTypes)
tsconfig.ui.json                        browser bundle project (DOM lib)
tsconfig.build.json                     emit to dist/
tsconfig.lint.json  tsconfig.lint.ui.json   lint = typecheck + noUnused*/noImplicitReturns
vitest.config.ts                        excludes .claude/** and tools/**
src/config.ts                           environment-only config
src/log.ts                              JSON-lines logger to stdout
src/manifest.ts                         manifest 1.5 + entity descriptors
src/server.ts                           composition root
src/api/routes.ts                       /api/* mount; /api/ping placeholder
src/api/views.ts                        escapeHtml + component shell
src/platform/installations.ts           ClockifyInstallationStore over SQLite; path normalization;
                                        AES-GCM key import
src/platform/verify.ts                  requireViewer (requireExpiration: true)
src/store/db.ts                         open + migrate (WAL, foreign_keys, user_version)
src/store/migrations/0001_init.sql      installations
src/store/cascade.ts                    uninstall cascade hook (no-op until PASS-02)
src/ui/app.ts                           bridge + status line, bundled by esbuild
tests/unit/{db-migrations,installations-store,normalize-webhook-path,require-viewer,server}.test.ts
tests/{contract,integration,dev-smoke,e2e,live}/.gitkeep   empty until their own passes
```

## 4. Tests

42 tests in 5 files. docs/13 defines no PASS-01 IDs (UT-*/CT-*/IT-* are all PASS-02+ engine rows),
so the test list is the pass file's own "Tests" section, plus one regression test per adversarial
finding that changed behavior (§7).

| Pass-file requirement | Test | Result |
|---|---|---|
| Valid component token on `/component` | `server.test.ts` "serves the shell for a valid, non-expired component token" | pass |
| Invalid component token on `/component` | "rejects an invalid token with 401" | pass |
| Expired component token on `/component` | "rejects an expired token with 401" | pass |
| Valid/absent token on `/api/ping` | `server.test.ts` ×2 | pass |
| `requireExpiration: true` is really passed | `require-viewer.test.ts` "rejects a token whose claims have no exp" | pass |
| `/api/*` rejects non-Bearer and missing headers | `require-viewer.test.ts` ×2 | pass |
| INSTALLED → store round-trip, token decrypts to the original | `server.test.ts` "persists an encrypted installation…" (also asserts the stored column is **not** the plaintext) | pass |
| DELETED removes the row and calls the cascade hook | `server.test.ts` | pass |
| STATUS_CHANGED flips status | `server.test.ts` | pass |
| Store guard: save skips an older context | `installations-store.test.ts` | pass |
| Store guard: equal `installedAt` still writes | `installations-store.test.ts` | pass |
| Store guard: delete with mismatched `installedAt` → `stale` | `installations-store.test.ts` | pass |
| Store guard: delete without `installedAt` is unconditional | `installations-store.test.ts` | pass |
| Store guard: delete of an absent row → `missing` | `installations-store.test.ts` | pass |
| Redelivered INSTALLED does not revert `status` | `installations-store.test.ts` | pass |
| Webhook token round-trips with the path normalized | `installations-store.test.ts` | pass |
| Webhook path normalization (`//x`, absolute URL, bare path) | `normalize-webhook-path.test.ts` ×4 | pass |
| Migration reaches `user_version=1` | `db-migrations.test.ts` | pass |
| Second boot is a no-op and keeps rows | `db-migrations.test.ts` | pass |
| Webhook stub returns 500 for a verified delivery | `server.test.ts` | pass |
| Webhook returns 401 on a wrong token / unknown installation | `server.test.ts` ×2 | pass |
| `/manifest` validates against the SDK validator | `server.test.ts` | pass |
| `/healthz` needs no auth; reports the database | `server.test.ts` ×2 | pass |

Regression tests added from the adversarial review:

| Finding | Test | Result |
|---|---|---|
| RT-P1-01 | `server.test.ts` "returns 401 for an unknown installation and says so in the log" — captures stdout and asserts the line exists | pass |
| RT-P1-08 | `server.test.ts` "STATUS_CHANGED for an installation this app does not hold" | pass |
| RT-P1-08 | `installations-store.test.ts` "updateInstallationStatus reports false when no installation matches" | pass |
| RT-P1-10a | `installations-store.test.ts` "distinguishes an absent webhooks key from an empty webhooks list" | pass |
| RT-P1-11 | `normalize-webhook-path.test.ts` trailing slash, root path, colon-in-relative-path, idempotence (×4) | pass |

## 5. Gate output

```
$ node -v
v22.23.1

$ npm ci
25 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities

$ npm run typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json

$ npm run lint
> tsc -p tsconfig.lint.json && tsc -p tsconfig.lint.ui.json

$ npm run test
> vitest run tests/unit tests/contract tests/integration

 ✓ tests/unit/normalize-webhook-path.test.ts (8 tests) 2ms
 ✓ tests/unit/db-migrations.test.ts (2 tests) 11ms
 ✓ tests/unit/installations-store.test.ts (12 tests) 12ms
 ✓ tests/unit/require-viewer.test.ts (5 tests) 257ms
 ✓ tests/unit/server.test.ts (15 tests) 831ms

 Test Files  5 passed (5)
      Tests  42 passed (42)

$ npm run build
> tsc -p tsconfig.build.json && mkdir -p dist/store/migrations dist/static && cp src/store/migrations/*.sql dist/store/migrations/ && esbuild src/ui/app.ts --bundle --outfile=dist/static/app.js --format=iife --target=es2020

  dist/static/app.js  3.7kb
```

### Boot smoke

```
$ PUBLIC_BASE_URL=https://example.invalid ADDON_KEY=restoretime \
  TOKEN_ENCRYPTION_KEY=<64 hex> DATABASE_PATH=:memory: \
  CLOCKIFY_PARENT_ORIGIN=https://app.clockify.me PORT=18795 npm start
{"time":"…","level":"info","msg":"listening","port":18795,"baseUrl":"https://example.invalid"}

GET /manifest        200   validateClockifyManifest -> {"ok":true}
GET /healthz         200   {"status":"ok","db":"ok"}
GET /icon.svg        200   image/svg+xml
GET /static/app.js   200   text/javascript; charset=utf-8   3771 bytes
GET /component       401   (unsigned)
GET /api/ping        401   (unsigned)
```

The served manifest carries `iconPath: /icon.svg`, one webhook
(`TIME_ENTRY_DELETED → /webhooks/time-entry-deleted`), one sidebar component
(`EVERYONE`, `/component`, with `iconPath`), three lifecycle entries, `FREE`, and the eight
declared scopes.

Port 8791 from the pass file was already bound by an unrelated process on this host; the smoke ran
on 18795. The port is not part of any contract.

## 6. Deviations from the pass file

| Deviation | Reason |
|---|---|
| The webhook route is wrapped in `withClockifyVerifiedWebhookRequest`; only its handler is the 500 stub | The pass file's "Important interfaces" section specifies this wrapper's exact call shape for PASS-01, and docs/12 boundary 1 makes verification mandatory. Real Clockify deliveries are signed, so they still receive 500 and are still redelivered — the stub behavior the pass file asks for is unchanged. Forged deliveries now get 401 instead of 500. |
| `lint` is a separate tsconfig project rather than the same command as `typecheck` | The pass file allows a tsc-based lint. A lint identical to typecheck adds no check and is a gate that passes for the wrong reason. |
| `/healthz` reports `{status, db}` rather than `{status}` | docs/14 asks for a health endpoint; a process whose database is unreadable is not healthy. |
| `src/ui` is a separate tsconfig project | It needs the DOM lib and no Node types; the server project needs the opposite. Both are typechecked. |
| `createServer` accepts a test-only `publicKey` option | Tests must verify against `generateTestKeys()` instead of Clockify's pinned platform key. One optional documented field; the production path never sets it. |
| `.claude/` added to `.gitignore` | The agent harness checks out worktrees there. They are never part of the product. |
| Boot smoke on port 18795 | 8791 was occupied on this host. |

## 7. Adversarial review

An independent reviewer read the branch diff, the SDK sources, and ran every gate. It reported
**no blocking findings** and eleven others. All eleven were fixed; none were rejected.

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| RT-P1-01 | high | The webhook options omitted `onError`, so the SDK's "no stored token" error went nowhere: a path-key mismatch would 401 every delivery in total silence until Clockify's retry budget ran out, losing deleted entries. | **Fixed.** `onError` added to the webhook options; confirmed against SDK source that `reportAddonError` is a no-op without a reporter and that the SDK redacts the request first. Regression test asserts the log line. |
| RT-P1-02 | med | `--passWithNoTests` on the release gate `test`, where its only reachable effect is turning "zero tests collected" into a green gate. | **Fixed.** Removed from `test`. It stays on `test:dev-smoke`, `test:e2e`, and `test:live` only because those directories are still empty; §8.1 carries the obligation forward. |
| RT-P1-03 | low | `normalizeWebhookPath`'s docstring claimed lookup never re-normalizes; `server.ts` does. | **Fixed.** The docstring now states the real invariant: the function is idempotent and both sides normalize, so a row written by an older build stays findable. |
| RT-P1-04 | low | Comments claimed the DELETED path "does not need rewiring later", contradicting docs/08's one-transaction requirement and this report's own §8.2. | **Fixed.** Both comments now say PASS-02 must restructure the handler into one transaction. |
| RT-P1-05 | low | The report was untracked, so the branch failed IMPLEMENTER.md's own completion criterion. | **Fixed.** Committed to the branch. |
| RT-P1-06 | low | `Number.parseInt("8080O")` → 8080 booted on a port the operator did not type. | **Fixed.** `PORT` must match `/^\d+$/`. Verified: `PORT=8080O` now fails at boot. |
| RT-P1-07 | low | Two migration files sharing a version number: the second is silently never applied. | **Fixed.** `migrate()` throws naming both files. Not unit-tested — testing it would need a migrations-directory seam that exists only for the test, and the guard is a boot-time developer check, not a product contract. |
| RT-P1-08 | low | `STATUS_CHANGED` for an unknown installation updated zero rows and logged success. | **Fixed.** `updateInstallationStatus` returns whether a row changed; the handler logs a warning instead of a false success and still acks 204 (Clockify has nothing to retry). |
| RT-P1-09 | low | `PING_PATH`, `COMPONENT_PATH`, `LIFECYCLE_PATHS`, `InstallationStatus`, `escapeHtml` exported with no consumer; `noUnusedLocals` cannot see exports. | **Fixed.** All five un-exported. `escapeHtml` is re-exported when PASS-02/03 gives it a second consumer and UT-X01. |
| RT-P1-10 | low | Two divergences from `InMemoryClockifyInstallationStore`: an empty `webhooks` array round-tripped as absent, and the raw store skips `assertInstallationContext`. | **Fixed (a), documented (b).** `webhooks_json` is now nullable, so "absent" and "empty" round-trip distinctly; migration 0001 was edited rather than superseded because it has never been applied anywhere (AGENTS.md rule 18 bars editing an *applied* migration). For (b) the raw store's docstring records that validation lives in the encryption wrapper, which is the only composition the app uses. |
| RT-P1-11 | low | `new URL("webhooks:x")` parsed a relative path as a scheme; trailing slashes were not stripped. Either would store a token under an unfindable key. | **Fixed.** The URL branch is gated on an `http(s)://` prefix and a trailing slash is dropped. Four regression tests, including idempotence. |

The reviewer separately confirmed as clean: `requireExpiration: true` genuinely reaching
`verifyClockifyToken`; identity and workspace scope coming only from claims; the vitest exclude
doing what its comment claims; both shell interpolations escaped and the CSP mechanism correct; no
token, webhook body, or description reachable in a log line; the generation guard matching the SDK
line for line; no banned terminology; and no dependency outside `DEPENDENCIES.md`.

## 8. Known limitations carried into later passes

1. `--passWithNoTests` remains on `test:dev-smoke`, `test:e2e`, and `test:live` because those
   directories are empty until their own passes fill them, so those runners exit 0 on an empty
   collection. **The pass that fills a directory must drop the flag for that runner**, and PASS-05
   must assert that LV-01…LV-10 actually ran — not merely that `npm run test:live` exited 0.
2. `src/store/cascade.ts` is a no-op with its call site wired and tested. PASS-02 fills the body
   **and restructures the DELETED handler**: it currently awaits the async encrypted store's
   `delete` and then calls the cascade synchronously, which better-sqlite3 cannot hold inside the
   single transaction docs/08 requires.
3. `/api/ping` is a placeholder and is removed in PASS-02 (noted in `src/api/routes.ts`).
4. `updateInstallationStatus` writes to the database directly rather than through the wrapped
   store, because `ClockifyInstallationContext` has no `status` field and the encryption wrapper
   re-exposes only `load`/`save`/`delete`.
5. The duplicate-migration-version guard (RT-P1-07) is not unit-tested; see its row in §7.

## 9. Commands a reviewer runs to verify

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # node -v must print v22.23.1
cd ~/Downloads/WORKING/addons-me/restoretime
git checkout pass-01-foundation
npm ci && npm run typecheck && npm run lint && npm run test && npm run build

PUBLIC_BASE_URL=https://example.invalid ADDON_KEY=restoretime \
TOKEN_ENCRYPTION_KEY=$(node -e "console.log('a1'.repeat(32))") \
DATABASE_PATH=:memory: CLOCKIFY_PARENT_ORIGIN=https://app.clockify.me PORT=18795 npm start &
curl -s http://127.0.0.1:18795/healthz
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18795/component   # 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18795/api/ping    # 401
curl -s http://127.0.0.1:18795/manifest | node -e "
  let b='';process.stdin.on('data',d=>b+=d).on('end',async()=>{
    const {validateClockifyManifest}=await import('@apet97/clockify-addon-sdk/clockify');
    console.log(validateClockifyManifest(JSON.parse(b)).ok);});"

git -C ../addon-ts-sdk status --porcelain      # must be empty
git -C ../clockify-ts-sdk status --porcelain   # must be empty
```
