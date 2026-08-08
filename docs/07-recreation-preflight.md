# 07 — Recreation preflight and mutation

The most important service in the product. This document specifies it mechanically. Implementation
must not invent behavior beyond this document and its evidence references.

## 1. Inputs

```text
source   DeletedTimeEntry (immutable, from recoverable_entries)
viewer   { userId, workspaceId, workspaceRole }  — verified component JWT claims only
choices  user substitutions from the UI (optional): { projectId?, taskId?, dropTagIds?,
         addTagIds?, description?, runningMode?: "running" | "completed", completedEnd?,
         customFieldInputs?: {customFieldId, value}[], dropCustomFieldIds? }
```

## 2. Preflight data fetch

After authorization, fetch in parallel via the installation's client (docs/04):

1. `workspaces.get` → `workspaceSettings` (forceProjects/forceTasks/forceTags/forceDescription,
   onlyAdminsCanChangeBillableStatus where present, lock fields) (R12).
2. `users.list` (status=ALL, include memberships) → owner membership record.
3. `projects.get(source.projectId)` if set — 404 means gone.
4. `tasks.list(source.projectId)` if `source.taskId` set — or, when the project was substituted,
   `tasks.list(choices.projectId)`.
5. `tags.list` → current workspace tags.
6. `customFields.listForWorkspace(entity-type=TIMEENTRY)` → current definitions and defaults.

Lookups are reads: SDK retry policy applies (N7). A lookup that fails after retries fails the
preflight with "Clockify could not be reached; try again" — preflight never guesses.

## 3. Decision rules

Evaluate in order. Each rule has an ID used in tests and UI keys. `choices` from a previous
ACTION_REQUIRED round are validated here, never trusted.

