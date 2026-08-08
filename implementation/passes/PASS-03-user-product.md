# PASS-03 — User product

## Mission

Build the iframe product on top of the PASS-02 engine: regular-user list, admin list with filters
and bulk, detail/preflight view, resolution widgets, confirm, and every result state. After this
pass a user can complete the whole recovery flow inside Clockify.

## Repository

`~/Downloads/working/addons-me/restoretime` after PASS-02 merge.

## Authoritative reading order

1. `IMPLEMENTER.md`
2. `docs/10-ui-specification.md` — the contract for every view and string
3. `docs/00-product.md` (terminology), `docs/07-recreation-preflight.md` (what plans contain)
4. `docs/04-sdk-integration-map.md` — `./ui` bridge exports
5. `docs/12-security.md` — escaping and CSP
6. `docs/13-testing.md` — E2E expectations

## Current expected state

Engine merged; `/api/*` fully functional; component serves a stub shell; esbuild pipeline exists.

## Scope

- `src/ui/`: vanilla TS views — list, detail, confirm, result — rendered against `/api/*`. State
  comes from the server; the UI holds no business rules.
- Token handling: the shell reads `?auth_token`, stores it in memory only, sends it as a Bearer
  header on every `/api/*` call. Refresh: `bridge.subscribe("refreshAddonToken", body => ...)`
  receives the refreshed token as a window message whose body is the token string; the shell
  dispatches `bridge.refreshAddonToken()` every 25 minutes (tokens live 30 minutes); on 401 it
  dispatches a refresh, waits up to 5 seconds, retries the call once with the new token, and on
  timeout shows a session-expired notice (fact 13). Bridge options:
  `createClockifyBridge({window, parentOrigin})` with `parentOrigin` from `CLOCKIFY_PARENT_ORIGIN`.
- Bridge integration: `createClockifyBridge` for `navigate("tracker")` (success view) and
  `showToast`; `applyClockifyTheme` / `applyClockifyLanguage` / `formatClockifyDate` from claims
  delivered by the component route (embed the claims' display-safe fields — theme, language — in
  the shell page; never the token).
- List views per docs/10 §1–§2, including admin filters, dismissed toggle, and bulk selection
  (max 50).
- Detail view per §3: DELETED ENTRY vs NEW ENTRY columns, Differences section, warnings.
- Resolution widgets per §4, wired to `POST …/preflight` with `choices`.
- Confirm per §5; result views per §6 (success / failed / unknown result / bounded-not-found).
- Bulk flow per §7: `POST /api/entries/bulk-preflight {ids}` and `POST /api/entries/bulk-recreate
  {planIds}` — add these two endpoints to `src/api/routes.ts`; they loop the PASS-02 single-entry
  engine per id (each entry independent; per-entry outcomes returned). Admin-only.
- Escaping: a single `esc()` helper; every interpolated value passes through it or `textContent`.
- The disabled-installation notice (STATUS_CHANGED INACTIVE).

## Explicit out of scope

New engine behavior, new domain states, styling frameworks, component libraries, charts, settings
pages.

## Safety invariants

- No `innerHTML` with interpolated values; CSP stays `default-src 'none'` (the bundle is
  self-hosted; no inline scripts — the shell loads `/static/app.js` only).
- UI text matches docs/10 terminology exactly (recreate; never restore/undelete).
- Every failure view answers the three questions (docs/10 §8).

## Tests

- E2E (docs/13 §E2E): shell boot with SDK test-signed token → mocked engine → drive list → detail
  → resolution → confirm → success; plus unknown-result and blocked views.
- Unit: `esc()` against entity/markup payloads (UT-X01 extension).

## Commands/gates

`npm run typecheck && npm run lint && npm run test && npm run test:e2e && npm run build` green;
`/static/app.js` is one self-contained bundle < 100 KB.

## Git requirements

Branch `pass-03-product`; commits: api bulk endpoints / ui shell+list / detail+confirm / results /
bulk. PR, CI green, squash-merge.

## Completion criteria

A reviewer can click through every state in docs/10 against the mocked engine with zero console
errors; the terminology grep (`restore|undelete` outside quotes/allowlist) is clean.

## Final report format

`implementation/reports/PASS-03.md`: views implemented; test evidence; bundle size; deviations;
limitations.
