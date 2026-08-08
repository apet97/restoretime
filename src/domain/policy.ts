// Authorization policy (docs/09). Exactly one predicate module, two rules. Identity comes from
// the verified component JWT only — this module never reads path/query/body identity.

import { isClockifyAdminRole } from "@apet97/clockify-addon-sdk/clockify";
import type { Viewer } from "./entry.js";

export function isAdmin(viewer: Viewer): boolean {
  return isClockifyAdminRole(viewer.workspaceRole);
}

export function canRead(entry: { readonly ownerId: string }, viewer: Viewer): boolean {
  return isAdmin(viewer) || entry.ownerId === viewer.userId;
}

export function canAct(entry: { readonly ownerId: string }, viewer: Viewer): boolean {
  return canRead(entry, viewer);
}
