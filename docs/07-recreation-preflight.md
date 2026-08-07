# 07 — Recreation preflight and mutation

The most important service in the product. This document specifies it mechanically. Implementation
must not invent behavior beyond this document and its evidence references.

## 1. Inputs

```text
source   DeletedTimeEntry (immutable, from recoverable_entries)
viewer   { userId, workspaceId, workspaceRole }  — verified component JWT claims only
choices  user substitutions from the UI (optional): { projectId?, taskId?, dropTagIds?,
         addTagIds?, description?, runningMode?: "running" | "completed", completedEnd? }
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
| P-OWNER | owner membership absent or not `ACTIVE` | blocker `OWNER_UNAVAILABLE` (name shown; admin sees membership status) |
| P-RUN | `source.wasRunning` and no `choices.runningMode` | ACTION_REQUIRED: choose "Recreate as running timer" or "Set an end time". The running choice must carry the warning: Clockify allows one running timer per user — starting this timer stops any timer the owner currently has running (W12 tie-break evidence) |
| P-RUN-END | `choices.runningMode="completed"` and (`completedEnd` missing or `completedEnd ≤ start`) | ACTION_REQUIRED: end must be after start (R2) |
| P-PROJ-REQ | effective projectId is null AND `forceProjects` AND mode is completed | ACTION_REQUIRED: select a project (running mode also resolves it, R4) |
| P-PROJ-GONE | source projectId set, lookup 404, no `choices.projectId` | ACTION_REQUIRED: select a replacement project (or "no project" if `!forceProjects`) |
| P-PROJ-SUB | `choices.projectId` set | validate it exists; substitute (fidelity → ADJUSTED) |
| P-PROJ-ARCH | effective project exists and `archived` | warning `ARCHIVED_PROJECT` — creation is allowed (R6) |
| P-TASK-GONE | source taskId set and (task missing on effective project, or `status ≠ ACTIVE`), no choice | ACTION_REQUIRED: select a replacement task or remove the task (removal invalid if `forceTasks`) |
| P-TASK-CTX | project substituted while source taskId set | source task cannot follow (R3); treat as P-TASK-GONE |
| P-TAG-GONE | a source tag id is absent from workspace tags, not in `dropTagIds` | ACTION_REQUIRED per tag: confirm removal (tags have no substitute picker; `addTagIds` multi-select is offered) |
| P-TAG-REQ | all source tags dropped AND `forceTags` AND `addTagIds` empty | ACTION_REQUIRED: select at least one current tag |
| P-TAG-ARCH | effective tag exists but `archived` | warning `ARCHIVED_TAG` (create behavior for archived tags is UNKNOWN; rejection maps to FAILED with explanation) |
| P-DESC | `forceDescription` AND effective description empty | ACTION_REQUIRED: user enters a description |
| P-CF | a source CF with non-null value: field gone/inactive, or current default ≠ source value | warning `CF_VALUE_DIFFERS` per field (name, original value, current default). Never blocks. Fidelity → PARTIAL contribution |
| P-BILL | `onlyAdminsCanChangeBillableStatus` AND viewer not admin AND `source.billable=true` | warning `BILLABLE_MAY_CHANGE` — server may force non-billable; post-create diff reports the actual result (R12) |
| P-LOCK | any lock setting present (`lockTimeEntries` non-null or `automaticLock` set) | warning `PERIOD_MAY_BE_LOCKED` — lock semantics are NOT_TESTABLE and the setting formats are not verified, so the rule never parses dates and never blocks. Text: "This workspace locks old time entries. If Clockify rejects the recreation, ask an admin to unlock the period." The create-rejection mapping is the enforcement backstop (R15) |
| P-SYS | always | informational system differences: new ID, new timestamps, `UNSUBMITTED`, no invoice link, current rates (R9) |

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
```

Anything not listed is never sent. `customFields` is never sent (R5).

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

**Baseline snapshot**: immediately before the create, `listForUser` the owner with
`start=source.start`, `end=source.end ?? now`. Store the matching entry IDs (fingerprint filter
below) as the attempt's baseline. Cost: one read. Purpose: the list has no created-at field (W14),
so "new" can only mean "not in the baseline" (advisor requirement).

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
delta = listForUser(owner, start, end) − baseline, fingerprint-filtered
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
| customFieldValues | never compared for pass/fail (R5) | informational note only |
| duration | never compared | recomputed by Clockify (W5) |

Diffs are stored on the attempt and shown on the success view ("Clockify applied these changes").
A `VALUE_DIFFERS` that was not warned about in the plan is still recorded and shown — the diff is a
report, not a gate; the entry exists and is linked.

## 10. Fidelity classification (deterministic, pure)

```text
IMPOSSIBLE  any blocker present
PARTIAL     no blockers; a source value cannot be represented:
            a non-default source custom-field value (P-CF), or a dropped value the user did not
            explicitly choose (cannot occur — drops require choice; kept for rule completeness)
ADJUSTED    no blockers; ≥1 explicit user substitution/drop/input that changes values (project,
            task, tags, description, or an end time set on a running source)
FULL        otherwise — including running→running recreation: the explicit running-mode choice
            preserves the source state and substitutes nothing
```

A custom field that became required after deletion cannot be detected at preflight (P-CF examines
source values, not new requirements); it surfaces as a create rejection → FAILED with the mapped
reason (docs/11).

System differences (new ID, timestamps, UNSUBMITTED, invoice, rates, CF auto-attach of matching
defaults) never downgrade fidelity. They are always listed on the confirm and success views.