| ID | Condition | Outcome |
|---|---|---|
| P-PERM | viewer is not admin AND `viewer.userId ≠ source.ownerId` | blocker `NOT_PERMITTED` (normally filtered before this point; defense in depth) |
| P-TYPE | `source.type ≠ "REGULAR"` | blocker `TYPE_NOT_SUPPORTED` — entry types are `REGULAR`/`BREAK`/`HOLIDAY`/`TIME_OFF`; only `REGULAR` is recreated (R17, operator directive) |
| P-OWNER | owner membership absent or not `ACTIVE` | blocker `OWNER_UNAVAILABLE` (name shown; admin sees membership status) |
| P-RUN | `source.wasRunning` and no `choices.runningMode` | ACTION_REQUIRED: choose "Recreate as running timer" or "Set an end time". The running choice must carry the warning: Clockify allows one running timer per user — starting this timer stops any timer the owner currently has running (W12 tie-break evidence) |
| P-RUN-END | `choices.runningMode="completed"` and (`completedEnd` missing or `completedEnd ≤ start`) | ACTION_REQUIRED: end must be after start (R2) |
| P-TIMER | `timeTrackingMode = "STOPWATCH_ONLY"` AND the plan sends an `end` (completed entry) AND viewer is not admin | blocker `TIMER_REQUIRED` — the workspace forbids manual entries for regular users (403 code 4030). Owner/admins bypass on route B (R16), so the message says: an admin can recreate this entry. Running-mode plans (no `end`) are unaffected. Admin viewers: rule does not apply |
| P-PROJ-REQ | effective projectId is null AND `forceProjects` AND mode is completed | ACTION_REQUIRED: select a project (running mode also resolves it, R4) |
| P-PROJ-GONE | source projectId set, lookup 404, no `choices.projectId` | ACTION_REQUIRED: select a replacement project (or "no project" if `!forceProjects`) |
| P-PROJ-SUB | `choices.projectId` set | validate it exists; substitute (fidelity → ADJUSTED) |
| P-PROJ-ARCH | effective project exists and `archived` | warning `ARCHIVED_PROJECT` — creation is allowed (R6) |
| P-TASK-GONE | source taskId set and (task missing on effective project, or `status ≠ ACTIVE`), no choice | ACTION_REQUIRED: select a replacement task or remove the task (removal invalid if `forceTasks`) |
| P-TASK-CTX | project substituted while source taskId set | source task cannot follow (R3); treat as P-TASK-GONE |
| P-TAG-GONE | a source tag id is absent from workspace tags, not in `dropTagIds` | ACTION_REQUIRED per tag: confirm removal (tags have no substitute picker; `addTagIds` multi-select is offered) |
| P-TAG-REQ | all source tags dropped AND `forceTags` AND `addTagIds` empty | ACTION_REQUIRED: select at least one current tag |
| P-TAG-ARCH | effective tag exists but `archived` | ACTION_REQUIRED: archived tags reject creation (400 code 501, R18) — confirm removal or pick a replacement, same as P-TAG-GONE |
| P-DESC | `forceDescription` AND effective description empty | ACTION_REQUIRED: user enters a description |
| P-CF-KEEP | source CF value non-null; field exists and is active; value equals the current default | send nothing — the value auto-attaches (R5). No warning |
| P-CF-WRITE | field exists and is active; value differs from the current default; value valid for the field type (dropdown: in `allowedValues`; NUMBER: numeric) | include `{customFieldId, sourceType:"WORKSPACE", value}` in `plannedRequest.customFields` (R5) |
| P-CF-OPT | dropdown value not in current `allowedValues`, no choice made | ACTION_REQUIRED with three choices: pick a current option (substitute → ADJUSTED), keep the original value (server accepts any string, R19 → warning `CF_OPTION_STALE`, value preserved), or drop the value (→ warning, PARTIAL) |
| P-CF-GONE | field missing or no longer active | warning `CF_FIELD_GONE`; the value is not sent; fidelity → PARTIAL |
| P-CF-REQ | a required CF has no usable value | ACTION_REQUIRED: the user enters a value (`customFieldInputs`). A value is mandatory at create (R22). Resolution order before asking: source value → current default → user input |
| P-BILL | (`onlyAdminsCanChangeBillableStatus` OR `defaultBillableProjects`) set AND viewer not admin AND source `billable` differs from what the workspace defaults imply | warning `BILLABLE_MAY_CHANGE` — silent override is PROVED (a regular user's `billable:false` was stored as `true`, R12); the post-create diff reports the actual stored value |
| P-LOCK | viewer is admin/owner | rule does not apply — admins are lock-exempt on route B (R16, PROVED) |
| P-LOCK-REG | viewer is regular AND any lock setting present (`lockTimeEntries` non-null or `automaticLock` set) AND `source.start` is 24 hours old or older | warning `PERIOD_MAY_BE_LOCKED` — finer lock-range semantics are not verified, so the rule never parses dates and never blocks; entries younger than 24 hours can never be locked (R22) and skip this rule. The rejection mapping is precise: 403 code 1003 → "The entry's date is in a locked period. An admin can recreate this entry, or unlock the period." (R15, R16) |
| P-SYS | always | informational system differences: new ID, new timestamps, never part of any approval request, no invoice link, current rates (R9) |

Owner substitution is not offered. Changing the owner changes the entry's meaning; no evidence
supports safe semantics. An unavailable owner is a blocker with an explanation, not a picker.

## 4. Effective request construction

```text
start        = source.start                        (never modified)
end          = source.end                          (stopped entries)
             | omitted                             (running mode, explicit choice)
             | choices.completedEnd                (completed mode for a running source)
description  = choices.description ?? source.description
billable     = source.billable
projectId    = choices.projectId ?? source.projectId
taskId       = choices.taskId ?? (project unchanged ? source.taskId : null)
tagIds       = (source.tags − dropTagIds + addTagIds) as IDs, deduped
customFields = per P-CF: source values that differ from current defaults (plus user inputs from
               P-CF-REQ/P-CF-OPT), as [{customFieldId, sourceType:"WORKSPACE", value}];
               the key is `customFields` — never `customFieldValues`; omitted when empty (R5)
```

Anything not listed is never sent.

## 5. Plan output

Build `RecreationPlan` (docs/06): resolution per dependency, `plannedRequest`, warnings, blockers,
fidelity, `sourceHash`. Persist as ACTIVE; mark previous ACTIVE plans for the entry STALE. Return
the plan to the UI.

- blockers non-empty → fidelity IMPOSSIBLE; the UI shows blockers, no confirm action.
- ACTION_REQUIRED outcomes → the UI renders the exact choices; re-preflight with `choices`.

## 6. Duplicate prevention and claiming

```sql
UPDATE recoverable_entries
SET lifecycle_state='RECREATING', claim_token=:token, claim_expires_at=:now_plus_60s
WHERE id=:id AND workspace_id=:ws
  AND (lifecycle_state IN ('IDLE','FAILED')
       OR (lifecycle_state='RECREATING' AND claim_expires_at < :now))
RETURNING *;
```

Zero rows returned → another attempt owns it or the state forbids it → respond with the current
state ("already recreating" / "already recreated"). The uniqueness pair
`UNIQUE(workspace_id, source_entry_id)` plus this atomic claim makes double recreation impossible,
including concurrent user+admin clicks (F11). Replica-safe: the database serializes the CAS
(advisor-confirmed). `claim_token` (UUID per attempt) fences all later writes of the attempt.

## 7. Revalidation (TOCTOU guard)

On confirm, before any Clockify call:

1. Verify plan status ACTIVE and `sourceHash` equals the current row's source hash.
2. Re-fetch the mutable set only: owner membership, effective project, effective task, effective
   tags, workspace settings, and the workspace custom fields.
3. Re-evaluate the rules that can change (P-OWNER, P-PROJ-*, P-TASK-*, P-TAG-*, P-LOCK, P-BILL,
   P-CF). Any different outcome → mark plan STALE, run a fresh preflight, return it. Never execute
   a plan whose assumptions changed (F10). (CF differences never gate execution, but a stale CF
   warning on the confirm view would be a lie — so CF drift also refreshes the plan.)

## 8. Mutation and outcome protocol

```text
claim (§6) → baseline snapshot → createForUser → branch:
```

**Baseline snapshot**: immediately before the create, list the owner's entries with the
**description filter** (`listForUser` with `description` = source description; fallback when the
description is empty: the unfiltered list, paginated). Record the matching entry IDs as the
attempt's baseline. Never use the `start`/`end`-windowed query: it is eventually consistent and
unreliable for fresh entries (R10 — a new entry stayed invisible >45 s in the windowed variant,
while description-filtered and unfiltered lists reflect creates immediately). Cost: one read.
Purpose: the list has no created-at field (R10), so "new" can only mean "not in the baseline".

**Fingerprint** for matching: `start` and `end` (epoch-second compare), `description`
(byte-exact), `billable`, `projectId`, `taskId`, `tagIds` (sorted compare). Only fields the list
model returns are used; the release live suite pins the list shape (docs/13).

Branches:

| Outcome | Transition | Behavior |
|---|---|---|
| 201 with body | RECREATING → (verify) | `timeEntries.get(newId)`; diff planned vs actual (§9); store attempt SUCCESS, new id, diffs; state RECREATED |
| 4xx | RECREATING → FAILED | Map reason via status + body `code` (R15); attempt FAILED with detail; state FAILED. Nothing was created — validation is atomic (R3) |
| 5xx, timeout, connection reset | RECREATING → AMBIGUOUS | Attempt AMBIGUOUS with baseline. Reconcile immediately once (below), then lazily |

**Reconcile (AMBIGUOUS)** — runs inline once, on each detail view while AMBIGUOUS (max once per
30 s), and on explicit "Check now". Bounded: a row whose latest reconcile is older than 10 minutes
and has had ≥3 checks shows the "not found" choice.

```text
delta = listForUser(owner, description=source.description) − baseline, fingerprint-filtered
        (same read as the baseline; unfiltered-list fallback for empty descriptions)
  0 matches → stay AMBIGUOUS ("not found yet"); after the bound, offer "Clockify shows no such
              entry — mark as not created" → user confirms → IDLE (retry needs a new plan)
  1 match   → adopt: UPDATE ... SET new_entry_id (guarded by UNIQUE(workspace_id,new_entry_id));
              on conflict leave AMBIGUOUS for user resolution (double-adoption guard);
              verify via get → RECREATED
  ≥2 matches → stay AMBIGUOUS; list candidates with Clockify links; user picks one (adopt path)
              or "none of these" (continue AMBIGUOUS). Never auto-delete candidates.
```

Never auto-retry the create. Never delete Clockify entries. The only automatic adoption is the
exactly-one-delta case. (Advisor: FAILED is unreachable from AMBIGUOUS without bounded re-polls
plus an explicit user decision; this protocol implements that.)

## 9. Post-create verification diff

Compare `plannedRequest` with the fetched new entry:

| Field | Compare | Mismatch class |
|---|---|---|
| start/end | epoch seconds | `VALUE_DIFFERS` |
| description | bytes | `VALUE_DIFFERS` |
| projectId/taskId | exact | `VALUE_DIFFERS` |
| tagIds | set-equal | `VALUE_DIFFERS` |
| billable | exact | `VALUE_DIFFERS` (expected when P-BILL warned; report, not alarm) |
| customFields (planned) | per-field value equality against the actual `customFieldValues` (numeric-tolerant: the API normalizes numeric strings to numbers, R5) | `VALUE_DIFFERS` |
| auto-attached CFs beyond the plan | not compared for pass/fail | informational (they reflect current workspace defaults) |
| duration | never compared | recomputed by Clockify (W5) |

Diffs are stored on the attempt and shown on the success view ("Clockify applied these changes").
A `VALUE_DIFFERS` that was not warned about in the plan is still recorded and shown — the diff is a
report, not a gate; the entry exists and is linked.

## 10. Fidelity classification (deterministic, pure)

```text
IMPOSSIBLE  any blocker present
PARTIAL     no blockers; a source value cannot be represented: a custom field whose field is gone
            or whose value the user chose to drop (P-CF-GONE / P-CF-OPT drop)
ADJUSTED    no blockers; ≥1 explicit user substitution/drop/input that changes values (project,
            task, tags, description, an end time set on a running source, a replacement or
            entered custom-field value)
FULL        otherwise — including running→running recreation: the explicit running-mode choice
            preserves the source state and substitutes nothing
```

Custom fields preserved through the write path (P-CF-KEEP/P-CF-WRITE) do not downgrade fidelity —
the value on the new entry equals the source value (R5).

System differences (new ID, timestamps, no approval-request membership, no invoice link, rates,
CF auto-attach of matching defaults) never downgrade fidelity. They are always listed on the
confirm and success views.
