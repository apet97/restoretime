# 06 — Recovery domain

Authoritative domain language. No synonyms; use these exact terms in code, UI, and docs.

## Concepts

### DeletedTimeEntry (source)

The normalized record of one deleted Clockify time entry, built once from the
`TIME_ENTRY_DELETED` payload at ingestion. Immutable after creation.

```ts
interface DeletedTimeEntry {
  workspaceId: string;
  entryId: string;            // webhook payload `id` — the deleted entry's Clockify ID
  ownerId: string;            // payload `userId` — owner, never the deleter (W13)
  ownerName: string;          // payload `user.name` — display only
  description: string;        // byte-for-byte (W3)
  billable: boolean;
  start: string;              // timeInterval.start, UTC ISO-8601, second precision
  end: string | null;         // null when the entry was running at deletion (W12)
  wasRunning: boolean;        // payload `currentlyRunning`
  type: string;               // payload `type` — "REGULAR"|"BREAK"|"HOLIDAY"|"TIME_OFF"; P-TYPE blocks non-REGULAR (R17)
  timeZone: string | null;    // display only (W5); null when the payload carries none
  projectId: string | null;
  projectName: string | null; // display only
  clientName: string | null;  // display only
  taskId: string | null;
  taskName: string | null;    // display only
  tags: { id: string; name: string }[];
  customFieldValues: { customFieldId: string; name: string; value: unknown }[]; // W7
}
```

Fields deliberately not stored: embedded rates (unused — rates are never recreated, R9), project
estimates/color/memberships, `kioskId`, approval fields (always null in evidence, W15), raw
payload. Rationale: data minimization (N3) and ADR-009. If a future requirement needs another
payload field, add it to the model and the guard; do not start storing the raw payload.

### RecoverableEntry (aggregate)

One row per deleted entry: the source plus the recovery lifecycle.

```text
id                    internal UUID
workspaceId + sourceEntryId     UNIQUE pair (duplicate prevention, F2/F11)
source                DeletedTimeEntry (JSON)
detectedAt            server receipt time (W14 — labelled "Detected" in UI)
lifecycleState        IDLE | RECREATING | RECREATED | FAILED | AMBIGUOUS | DISMISSED
claimToken/claimExpiresAt       mutation claim fencing
newEntryId            set on RECREATED; UNIQUE per workspace when present (adoption guard)
recreatedAt/recreatedBy
parentRecoverableId   lineage: set when this row's source entry was itself created by us for the
                      same owner
```

### RecreationPlan (immutable artifact)

The output of one preflight run. Stored; never mutated; superseded plans become STALE.

```text
id, recoverableEntryId, createdBy, createdAt
sourceHash            sha256 of the normalized source (tamper/staleness check)
resolution            per-dependency outcome (kept | substituted | dropped | missing)
plannedRequest        exact createForUser body to send
warnings[]            non-blocking differences (CF defaults, archived project, billable drift…)
blockers[]            conditions that make recreation impossible now
fidelity              FULL | ADJUSTED | PARTIAL | IMPOSSIBLE (docs/07 §9)
status                ACTIVE | STALE | CONSUMED
```

### RecreationAttempt (audit record)

One row per mutation attempt: plan id, started/finished time, outcome
(`SUCCESS | FAILED | AMBIGUOUS`), new entry id if known, error status/code, reconcile summary.

## Lifecycle state machine

Stored states are only about the mutation lifecycle. Preflight outcomes (ready, needs input,
blocked) are computed live and never persisted as state — they are functions of the source and the
current workspace, so persisting them would invite staleness.

```text
IDLE ──claim──► RECREATING ──201+verify──► RECREATED (terminal)
  ▲                │  ├─4xx──► FAILED ──claim(new plan)──► RECREATING
  │                │  └─5xx/timeout──► AMBIGUOUS ──adopt 1 match──► RECREATED
  │                │                      │  └─user "not created"──► IDLE
  │                ├─expired, no attempt + detail read──► IDLE
  │                ├─expired, no attempt + new claim──► RECREATING (new token)
  │                └─expired, attempt started──► AMBIGUOUS or its stored final state
  └── DISMISSED ◄──dismiss── IDLE/FAILED        DISMISSED ──undismiss──► IDLE
```

| State | Entry condition | User sees | Allowed exits |
|---|---|---|---|
| IDLE | Row inserted (webhook), or user marked an ambiguous attempt "not created", or undismiss | Entry in list; Recreate action | claim → RECREATING; dismiss → DISMISSED |
| RECREATING | Atomic claim won | "Recreating…" | verify → RECREATED; 4xx → FAILED; unknown or expired started attempt → AMBIGUOUS; a detail read returns an expired no-attempt claim to IDLE; a new claim replaces that expired token and stays RECREATING |
| FAILED | Create rejected (4xx, mapped reason) | Failure view: what happened, nothing was created, what to do next | new plan + claim → RECREATING; dismiss → DISMISSED |
| AMBIGUOUS | Create outcome unknown | "We do not know whether Clockify created this entry" + Check now | adopt → RECREATED; user confirms not created → IDLE |
| RECREATED | New entry verified | Success view: new entry, fidelity, differences | none (terminal) |
| DISMISSED | User dismissed | Hidden from default lists | undismiss → IDLE |

Rules:

- RECREATED rows ignore later webhooks for the same source id only in the sense that the source id
  is unique; a redelivery is an insert-ignore no-op (W10).
- DISMISSED is a real state, not a row delete, because a genuine duplicate delivery can arrive
  after dismissal (W10) and must not resurrect the entry.
- Claim predicate: `state IN ('IDLE','FAILED') OR (state='RECREATING' AND claimExpiresAt < now)`.
  AMBIGUOUS and RECREATED are never claimable. (Advisor: lease + fencing fix.)

## Lineage

When a webhook arrives for entry `X` and an existing row has `newEntryId = X`, the new row's
`parentRecoverableId` points at that row. Chains A→B→C stay explicit; identities never merge.
The detail view shows "Recreated from entry …" / "Recreated as entry …" links.
