# IMPLEMENTER

You are implementing **RestoreTime**, a Clockify Marketplace add-on that recovers deleted time
entries by recreating them as new entries. The platform behavior is already validated by live
campaigns. Your job is to write the code and prove it — not to rediscover what to build.

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
8. `docs/10-ui-specification.md` … `docs/17-decisions.md` as your pass requires.
9. `adr/` — the ten decisions. They are binding.
10. `implementation/ROADMAP.md` then your pass file in `implementation/passes/`.

## Source SDKs (read-only)

| SDK | Path | Pinned commit |
|---|---|---|
| addon platform | `~/Downloads/working/addons-me/addon-ts-sdk` | `d86e45971a579a4fb2b12b9a85ed5b567322f7b7` |
| Clockify REST | `~/Downloads/working/addons-me/clockify-ts-sdk` | `b33e5b0227ece3de613adf6071039cc648bc35c8` |

Use them. Do not modify them, do not duplicate their behavior, do not work around a defect in the
app — report the defect as a blocker (none were known at planning time; docs/04).

## Critical invariants (violating one is a failed pass)

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

## Execute

```text
PASS-01 → PASS-02 → PASS-03 → PASS-04 → PASS-05
```

Each pass file is a complete prompt: scope, interfaces, invariants, tests, gates, report format.
A pass is done when its gates are green and its report exists in `implementation/reports/`.

## Commands

```bash
npm ci
npm run typecheck
npm run lint
npm run test          # unit + contract + integration (offline)
npm run test:e2e      # after PASS-03
npm run build
npm run test:live     # PASS-05 only; env-gated
```

## Git expectations

One branch per pass (`pass-NN-*`), logical commits, PR to `main`, CI green, squash-merge. Never
commit secrets, tokens, or real workspace data. Sanitized fixtures only (PASS-02 verifies).

## Definition of done

`docs/16-definition-of-done.md`. The release gate includes the live suite — it is the only way to
close the addon-token success-path question (docs/01 R11). Do not fake it.

## If the evidence seems wrong

Run the smallest live probe that settles the question on the sacrificial workspace (credentials
come from the operator's environment, never the repo). Record the result in `evidence/`, update the
affected baseline row and design doc, and continue. Never silently design around a contradiction.
