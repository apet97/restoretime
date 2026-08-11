# 11 — Edge cases

Every case from the evidence campaigns and the live addendum, mapped to product behavior.
Evidence IDs: `docs/01-evidence-baseline.md`. Test IDs refer to docs/13.

| Scenario | Observed platform behavior | Product behavior | UI behavior | Test |
|---|---|---|---|---|
| Duplicate webhook delivery | At-least-once; same body, new `idempotency-key` per attempt (W10) | Insert-if-absent; second delivery is a no-op, still 204 | — | IT-01 |
| Webhook for unknown installation | Token lookup finds nothing | SDK verifier rejects (401); no row created | — | IT-02 |
| Malformed webhook body | — | Guard rejects; 400 (invites retry only if Clockify sent it wrong — logged as contract violation) | — | UT-N01 |
| Running entry deleted | `currentlyRunning:true`, `end:null` (W12) | Source stores `wasRunning`; preflight asks for mode (P-RUN). Starting the new timer can auto-stop the owner's current timer (single-timer rule) — the choice carries that warning | Radio: running timer vs set end time, with the auto-stop warning | UT-P01 |
| Entry deleted right after create | Fires always (W9) | Normal ingestion | — | CT-01 (fixture) |
| Entry updated then deleted | Payload carries final state (W8) | No special handling; the final state is the source | — | CT-02 (fixture) |
| Project deleted after entry deletion | Create with dead project → 400 (R3). The preflight lookup `projects.get` also answers **400 body code `501`**, not 404, for a deleted project (live-probed 2026-08-08, evidence/error-shapes-2026-08-08.md) | P-PROJ-GONE: replacement picker | Select project; or "No project" when allowed | UT-P02, IT-05, tests/integration/project-gone.test.ts |
| Project archived | Create allowed, 201 (R6) | P-PROJ-ARCH warning; recreation proceeds | Warning text in Differences | UT-P03 |
| Task deleted or project substituted | 400 "Task doesn't belong to Project" (R3) | P-TASK-GONE / P-TASK-CTX | Task picker or remove | UT-P04 |
| Tag deleted | 400 "Tag doesn't belong to Workspace" (R3) | P-TAG-GONE per tag | Confirm removal; optional add-picker | UT-P05 |
| Tag archived | 400 code 501 "You can not create entities for archived tag" (R18) | P-TAG-ARCH: ACTION_REQUIRED, same resolution as a missing tag | Confirm removal or pick replacement | UT-P06 |
| Owner left / membership inactive | Create-for-user for such a user: UNVERIFIED, and it stays that way — P-OWNER blocks before any create, so the platform behavior is never exercised. Accepted risk, no LV row needed | P-OWNER blocker; no owner substitution offered | Blocked view with explanation | UT-P07 |
| Workspace requires project (`forceProjects`) | 501 without project; running entries bypass (R4) | P-PROJ-REQ | Project picker or running mode | UT-P08 |
| Workspace requires description | Not directly probed; settings readable (R12) | P-DESC | Text input | UT-P09 |
| `onlyAdminsCanChangeBillableStatus` / `defaultBillableProjects` | Regular user's `billable:false` silently stored as `true` (R12, probe A5) | P-BILL warning; post-create diff reports the stored value | Warning + success-view diff line | UT-P10, LV-07 |
| Locked period | 403 code 1003 for regular users; owner/admins exempt on both routes (R16) | P-LOCK skips admins; P-LOCK-REG warns regular users (never parses dates); 1003 maps to a precise reason with the admin handoff | Warning text; failure view: "An admin can recreate it, or unlock the period" | UT-P11 |
| Force timer (`STOPWATCH_ONLY`) | Entries with `end` rejected 403 code 4030: everyone on route A; regular users on route B; admins bypass on route B (R16) | P-TIMER blocks regular viewers of completed entries with the admin handoff; running-mode plans unaffected; admins proceed | Blocked view: "An admin can recreate this entry for you" | UT-P15 |
| Non-REGULAR entry type (break, holiday, time off) | All evidence entries were `REGULAR`; types enum is REGULAR/BREAK/HOLIDAY/TIME_OFF (R17) | P-TYPE blocker; no recreation attempt | Blocked view: "Only regular time entries can be recreated" | UT-P14 |
| Description with `<`/`>` | Rejected at original create (W3) — cannot exist in a source | None needed; guard still accepts any stored text | — | CT-03 (fixture) |
| Emoji/Cyrillic/newline/tab descriptions | Byte-for-byte (W3) | Stored and resent exactly; escaped on render | Rendered as text | UT-N02, UT-X01 |
| Custom field with user-set value | Values written at create via the `customFields` key (R5, E1/E2); defaults auto-attach for untouched fields | P-CF-KEEP/P-CF-WRITE: value preserved; the wrong key (`customFieldValues`) is never sent | No warning when preserved | UT-P16 |
| Custom field removed after deletion | Field absent from current definitions | P-CF-GONE: value not sent; fidelity PARTIAL | Differences line per field | UT-P12 |
| Custom-field option removed | Server accepts any string verbatim — no option validation (R19) | P-CF-OPT: keep-with-warning / replace / drop | Three-choice widget | UT-P16, LV-08 |
| New required custom field added after deletion | A value is mandatory at create when a CF is required (R22, operator-confirmed) | P-CF-REQ: source value → current default → user input, in that order | Typed input per field | UT-P16, LV-08 |
| Duplicate recreation click (user + admin) | Creates have no dedup (R7) | Atomic claim; loser sees current state | Second clicker sees "Recreating…" | IT-03 |
| Ambiguous create, entry committed | No idempotency key (R7, R10) | AMBIGUOUS; baseline-delta reconcile adopts the single match | "Unknown result" → auto-resolved | IT-04 |
| Ambiguous create, nothing committed | Same | Bounded reconcile → user marks not created → IDLE | "It was not created" action | IT-04 |
| Create committed (201) but verification read fails | The 201 response is definitive; only the follow-up `timeEntries.get` failed | RECREATED regardless; the diff falls back to the 201 body and records "verification read unavailable" (fact 11) | Success view with the note | IT-13 |
| Ambiguous create, two identical candidates | Fingerprint collision is possible (R10) | Stay AMBIGUOUS; user picks; never auto-delete | Candidate list with links | UT-P13 |
| User creates a manual copy during ambiguity | Same fingerprint risk | Baseline excludes pre-existing entries; a manual copy inside the window yields ≥2 → user resolves | — | UT-P13 |
| Re-created entry deleted again | New webhook with the new id | New row; `parent_recoverable_id` links the chain | Lineage links on detail view | IT-06 |
| Admin demoted between view and confirm | Role in fresh claims | P-PERM on fresh claims fails | 403 → notice | IT-07 |
| Approval-enabled workspace | Approved entries CANNOT be deleted (403 code 4005) until withdrawn (R9); entry DTOs expose no approval fields | Approval state can never be lost by deletion; the new entry is never part of an approval request | System difference line | UT-M01 (4005 mapping) |
| Invoiced deleted entry | Invoiced entries delete normally (204); webhook fires with no invoice marker; entry DTOs expose no invoice field (R21) | Recreation proceeds normally; the new entry is never invoice-linked | System difference line | None needed: invoice state is invisible on every payload and read model (R21), so no code branches on it. The unconditional difference line is covered by the UI terminology check (PASS-03) |
| Addon token rejected (401 code 4017) | Distinct auth error (R11); the body code arrives as the **number** `4017` | `clockifyErrorCode` normalizes to `"4017"`; mark installation broken; component shows reinstall notice | Notice view | IT-08, UT-M01 |
| Clockify 4xx with no body `code` | Live: 404 unknown workspace returns `{message}` only (R15, FP-2) | Map on `statusCode` alone; never guess a code | Failure view with the status-only reason | UT-M01 |
| Workspace larger than the page bound | `PaginatedList.collect()` returns `truncated: true` (docs/03 note 5) | Preflight fails with "workspace too large to verify; try again"; an AMBIGUOUS reconcile stays AMBIGUOUS and reports the bound | Failure view; "Check now" stays available | IT-14 |
| Cross-workspace ID guessing | 404 on fake workspace (R15); rows scoped by claims workspace | 404, no existence leak | — | IT-09 |
| Webhook redelivery after dismissal | Genuine duplicates observed (W10) | DISMISSED row absorbs redelivery | Entry stays hidden | IT-10 |

Cases intentionally not handled in v1 (recorded, not silently dropped):

- Owner substitution (assign the new entry to a different user). No evidence for safe semantics.
- Non-`REGULAR` types are handled as a hard blocker (P-TYPE), not as a recreation path — no UI or
  request construction exists for `BREAK`/`HOLIDAY`/`TIME_OFF` (operator directive, R17).
- Editing custom-field values on an existing entry is possible via full-body PUT with the
  `customFields` key (E3) but the product never updates entries — recreation only ever creates.
