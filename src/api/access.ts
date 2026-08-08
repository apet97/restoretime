// Row-scoped authorization boundary shared by every single-entry `/api/*` route (docs/09).
// `entryId` is a resource selector; identity and workspace scope come only from verified claims.
// The store lookup is already scoped `WHERE workspace_id = claims.workspaceId AND id = :entryId`
// (src/store/entries.ts `getById`), so a forged cross-workspace id finds no row — this module only
// adds the canRead/canAct decision on top of that scoped row.

import type { RecoverableEntry, Viewer } from "../domain/entry.js";
import { canRead } from "../domain/policy.js";

export type AccessResult =
  | { readonly kind: "ok"; readonly entry: RecoverableEntry }
  | { readonly kind: "not-found" }
  | { readonly kind: "forbidden" };

/**
 * `deniedIsForbidden`: pass `true` only when the viewer already knows this entry exists —
 * for example, they are the `createdBy` of a plan on it (an admin who created a plan, then lost
 * admin before confirming). In that one case a role-change denial reports 403 (why they were
 * denied), never 404: docs/09's "no existence leak" protects entries a viewer never had access
 * to, not a fact they already learned by creating the plan. Every other denial is 404.
 */
export function checkEntryAccess(
  entry: RecoverableEntry | undefined,
  viewer: Viewer,
  deniedIsForbidden = false,
): AccessResult {
  if (!entry) return { kind: "not-found" };
  if (canRead(entry, viewer)) return { kind: "ok", entry };
  return deniedIsForbidden ? { kind: "forbidden" } : { kind: "not-found" };
}
