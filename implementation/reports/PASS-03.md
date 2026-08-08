# PASS-03 — User product

Branch `pass-03-product`, branch point `bb9fefa`. Node 22.23.1.

## 1. How this pass was produced

Two implementers built the product independently from the identical brief, in isolated worktrees.
Both delivered every view. This report's author judged them, merged the winner, grafted the other's
one decisive advantage, fixed a gap the winner self-disclosed, and adjudicated an adversarial
review.

### The decision taken before any code

`docs/13-testing.md` §E2E said "Browser: agent's choice of the repo-standard tool" while
`implementation/DEPENDENCIES.md` declared the list closed and named no browser tool. Rather than
let an implementer guess, the question went to a decision agent.

**Decision: one DOM-emulation devDependency (`happy-dom`) inside vitest, scoped to `tests/e2e/`.**
A real-browser runner is explicitly rejected and recorded as such: its only unique capabilities —
real CSP, real `frame-ancestors`, real iframe embedding, a real console — are already release-gated
by LV-01 against a live deployment and by PASS-04's XSS proof, so it would buy duplicate coverage
at the cost of a second runner and a CI browser download. `DEPENDENCIES.md` now also states how the
closed list may change at all: only by a recorded decision naming what the addition buys, what was
rejected instead, and which report carries the rationale. Both documents were amended **before** the
dependency was installed. No ADR was needed — the ten ADRs record domain and architecture
decisions, and AGENTS.md rule 15 points at `DEPENDENCIES.md` as the authority for tooling.

### Candidate comparison

| Criterion | Candidate A | Candidate B | Chosen |
|---|---|---|---|
| E2E coverage | 5 tests; the **Failed** result view untested at any level | 7 tests, including the Failed view | **B** |
| happy-dom integration | Used as a library (`new Window()`) to dodge a `db.ts` `file:` URL clash | Fixed the clash at its root — `import { URL as NodeURL } from "node:url"`, which is the more correct pattern in Node anyway — and used the standard vitest environment | **B** |
| Self-disclosure | Reported three post-hoc defects, none test-covered | Disclosed a real server-side gap (below) | **B** |
| Bug found by its own tests | — | Bulk-select button froze at "(0)"; its E2E test caught it | **B** |
| What the E2E suite runs | The **built** `dist/static/app.js` | `boot()` imported from source | **A** |
| Bundle | 48.4 KB | 51.4 KB | A (both far under the 100 KB gate) |

B won. A's one decisive advantage was grafted: esbuild is a second compiler with its own target and
resolution, so a bundle can fail where the source succeeds. A test now boots the real
`dist/static/app.js` in a happy-dom window and asserts it renders — and **CI runs `test:e2e` after
`build`**, because that test needs the artifact. CI did not run `test:e2e` at all before this pass.

### The gap the winner disclosed, and the fix

B reported that the disabled-installation notice was list-view only and that **the server did not
gate mutation routes on installation status** — so a viewer already on the detail or confirm screen
could still complete a recreation after the addon was disabled.

That is a real defect, not a presentation nit. docs/00 says "All permission checks run on the
server. The UI never decides what a user may see or do." A UI that hides the button while the
server still honours it has the rule in exactly the wrong place. Fixed with an `actionGuard`
applied to every route that writes to Clockify or changes a lifecycle state (recreate,
bulk-recreate, reconcile, mark-not-created, resolve-ambiguous, dismiss, undismiss); reads stay
available, which is what keeps lists readable per docs/10 §8. Pinned by an integration test that
disables the addon mid-flow and asserts 409 on the actions, 200 on list and detail, and the entry
still `IDLE`.

## 2. Views implemented

| docs/10 | View / state | Source | Covered by |
|---|---|---|---|
| §1 | List (regular user), row content, empty state | `ui/views/list.ts` | E2E flow |
| §2 | Admin filters, dismissed toggle, bulk selection (max 50) | `ui/views/list.ts` | E2E bulk flow |
| §3 | Detail: DELETED ENTRY vs NEW ENTRY columns, Differences, warnings | `ui/views/detail.ts` | E2E flow |
| §4 | Resolution widgets (project, task, tags, description, custom fields, running) | `ui/views/resolution-widgets.ts` | E2E project picker; `tests/e2e/views.test.ts` for the running widget |
| §5 | Confirm: planned values, fidelity badge, warnings | `ui/views/confirm.ts` | E2E flow + `views.test.ts` |
| §6 | Success / Failed / Unknown result / bounded not-found | `ui/views/result.ts` | E2E success, failed, unknown-result |
| §7 | Bulk review and results | `ui/views/bulk.ts` | E2E bulk flow |
| §8 | Escaping, token refresh, session expiry, disabled notice | `ui/dom.ts`, `ui/bridge.ts`, `ui/api.ts` | E2E escaping + 401-retry; integration test for the disabled state |

