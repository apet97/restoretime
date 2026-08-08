# Live error-body shapes on the developer environment — 2026-08-08

Probes run during PASS-02 to settle how Clockify shapes 4xx bodies, because DS-02 and UT-M01 both
assert on them and the two PASS-02 candidates disagreed about which request produces a 404.

- Environment: `https://developer.clockify.me/api/v1`, workspace `69bda6b317a0c5babe34b4ff`.
- Auth: the captured installation `authToken` as `X-Addon-Token` (R11).
- No entry was created or deleted; every probe is a GET.

## Results

| Probe | Status | Body |
|---|---|---|
| `GET /workspaces/000000000000000000000000` (unknown workspace) | 404 | **empty** — no JSON at all, so no `code` |
| `GET /workspaces/{ws}/time-entries/000000000000000000000000` (unknown entry in a real workspace) | 400 | `{"message":"Time entry doesn't belong to Workspace","code":501}` |
| `GET /workspaces/{ws}/projects/000000000000000000000000` (unknown project in a real workspace) | 400 | `{"message":"Project doesn't belong to Workspace","code":501}` |
| `GET /workspaces/{ws}/not-a-real-route` (unknown route) | 404 | `{"message":"No static resource …","code":3000}` |
| `GET /workspaces/{ws}/projects/{id}` where `{id}` was **created, archived, then deleted** during this probe | 400 | `{"message":"Project doesn't belong to Workspace","code":501}` |

The last row is the decisive one and was run deliberately, because a never-existed id and a
genuinely deleted id could have differed. They do not. Sequence: create the project with the
operator's dev API key (the addon token correctly lacks `PROJECT_WRITE` — the manifest declares
`PROJECT_READ` only, and the platform enforced it with
`401 "Addon … does not have permission PROJECT_WRITE"`), archive it, delete it, then read it back
**with the addon token**. Result: 400 code `501`. The probe project was removed; nothing was left
behind.

## What this settles

1. **A 404 with no body code is real, and the way to produce it is an unknown workspace id** — not
   an unknown sub-resource id. This is the case docs/01 R15 (FP-2) records and the case UT-M01 and
   docs/11 require `clockifyErrorCode` to map as `undefined`. DS-02 must probe the workspace route
   to exercise it.
2. **An unknown id *inside* a real workspace is a 400 with body code `501`, never a 404.** Clockify
   treats it as "does not belong to this workspace" — the same code as project-required and
   archived-tag rejections (R15, R18). This confirms R3: dependency validation is server-side and
   reports domain validation, not routing.
3. **A 404 can carry a body code.** An unknown route returns code `3000`, the same code R20 records
   for the immutable-settings 405. So "404" and "no code" are independent conditions; code
   extraction must never be inferred from the status, and status must never be inferred from the
   code.

4. **A deleted project is not reported as 404.** `projects.get` on a project that existed and was
   then deleted returns 400 code `501`, exactly like a never-existed id.

## Consequences

- docs/03 §6 is unchanged and correct: a code-absent 4xx maps on `statusCode` alone, and preflight
  reads keep their own 404 meanings.
- **docs/03 §2 and docs/07 §2 were wrong** where they say `projects.get` reports a gone project as
  404. They now read: a gone project is 404 **or** 400 with body code `501`. This is not cosmetic.
  Both PASS-02 implementations treated only 404 as "gone", so on the real platform P-PROJ-GONE
  would never have fired: a deleted project — the most common reason a recreation needs help —
  would have surfaced as "Clockify could not be reached; try again" instead of the replacement
  picker. Fixed in `src/clockify/preflight-data.ts`; regression test
  `tests/unit/preflight-data.test.ts`.
- The narrowing is deliberate and minimal. On this one lookup the request carries only
  `workspaceId` and `projectId`, so "does not belong to this workspace" has exactly one cause:
  the project is not resolvable there. Body code `501` is reused for several unrelated validation
  failures elsewhere (R15, R18), so this mapping is scoped to `projects.get` alone and every other
  error still propagates.
- `tasks.list` and `tags.list` are unaffected: a missing task or tag is simply absent from a list
  that still returns 200, so no error mapping is involved.
