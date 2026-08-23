# 09 — Permissions

## Identity

All identity comes from the verified component JWT (`verifyClockifyToken`), issued by Clockify when
the iframe loads. Claims used:

```text
user           viewer's Clockify user id
workspaceId    workspace the viewer is operating in
workspaceRole  "owner" | "admin" | member role
addonId        the installation the viewer opened the component from
```

`workspaceId` and `addonId` together are the `InstallationScope` (`domain/entry.ts`). Clockify
issues a fresh `addonId` for every install, so the pair identifies one installation lifetime while
`workspaceId` alone identifies only the tenant. Every product-data lookup is scoped by the pair: a
viewer from a later installation cannot read, act on, or deduplicate against rows an earlier one
captured.

No session cookies. Every `/api/*` call carries the token as a Bearer header and is verified
independently. Expired token → 401 → the iframe requests a fresh token through the SDK bridge
(`refreshAddonToken`) and retries once.

## Policy

Exactly one predicate module (`domain/policy.ts`), two rules:

```text
admin(viewer)   = isClockifyAdminRole(viewer.workspaceRole)     -- SDK predicate (owner|admin)
canRead(entry)  = admin(viewer) OR entry.ownerId == viewer.userId
canAct(entry)   = canRead(entry)
```

- Admin/owner: every recoverable entry in the workspace; all actions including bulk and dismiss.
- Regular user: only entries where `source.ownerId == viewer.userId`. List queries filter with
  `WHERE workspace_id=? AND owner_id=?`. Detail/preflight/recreate re-check the row's owner.
- No other elevated role exists. Clockify project-level managers get no extra rights in v1; there
  is no evidence for safe semantics, and the addon token operates at workspace level.
- Platform restrictions interact with roles (R16): owner/admins bypass force-timer and
  locked-period create restrictions on the user-scoped route; regular users do not. The UI turns
  this into a handoff: a regular user blocked by P-TIMER/P-LOCK-REG is told an admin can recreate
  the entry — and an admin opening the same entry sees it actionable.

## Enforcement points

All paths are exact (the SDK router has no path parameters; docs/03 §5). `entryId` arrives in the JSON body (POST) or query (GET); it is a resource selector, never identity. Every lookup is scoped `WHERE id = :entryId AND workspace_id = claims.workspaceId AND addon_id = claims.addonId`, then `canRead`/`canAct` applies.

## Credential authority

The Clockify add-on platform issues exactly one server credential per installation: the add-on
token from the `INSTALLED` payload, sent as `X-Addon-Token`. There is no user-token exchange in the
lifecycle contract, so **every** Clockify call this app makes carries installation-wide authority,
including calls made on behalf of a plain member.

Authenticating the viewer is therefore not enough. Anything the viewer *chooses* has to be checked
against that viewer's own Clockify access before the privileged credential acts on it:

- `GET /api/options?kind=projects` returns, for a non-admin, only projects that are `public` or
  list the viewer in `memberships`. Listing every project would disclose the names and ids of
  private projects the viewer is not on.
- `GET /api/options?kind=tasks` answers 404 — not 403 — for a project outside that set, so an
  inaccessible project is indistinguishable from one that does not exist.
- `POST /api/entries/preflight` rejects a non-admin's `choices.projectId` / `choices.taskId`
  outside that set with 403, before a plan is created and before any write.
- Tags are not restricted: Clockify tags are workspace-wide and carry no per-user access.

Deliberately **not** checked: the deleted entry's own original project. Recreating your own entry
into the project it was deleted from is what this product does, and Clockify already let that user
log time there. Only an explicit re-targeting choice is constrained.

Every recreation attempt writes one non-secret audit line — actor, source-entry owner, execution
mode (`SELF` or `ADMIN`), installation, plan, attempt — because the credential used is the same in
both modes and only the record distinguishes them.

| Boundary | Check |
|---|---|
| `GET /api/entries` | workspace from claims; non-admin queries add `owner_id = viewer`; filters are validated and never widen the workspace scope. `userId` and `userName` both name another person, so both are read only for an admin and silently ignored otherwise. Every viewer can use `dismissed` to find and undo their own dismissals. An inaccessible lineage reference is returned as `null` |
| `GET /api/entries/detail` | row lookup scoped by claims workspace + entry id from query; then `canRead` else 404 (no existence leak). Parent and child lineage rows and references pass the same `canRead` check |
| `POST /api/entries/preflight` | same scoping; then `canAct` |
| `POST /api/entries/recreate` | same; plus P-PERM re-evaluated inside preflight (defense in depth) |
| `POST /api/entries/reconcile` / `mark-not-created` / `resolve-ambiguous` / `dismiss` / `undismiss` | same scoping and `canAct` |
| `POST /api/entries/bulk-preflight`, `POST /api/entries/bulk-recreate` | `isClockifyAdminRole` required on the route itself (admin-only), plus per-entry `canAct` and P-PERM inside the engine. A regular user gets 403 before any per-entry data is computed |
| `GET /api/options` | workspace-scoped current projects/tasks/tags/custom fields; available to any verified viewer in the workspace (these are current workspace entities, not deleted data). `kind=users` is the exception — it enumerates people rather than workspace metadata, feeds the admin-only user filter, and returns 403 to a non-admin before any Clockify call |

## Rules that prevent the known attacks

- `workspaceId` is never read from path, query, or body. Forged cross-workspace IDs find no rows
  (404).
- Role changes between view and confirm are handled by per-call verification: a demoted admin's
  next call fails `canAct`. Plans carry `createdBy`; execution re-runs P-PERM with the confirmer's
  fresh claims.
- The webhook boundary is separate: SDK verification (JWT + per-installation token) and
  `workspaceId` match between claims and payload.
- The addon's Clockify calls use the installation token (server-side only). The token never leaves
  the server: the iframe only ever holds the short-lived component JWT.
