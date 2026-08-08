# Dependencies

Complete dependency policy. If it is not listed here, it is not installed.

The list is closed: it changes only by a recorded decision that names what the addition buys, what
was rejected instead, and which pass report carries the rationale. One such amendment exists so
far — `happy-dom`, at PASS-03.

## Runtime dependencies (3)

| Package | Version | Why |
|---|---|---|
| `@apet97/clockify-addon-sdk` | ^1.2.0 | Addon platform: manifest, verification, lifecycle, installation-store contract, encryption codec, node adapter, iframe bridge, secure responses. Source: `~/Downloads/working/addons-me/addon-ts-sdk` (read-only). |
| `clockify-sdk-ts-115` | ^2.0.0 | Clockify REST: `createForUser`, reads for preflight, error model, retry policy. Source: `~/Downloads/working/addons-me/clockify-ts-sdk` (read-only). |
| `better-sqlite3` | ^11 | Durable store. Synchronous prepared statements; no ORM. |

Transitive: `jose` (via the addon SDK). Never imported directly by app code.

## Development dependencies

| Package | Why |
|---|---|
| `typescript` | Language. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. |
| `vitest` | Unit/contract/integration runner (matches sibling projects). |
| `esbuild` | UI bundle (vanilla TS → one IIFE). |
| `@types/node`, `@types/better-sqlite3` | Types. |
| `happy-dom` | DOM environment for the PASS-03 E2E suite under vitest, scoped to `tests/e2e/` only (a per-file `// @vitest-environment happy-dom` docblock; every other suite stays on the node environment). The suite boots the real esbuild bundle and drives list → detail → resolution → confirm → success; the SDK bridge is built for an injected window (`createClockifyBridge({window, parentOrigin})`), so no real browser is needed to exercise it. Real-browser concerns — CSP, `frame-ancestors`, iframe embedding, a real console — stay where the blueprint already assigns them: LV-01 against a live deployment, plus PASS-04's XSS proof. Added by a recorded decision at PASS-03 (see `implementation/reports/PASS-03.md`); `jsdom` is the sanctioned substitute if happy-dom's spec fidelity ever falls short. |

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

Both SDK packages come from the **npm registry**. This is settled, not an open question:
`npm view` resolves `@apet97/clockify-addon-sdk@1.2.0` and `clockify-sdk-ts-115@2.0.0`, and
`tools/install-capture/` installed both from the registry and ran live against Clockify's
developer environment on 2026-08-08 (evidence/install-capture-2026-08-08.md). Vendored tarballs
are rejected: they add a manual refresh step for no proven benefit.

PASS-01 records, in its report: the resolved versions, the `integrity` hashes of both packages
from `package-lock.json`, and `git status --porcelain` output for both read-only SDK repos
(must be empty). It never edits the SDK repos.
