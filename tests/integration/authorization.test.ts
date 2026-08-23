// IT-07 (docs/13). Real SQLite temp file: other-user entry 404; demoted admin 403;
// cross-workspace 404.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/store/db.js";
import * as entries from "../../src/store/entries.js";
import { checkEntryAccess } from "../../src/api/access.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";
// The request-time viewer, which carries the installation identity every scoped lookup needs.
// It is a superset of the domain policy `Viewer`, so `checkEntryAccess` accepts it unchanged.
import type { Viewer } from "../../src/platform/verify.js";
import { TEST_ADDON_ID, TEST_SCOPE, ingestEntry, seedInstallation } from "../support/installation-fixture.js";

let dir: string;

function freshDb() {
  dir = mkdtempSync(join(tmpdir(), "restoretime-authz-it-"));
  const db = openDatabase(join(dir, "restoretime.sqlite"));
  seedInstallation(db);
  return db;
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
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const otherUser: Viewer = { userId: "user-2", workspaceId: "ws-1", addonId: TEST_ADDON_ID, workspaceRole: "member" };
    const row = entries.getById(db, otherUser, entry.id);
    expect(checkEntryAccess(row, otherUser)).toEqual({ kind: "not-found" });
  });

  it("cross-workspace id -> not-found (the scoped lookup itself finds no row)", () => {
    const db = freshDb();
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const crossWorkspaceViewer: Viewer = { userId: "user-1", workspaceId: "ws-2", addonId: TEST_ADDON_ID, workspaceRole: "admin" };
    // The row lookup itself is scoped by the viewer's own claimed workspace — a forged/mismatched
    // workspace id finds nothing, before canRead is even evaluated.
    const row = entries.getById(db, crossWorkspaceViewer, entry.id);
    expect(row).toBeUndefined();
    expect(checkEntryAccess(row, crossWorkspaceViewer)).toEqual({ kind: "not-found" });
  });

  it("a demoted admin who created a plan on someone else's entry -> forbidden (403), not hidden", () => {
    const db = freshDb();
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const formerAdmin: Viewer = { userId: "admin-1", workspaceId: "ws-1", addonId: TEST_ADDON_ID, workspaceRole: "member" };
    const row = entries.getById(db, formerAdmin, entry.id);
    // The viewer previously created a plan for this entry (as admin) — they already know it
    // exists, so a subsequent role-change denial is 403, not a 404 that pretends otherwise.
    const planCreatedBy = "admin-1";
    expect(checkEntryAccess(row, formerAdmin, planCreatedBy === formerAdmin.userId)).toEqual({ kind: "forbidden" });
  });

  it("another installation generation of the same workspace -> not-found", () => {
    const db = freshDb();
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    // Same workspace, same user, same role — only the installation differs. A reinstall must not
    // inherit the previous generation's rows, so the scoped lookup finds nothing.
    const laterInstall: Viewer = {
      userId: "user-1",
      workspaceId: TEST_SCOPE.workspaceId,
      addonId: "addon-install-2",
      workspaceRole: "admin",
    };
    expect(entries.getById(db, laterInstall, entry.id)).toBeUndefined();
  });

  it("the resource owner always has access", () => {
    const db = freshDb();
    const { entry } = ingestEntry(db, {
      id: "re-1",
      scope: TEST_SCOPE,
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: SOURCE,
    });
    const owner: Viewer = { userId: "user-1", workspaceId: "ws-1", addonId: TEST_ADDON_ID, workspaceRole: "member" };
    const row = entries.getById(db, owner, entry.id);
    const result = checkEntryAccess(row, owner);
    expect(result.kind).toBe("ok");
  });
});
