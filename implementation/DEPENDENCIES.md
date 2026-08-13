# Dependencies

Complete dependency policy. If it is not listed here, it is not installed.

The list is closed: it changes only by a recorded decision that names what the addition buys, what
was rejected instead, and which pass report carries the rationale. One such amendment exists so
far — `happy-dom`, at PASS-03.

## Runtime dependencies (3)

| Package | Version | Why |
|---|---|---|
| `@apet97/clockify-addon-sdk` | ^1.3.0 | Addon platform: manifest, verification, lifecycle, installation-store contract, encryption codec, webhook-path normalization, node adapter, iframe bridge, secure responses. Published from `64e668afd7bf330be4908c58d8671bdd27951608`; read-only source: `/Users/15x/Downloads/WORKING/addons-me/addon-ts-sdk`. |
| `clockify-sdk-ts-115` | ^5.1.0 | Clockify REST: `createForUser`, reads for preflight, error model, retry policy. The 5.1.0 tag source is `94fe318f473daa9eda7b3cfc038a51429c3dee14`; read-only source: `/Users/15x/Downloads/WORKING/addons-me/clockify-ts-sdk`. |
| `better-sqlite3` | ^11 | Durable store. Synchronous prepared statements; no ORM. |

Transitive: `jose` (via the addon SDK). Never imported directly by app code.

## Development dependencies

| Package | Why |
|---|---|
| `typescript` | Language. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. |
| `vitest` | Unit/contract/integration runner (matches sibling projects). |
| `esbuild` | UI bundle (vanilla TS → one IIFE). |
| `@types/node`, `@types/better-sqlite3` | Types. |
| `happy-dom` | DOM environment for the E2E suite under vitest, scoped to `tests/e2e/` only. Most tests boot the UI source modules; one test also boots the built esbuild bundle. The SDK bridge uses an injected window (`createClockifyBridge({window, parentOrigin})`). Real-browser concerns — CSP, `frame-ancestors`, authenticated iframe embedding, and sidebar rendering — require the LV-01B operator receipt. Added by a recorded decision at PASS-03 (see `implementation/reports/PASS-03.md`); `jsdom` is the sanctioned substitute if happy-dom's spec fidelity falls short. |

## Explicitly rejected

Playwright / any committed real-browser test runner (authenticated Clockify iframe evidence is
captured as the candidate-bound LV-01B operator receipt, so a second package and CI browser
download are not justified for the current release contract) ·
Express/Hono/Fastify (the SDK node adapter suffices) · ORM/query builders (four query modules) ·
zod/io-ts (hand-rolled guard, pinned by fixtures) · React/Vue/Svelte (vanilla TS suffices for four
views) · Redis (ADR-005) · any job queue (ADR-010) · any logging framework (JSON lines to stdout) ·
dotenv (process env only) · npm-run-all/concurrently (plain npm scripts).

## Registry note — decided

Both SDK packages come from the **npm registry**. The current lockfile resolves
`@apet97/clockify-addon-sdk@1.3.0` and `clockify-sdk-ts-115@5.1.0` and records their integrity
hashes. The add-on SDK package maps to release source
`64e668afd7bf330be4908c58d8671bdd27951608`; its source docs HEAD is
`a753715623291952f5070f19bec946df78e78537`. The Clockify SDK package maps to tag source
`94fe318f473daa9eda7b3cfc038a51429c3dee14`; the published tag and remote `main` matched this
commit at the release audit. These source references do not replace the lockfile
integrity values. Vendored tarballs remain rejected because they add a manual refresh step with no
proven benefit.
