# 09 — Permissions

## Identity

All identity comes from the verified component JWT (`verifyClockifyToken`), issued by Clockify when
the iframe loads. Claims used:

```text
user           viewer's Clockify user id
workspaceId    workspace the viewer is operating in
workspaceRole  "owner" | "admin" | member role
```

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

## Enforcement points

| Boundary | Check |
|---|---|
| `GET /api/entries` | workspace from claims; non-admin queries add `owner_id = viewer`; admin filters (`userId`, project, date, status, search) are validated but never widen the workspace scope |
| `GET /api/entries/{id}` | row lookup scoped `WHERE id=? AND workspace_id=?`; then `canRead` else 404 (no existence leak) |
| `POST /api/entries/{id}/preflight` | same scoping; then `canAct` |
| `POST /api/entries/{id}/recreate` | same; plus P-PERM re-evaluated inside preflight (defense in depth) |
| reconcile/dismiss/undismiss/resolve | same scoping and `canAct` |
| `POST /api/entries/bulk-preflight`, `POST /api/entries/bulk-recreate` | `isClockifyAdminRole` required on the route itself (admin-only), plus per-entry `canAct` and P-PERM inside the engine. A regular user gets 403 before any per-entry data is computed |
| `GET /api/options` | workspace-scoped current projects/tasks/tags; available to any verified viewer in the workspace (these are current workspace entities, not deleted data) |

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
