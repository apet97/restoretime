// UT-A01 (docs/13): policy — admin vs regular vs wrong-owner vs wrong-workspace.
import { describe, expect, it } from "vitest";
import { canAct, canRead, isAdmin } from "../../src/domain/policy.js";
import type { Viewer } from "../../src/domain/entry.js";

const ENTRY = { ownerId: "user-1" };

describe("UT-A01 policy", () => {
  it("admin can read and act on any entry in the workspace", () => {
    const admin: Viewer = { userId: "admin-1", workspaceId: "ws-1", workspaceRole: "admin" };
    expect(isAdmin(admin)).toBe(true);
    expect(canRead(ENTRY, admin)).toBe(true);
    expect(canAct(ENTRY, admin)).toBe(true);
  });

  it("owner role counts as admin", () => {
    const owner: Viewer = { userId: "owner-1", workspaceId: "ws-1", workspaceRole: "owner" };
    expect(isAdmin(owner)).toBe(true);
    expect(canRead(ENTRY, owner)).toBe(true);
  });

  it("a regular viewer can read/act only on their own entry", () => {
    const self: Viewer = { userId: "user-1", workspaceId: "ws-1", workspaceRole: "member" };
    expect(isAdmin(self)).toBe(false);
    expect(canRead(ENTRY, self)).toBe(true);
    expect(canAct(ENTRY, self)).toBe(true);
  });

  it("a regular viewer cannot read/act on another user's entry (wrong owner)", () => {
    const other: Viewer = { userId: "user-2", workspaceId: "ws-1", workspaceRole: "member" };
    expect(canRead(ENTRY, other)).toBe(false);
    expect(canAct(ENTRY, other)).toBe(false);
  });

  it("workspace scoping is the caller's responsibility (row lookups are scoped by workspaceId before canRead runs)", () => {
    // policy.ts itself has no workspace concept — the store layer scopes every lookup by
    // workspace_id first (docs/09), so a cross-workspace id simply finds no row. This test
    // documents that boundary rather than re-testing the store.
    const viewerInOtherWorkspace: Viewer = { userId: "user-1", workspaceId: "ws-2", workspaceRole: "member" };
    // Same userId, different workspace: policy alone cannot detect this — it is the row-scoping
    // query (`WHERE workspace_id = ? AND id = ?`) that prevents cross-workspace access, tested in
    // the integration layer (IT-07).
    expect(canRead(ENTRY, viewerInOtherWorkspace)).toBe(true);
  });
});
