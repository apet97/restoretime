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
| Project deleted after entry deletion | Create with dead project → 400 (R3) | P-PROJ-GONE: replacement picker | Select project; or "No project" when allowed | UT-P02, IT-05 |
| Project archived | Create allowed, 201 (R6) | P-PROJ-ARCH warning; recreation proceeds | Warning text in Differences | UT-P03 |
| Task deleted or project substituted | 400 "Task doesn't belong to Project" (R3) | P-TASK-GONE / P-TASK-CTX | Task picker or remove | UT-P04 |
| Tag deleted | 400 "Tag doesn't belong to Workspace" (R3) | P-TAG-GONE per tag | Confirm removal; optional add-picker | UT-P05 |
| Tag archived | UNKNOWN on create | P-TAG-ARCH warning; create rejection maps to FAILED with explanation | Warning text | UT-P06, LV-06 |
| Owner left / membership inactive | Create-for-user for such a user: UNVERIFIED | P-OWNER blocker; no owner substitution offered | Blocked view with explanation | UT-P07 |
| Workspace requires project (`forceProjects`) | 501 without project; running entries bypass (R4) | P-PROJ-REQ | Project picker or running mode | UT-P08 |
| Workspace requires description | Not directly probed; settings readable (R12) | P-DESC | Text input | UT-P09 |
| `onlyAdminsCanChangeBillableStatus` | Regular user + `billable:true`: server behavior UNVERIFIED | P-BILL warning; post-create diff reports actual | Warning + success-view diff line | UT-P10, LV-07 |
| Locked period | NOT_TESTABLE live; setting formats unverified | P-LOCK warning only (never parses dates, never blocks); create rejection is the backstop (R15) | Warning text; failure view explains the unlock path | UT-P11, LV-08 |
| Description with `<`/`>` | Rejected at original create (W3) — cannot exist in a source | None needed; guard still accepts any stored text | — | CT-03 (fixture) |
| Emoji/Cyrillic/newline/tab descriptions | Byte-for-byte (W3) | Stored and resent exactly; escaped on render | Rendered as text | UT-N02, UT-X01 |
| Custom field with user-set value | Values not writable on create; current defaults attach (R5) | P-CF warning; fidelity PARTIAL | Differences line per field | UT-P12 |
| New required custom field added after deletion | NOT_TESTABLE; create may 400 | Create rejection → FAILED with mapped reason | Failure view explains | LV-08 |
| Duplicate recreation click (user + admin) | Creates have no dedup (R7) | Atomic claim; loser sees current state | Second clicker sees "Recreating…" | IT-03 |
| Ambiguous create, entry committed | No idempotency key (R7, R10) | AMBIGUOUS; baseline-delta reconcile adopts the single match | "Unknown result" → auto-resolved | IT-04 |
| Ambiguous create, nothing committed | Same | Bounded reconcile → user marks not created → IDLE | "It was not created" action | IT-04 |
| Ambiguous create, two identical candidates | Fingerprint collision is possible (R10) | Stay AMBIGUOUS; user picks; never auto-delete | Candidate list with links | UT-P13 |
| User creates a manual copy during ambiguity | Same fingerprint risk | Baseline excludes pre-existing entries; a manual copy inside the window yields ≥2 → user resolves | — | UT-P13 |
| Re-created entry deleted again | New webhook with the new id | New row; `parent_recoverable_id` links the chain | Lineage links on detail view | IT-06 |
| Admin demoted between view and confirm | Role in fresh claims | P-PERM on fresh claims fails | 403 → notice | IT-07 |
| Approval-enabled workspace | Payload approval fields: NOT_TESTABLE | Never claim approval restoration; new entry UNSUBMITTED (R9) | System difference line | — |
| Invoiced deleted entry | NOT_TESTABLE | Same; no invoice linkage on the new entry | System difference line | — |
| Addon token rejected (401 code 4017) | Distinct auth error (R11) | Mark installation broken; component shows reinstall notice | Notice view | IT-08 |
| Cross-workspace ID guessing | 404 on fake workspace (R15); rows scoped by claims workspace | 404, no existence leak | — | IT-09 |
| Webhook redelivery after dismissal | Genuine duplicates observed (W10) | DISMISSED row absorbs redelivery | Entry stays hidden | IT-10 |

Cases intentionally not handled in v1 (recorded, not silently dropped):

- Owner substitution (assign the new entry to a different user). No evidence for safe semantics.
- Recreation of `BREAK`/`TIME_OFF`/etc. entry types. All evidence is `REGULAR`; the guard stores
  `type` and preflight blocks non-`REGULAR` sources with an explanation if they ever arrive.
- Per-entry custom-field writes. Public API does not support them (R5).