Two endpoints were added to the engine, admin-only with a 50-entry cap enforced server-side:
`POST /api/entries/bulk-preflight` and `POST /api/entries/bulk-recreate`. Each entry is claimed and
executed independently through the existing single-entry engine; there is no cross-entry
transaction.

### Escaping

Stronger than the pass file asked for. Instead of one string `esc()` helper, `src/ui/dom.ts` builds
every node with `createElement` + `textContent`; there is no `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, or `document.write` anywhere in `src/ui/`, and no dynamic `href`/`src`
attribute exists at all. A Clockify-controlled description, project name, tag name, user name, or
custom-field value can only ever become a text node or an attribute value, both inert. The
reviewer verified this independently.

### Token

In memory only, in a closure — never `localStorage`, `sessionStorage`, a cookie, the DOM, a
constructed URL, or a log line. The 401 path is exactly: dispatch a refresh, wait up to 5 s, retry
**once**, then the session-expired notice. A second 401 expires rather than looping.

## 3. Gate output

```
$ node -v
v22.23.1

$ npm run typecheck
> tsc -p tsconfig.json && tsc -p tsconfig.ui.json && tsc -p tsconfig.e2e.json

$ npm run lint
> tsc -p tsconfig.lint.json && tsc -p tsconfig.lint.ui.json && tsc -p tsconfig.lint.e2e.json

$ npm run test
 Test Files  23 passed (23)
      Tests  221 passed (221)

$ npm run build
  dist/static/app.js  51.8kb

$ npm run test:e2e
 ✓ tests/e2e/views.test.ts (5 tests)
 ✓ tests/e2e/component-flow.test.ts (8 tests)
 Test Files  2 passed (2)
      Tests  13 passed (13)

$ wc -c dist/static/app.js
   53040 dist/static/app.js          # gate: one self-contained bundle < 100 KB

$ git diff --check
(clean)

