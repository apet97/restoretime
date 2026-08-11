# IMPLEMENTER

You are maintaining **RestoreTime**, a Clockify Marketplace add-on that recreates deleted time
entries as new entries. The product is implemented. Treat the evidence baseline and architecture
decisions as constraints when you change it.

## Read first, in this order

1. `docs/00-product.md` — what the product is; the mandatory terminology.
2. `docs/01-evidence-baseline.md` — the fact inventory. Facts marked `PROVED*` are inputs, not
   hypotheses. Do not redesign them without new live evidence.
3. `evidence/webhook-validation.md` — why the architecture is webhook-only, and the custom-field
   conclusion.
4. `docs/06-recovery-domain.md` — the domain model and lifecycle state machine.
5. `docs/07-recreation-preflight.md` — the core algorithm, specified mechanically.
6. `docs/03-api-and-webhook-contract.md` + `docs/04-sdk-integration-map.md` — exact API and SDK
   surface to use.
7. `docs/05-architecture.md`, `docs/08-data-model.md`, `docs/09-permissions.md`.
8. `docs/10-ui-specification.md` … `docs/17-decisions.md` as your change requires.
9. `adr/` — the ten decisions. They are binding.
10. `implementation/ROADMAP.md` and `implementation/passes/` only when you need the history of the
    original implementation.

## Source SDKs (read-only)

| SDK | Path | Published version and source |
|---|---|---|
| addon platform | `/Users/15x/Downloads/WORKING/addons-me/addon-ts-sdk` | `@apet97/clockify-addon-sdk@1.3.0`; release source `64e668afd7bf330be4908c58d8671bdd27951608`; source docs HEAD `a753715623291952f5070f19bec946df78e78537` |
| Clockify REST | `/Users/15x/Downloads/WORKING/addons-me/clockify-ts-sdk` | `clockify-sdk-ts-115@5.1.0`; tag source `94fe318f473daa9eda7b3cfc038a51429c3dee14`; remote `main` matched the tag at the release audit |

Use them. Do not modify them, do not duplicate their behavior, do not work around a defect in the
app — report the defect as a blocker. One exception is already decided and must not stop you: the
app-owned `clockifyErrorCode` normalizer (AGENTS.md rule 5, docs/03 §6).

## Evidence citation convention

`docs/01-evidence-baseline.md` owns W/R/S facts. `evidence/webhook-validation.md` §3 owns L/E
probes. A bare **`fact N`** citation anywhere in this repo means row `N` of the Findings table in
`evidence/sdk-verification-2026-08-08.md`. Fresh-pass probes use **`FP-n`**
(`evidence/fresh-pass-2026-08-08.md`).

## Critical invariants

1. Recreation, never restoration. The new entry is a new entity (new ID, new timestamps, never
   part of any approval request or invoice, current rates — ADR-001, R9).
2. `TIME_ENTRY_DELETED` is the only deleted-entry source. No `/entities/*` feeds, no pre-delete
   snapshots (ADR-002).
3. Webhook ingestion = verify → normalize → one `INSERT OR IGNORE` → 204. No inbox table
   (ADR-003).
4. All creates use `timeEntries.createForUser` with the source owner (ADR-004). Custom fields are
   sent only via the `customFields` key per the P-CF rules (evidence R5); the response-shaped
   `customFieldValues` key is never sent. Only `REGULAR` entries are recreated (R17).
5. Every mutation comes from an ACTIVE, hash-pinned plan that passes revalidation moments before
   the create (ADR-006).
6. Never silently change a source value. Preserve, ask, warn, or block.
7. Never auto-retry a Clockify write. Unknown outcome → AMBIGUOUS protocol (ADR-007).
8. Duplicate prevention lives in database constraints + the atomic claim, never in UI state.
9. Authorization is server-side, from verified component claims only (ADR-008).
10. Escape every Clockify-controlled string before rendering. Tokens never leave the server.
11. Persist the normalized source only; no raw payloads; no sensitive data in logs (ADR-009).
12. No background workers (ADR-010). No new dependencies beyond `implementation/DEPENDENCIES.md`.
13. App routes are exact paths. The addon SDK router has no path parameters (fact 2): `/api/*` uses exact paths with `entryId` in the JSON body (POST) or query (GET); identity and workspace scope come from verified claims only.
14. `CLOCKIFY_PARENT_ORIGIN` (env var) is the Clockify app origin of the environment (production `https://app.clockify.me`, developer `https://developer.clockify.me`); it feeds CSP `frame-ancestors` and the iframe bridge `parentOrigin` (fact 12).

## Current development

Make one focused change at a time. Run the applicable commands below. Use the historical pass files
as evidence and rationale, not as unfinished implementation instructions.

## Commands

```bash
npm ci
npm run typecheck
npm run lint
npm run test          # unit + contract + integration (offline)
npm run test:e2e      # bundled UI product journeys
npm run build
npm run test:dev-smoke # env-gated developer-environment checks; not a release gate
npm run test:live     # env-gated current-candidate release evidence
```

## Git expectations

Use a focused branch and logical commits. Merge through a reviewed pull request with CI green.
Never commit secrets, tokens, or real workspace data. Use sanitized fixtures only.

## Definition of done

`docs/16-definition-of-done.md` separates historical evidence, current local gates, Marketplace
package completeness, and production proof. Do not reuse an older live run as proof for a changed
release candidate.

## If the evidence seems wrong

Run the smallest live probe that settles the question on the sacrificial workspace (credentials
come from the operator's environment, never the repo). Record the result in `evidence/`, update the
affected baseline row and design doc, and continue. Never silently design around a contradiction.
