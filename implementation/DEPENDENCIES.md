# Dependencies

Complete dependency policy. If it is not listed here, it is not installed.

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

## Explicitly rejected

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