$ grep -rniE '\brestore(d|s)?\b|undelete|original entry' src/ui src/api/views.ts | grep -vi RestoreTime
(no matches)
```

## 4. Adversarial review

The reviewer read every UI and API file in the diff, verified the SDK bridge claims against source,
and ran the gates. **No blocking findings**; thirteen others. **All thirteen were fixed; none were
rejected.**

| ID | Sev | Finding | Disposition |
|---|---|---|---|
| F1 | high | The confirm view rendered raw Clockify ids and "2 tag(s)" instead of names, and omitted the owner — so the user authorized a mutation described by data they cannot read, at the exact point docs/10 §5 exists to catch a wrong pick. | **Fixed.** Confirm reuses the detail view's `projectCell`/`taskCell`/`tagsCell` and shows the owner. Regression asserts the raw id is absent and the replacement wording present. |
| F2 | high | Every action error in the unknown-result view was swallowed: the error callback re-rendered the same view from stale data. A throttled "Check now" (429), a rejected "It was not created" (409), and a rejected adoption all repainted identically with no message. | **Fixed.** All four call sites route through `renderApiError`, which answers docs/10 §8's three questions. |
| F3 | high | The running-timer radios rendered only while a `P-RUN` item was open — but `P-RUN` stops firing the moment `runningMode` is set, and no UI path unsets it. A user who mis-clicked "Set an end time" could never reach "Start a running timer" for that entry again. | **Fixed.** The radios are a property of a running *source*, not of the open item. Regression renders round two with only `P-RUN-END` present and asserts both radios still exist with the right one checked. |
| F4 | med | The UI computed the bounded not-found state itself (≥3 checks ∧ ≥10 min) on the **browser** clock, duplicating the server rule; a fast clock offered "It was not created" while the server refused. It also fabricated "in 10 minutes" for checks spread over hours. | **Fixed.** The detail response carries a server-computed `canMarkNotCreated`, and the server gate and the flag now share one predicate, so the button and the rule cannot disagree. The heading no longer invents a duration. |
| F5 | med | Detail, resolve and confirm had no disabled-installation handling; the failure surfaced only as a post-confirm 409. | **Fixed.** `DetailResponse` carries `disabled`; detail and confirm replace the form and the action with the notice while keeping the facts readable. |
| F6 | med | A list row replaced the description with "Project — Task" whenever a project existed, so two entries in the same project were indistinguishable — and the admin free-text filter searched text the rows did not show. | **Fixed.** The description is always its own line, per docs/10 §1's sample; project/task is secondary. |
| F7 | med | The bulk "Recreate N entries" label was computed once: unchecking a row left the count wrong, and clicking with nothing checked silently did nothing. | **Fixed.** Label and disabled state sync from the checkbox handlers. |
| F8 | low | The planned column reused the deleted-entry formatter, so a planned running timer read "(still running when deleted)" — a statement about the wrong entry. | **Fixed.** `formatEntryHeader` takes an explicit `"deleted" \| "planned"` sense. |
| F9 | low | The running widget's strings were the server's message and dropped the start time docs/10 §4 specifies. | **Fixed.** The label names the start time and the single-timer consequence is stated verbatim. |
| F10 | low | Custom-field selects used in-band sentinels (`__keep__`, `__drop__`) in the same value space as Clockify-controlled options. | **Fixed.** Option kind travels in a `data-kind` attribute, so an option literally named `__drop__` cannot impersonate an action. |
| F11 | low | Allowed values were inserted at a fixed index in a loop, rendering A,B,C as C,B,A. | **Fixed.** Appended in order before the fixed actions. |
| F12 | low | A bulk result row for a pruned plan carried no `entryId`, but "Open" was always wired to it → `detail?id=undefined`. | **Fixed.** The server sends `entryId: null` explicitly and the row omits the button when there is nothing to open. |
| F13 | low | `text()` in `dom.ts` was an unused export, and the refresh-waiter cleanup filtered for a closure that was never the pushed value, so timed-out waiters lingered. | **Fixed.** Export removed; the waiter removes itself and clears its own timer. |

The reviewer separately verified clean: no `innerHTML` anywhere in `src/ui/`; the server shell
escapes all five attribute interpolations including quotes; the token never reaches storage, a
cookie, a log, the DOM, or a constructed URL; the 401 path cannot loop; bulk is admin-checked
inside both handlers with the 50 cap enforced server-side and no cross-entry transaction;
terminology is clean; only `happy-dom` was added; and the bundle carries no `jose`.

## 5. Deviations from the pass file

| Deviation | Reason |
|---|---|
| Escaping is DOM-node construction, not one string `esc()` helper | Structurally stronger: no HTML string is ever built for interpolated content, so escaping cannot be forgotten at a call site. `escapeHtml` remains in `src/api/views.ts` for the one server-rendered HTML string. |
| `GET /api/entries` and `/api/entries/detail` gained `disabled`; detail also gained `canMarkNotCreated` | Both are server facts docs/00 forbids the UI from deriving. |
| `GET /api/options` gained `kind=customFields` | The P-CF-OPT widget needs the field's current `allowedValues`; docs/10 §4 specifies that select. |
| `ActionRequiredItem` gained `refId` | A widget must know which tag or custom field its item refers to. Additive. |
| Separate `tsconfig.e2e.json` / `tsconfig.lint.e2e.json` | `tests/e2e/` needs the DOM lib the server project must not have. |
| `node:url`'s `URL` imported explicitly in `server.ts`/`db.ts` | A DOM environment replaces `globalThis.URL`, which `fileURLToPath` then rejects. The explicit import is the more correct pattern in Node regardless, so it is production code, not a test shim. |
| CI now runs `npm run test:e2e`, after `build` | The pass file lists it as a gate and CI did not run it; the shipped-bundle test needs the built artifact. |

## 6. Known limitations, handed forward

1. **Resolution-widget E2E coverage is partial.** The project picker and the running widget are
   driven end to end; task, tags, description and the custom-field variants are covered by the
   PASS-02 engine tests plus typecheck, not by a UI test. The three high-severity findings above
   were all invisible to typecheck, lint, unit and integration tests, which is direct evidence this
   gap is where defects hide. **PASS-04** (XSS proof at E2E level is already in its scope; extend
   the same harness to the remaining widgets).
2. **Session-expired takeover and the bounded not-found view are not E2E-driven** — both need
   elapsed time, which conflicts with the suite's real-time polling. Their logic is covered at the
   unit/route level.
3. **`GET /api/entries` still does a project and task lookup per row** (carried from PASS-02).
   **PASS-04**, performance sanity.
4. **CI has no secret-scan gate** although docs/15 lists one. `gitleaks` is installed locally and
   the tree scans clean. **PASS-04**, ops wiring.
5. `bulk-preflight` always re-plans with `choices: {}`, discarding a prior per-entry resolution for
   an entry swept into a bulk selection. Safe — the entry re-enters as "needs input" and is
   excluded from the bulk action — but it means a resolved entry must be resolved again if it is
   bulk-reviewed.
