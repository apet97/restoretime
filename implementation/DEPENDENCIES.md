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
| `happy-dom` | DOM environment for the PASS-03 E2E suite under vitest, scoped to `tests/e2e/` only (a per-file `// @vitest-environment happy-dom` docblock; every other suite stays on the node environment). The suite boots the real esbuild bundle and drives list → detail → resolution → confirm → success; the SDK bridge is built for an injected window (`createClockifyBridge({window, parentOrigin})`), so no real browser is needed to exercise it. Real-browser concerns — CSP, `frame-ancestors`, iframe embedding, and a real console — stay in LV-01 against a live deployment and PASS-04's XSS proof. Added by a recorded decision at PASS-03 (see `implementation/reports/PASS-03.md`); `jsdom` is the sanctioned substitute if happy-dom's spec fidelity ever falls short. |

## Explicitly rejected

Playwright / any real-browser test runner (the only capabilities it adds over a DOM environment —
real CSP, real `frame-ancestors`, real iframe embedding, a real console — are release-gated by
LV-01 and covered by PASS-04's XSS proof, so it buys duplicate coverage at the cost of a second
test runner and a CI browser download) ·
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
