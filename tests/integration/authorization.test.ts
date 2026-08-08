// IT-07 (docs/13). Real SQLite temp file: other-user entry 404; demoted admin 403;
// cross-workspace 404.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/store/db.js";
import * as entries from "../../src/store/entries.js";
import { checkEntryAccess } from "../../src/api/access.js";
import type { DeletedTimeEntry, Viewer } from "../../src/domain/entry.js";

let dir: string;

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), "restoretime-authz-it-"));
  return openDatabase(join(dir, "restoretime.sqlite"));
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const SOURCE: DeletedTimeEntry = {
  workspaceId: "ws-1",
  entryId: "entry-a",
  ownerId: "user-1",
  ownerName: "User One",
  description: "d",
  billable: true,
  start: "2026-08-08T10:00:00Z",
  end: "2026-08-08T11:00:00Z",
  wasRunning: false,
  type: "REGULAR",
  timeZone: "UTC",
  projectId: null,
  projectName: null,
  clientName: null,
  taskId: null,
  taskName: null,
  tags: [],
  customFieldValues: [],
};

describe("IT-07 authorization negatives", () => {
  it("another user's entry -> not-found (no existence leak)", () => {
    const db = freshDb();
    const { entry } = entries.ingestDeletedEntry(db, {
      id: "re-1",
      workspaceId: "ws-1",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const otherUser: Viewer = { userId: "user-2", workspaceId: "ws-1", workspaceRole: "member" };
    const row = entries.getById(db, otherUser.workspaceId, entry.id);
    expect(checkEntryAccess(row, otherUser)).toEqual({ kind: "not-found" });
  });

  it("cross-workspace id -> not-found (the scoped lookup itself finds no row)", () => {
    const db = freshDb();
    const { entry } = entries.ingestDeletedEntry(db, {
      id: "re-1",
      workspaceId: "ws-1",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const crossWorkspaceViewer: Viewer = { userId: "user-1", workspaceId: "ws-2", workspaceRole: "admin" };
    // The row lookup itself is scoped by the viewer's own claimed workspace — a forged/mismatched
    // workspace id finds nothing, before canRead is even evaluated.
    const row = entries.getById(db, crossWorkspaceViewer.workspaceId, entry.id);
    expect(row).toBeUndefined();
    expect(checkEntryAccess(row, crossWorkspaceViewer)).toEqual({ kind: "not-found" });
  });

  it("a demoted admin who created a plan on someone else's entry -> forbidden (403), not hidden", () => {
    const db = freshDb();
    const { entry } = entries.ingestDeletedEntry(db, {
      id: "re-1",
      workspaceId: "ws-1",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const formerAdmin: Viewer = { userId: "admin-1", workspaceId: "ws-1", workspaceRole: "member" };
    const row = entries.getById(db, formerAdmin.workspaceId, entry.id);
    // The viewer previously created a plan for this entry (as admin) — they already know it
    // exists, so a subsequent role-change denial is 403, not a 404 that pretends otherwise.
    const planCreatedBy = "admin-1";
    expect(checkEntryAccess(row, formerAdmin, planCreatedBy === formerAdmin.userId)).toEqual({ kind: "forbidden" });
  });

  it("the resource owner always has access", () => {
    const db = freshDb();
    const { entry } = entries.ingestDeletedEntry(db, {
      id: "re-1",
      workspaceId: "ws-1",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const owner: Viewer = { userId: "user-1", workspaceId: "ws-1", workspaceRole: "member" };
    const row = entries.getById(db, owner.workspaceId, entry.id);
    const result = checkEntryAccess(row, owner);
    expect(result.kind).toBe("ok");
  });
});
