// UT-L01 (docs/13): lineage linking on ingestion. Pure store-level test against an in-memory
// migrated database.
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import { ingestDeletedEntry, getById, adopt } from "../../src/store/entries.js";
import type { DeletedTimeEntry } from "../../src/domain/entry.js";

function source(overrides: Partial<DeletedTimeEntry> = {}): DeletedTimeEntry {
  return {
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
    ...overrides,
  };
}

describe("UT-L01 lineage linking on ingestion", () => {
  it("links parent_recoverable_id when the deleted id matches an existing new_entry_id", () => {
    const db = openDatabase(":memory:");

    // Row A was recreated as Clockify entry "new-entry-x".
    const { entry: rowA } = ingestDeletedEntry(db, {
      id: "re-a",
      workspaceId: "ws-1",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: source({ entryId: "entry-a" }),
    });
    db.prepare(
      "UPDATE recoverable_entries SET lifecycle_state='RECREATED', new_entry_id='new-entry-x' WHERE id=?",
    ).run(rowA.id);

    // Row B: the webhook fires again for "new-entry-x" (it got deleted too) — chain A -> B.
    const { entry: rowB } = ingestDeletedEntry(db, {
      id: "re-b",
      workspaceId: "ws-1",
      sourceEntryId: "new-entry-x",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:05:00Z",
      source: source({ entryId: "new-entry-x" }),
    });

    expect(rowB.parentRecoverableId).toBe(rowA.id);
    const reloaded = getById(db, "ws-1", "re-b");
    expect(reloaded?.parentRecoverableId).toBe(rowA.id);
  });

  it("leaves parent_recoverable_id null when no row's new_entry_id matches", () => {
    const db = openDatabase(":memory:");
    const { entry } = ingestDeletedEntry(db, {
      id: "re-a",
      workspaceId: "ws-1",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: source(),
    });
    expect(entry.parentRecoverableId).toBeNull();
  });

  it("a duplicate delivery (same source_entry_id) is not inserted twice", () => {
    const db = openDatabase(":memory:");
    const first = ingestDeletedEntry(db, {
      id: "re-a",
      workspaceId: "ws-1",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: source(),
    });
    const second = ingestDeletedEntry(db, {
      id: "re-a-retry",
      workspaceId: "ws-1",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:05Z",
      source: source(),
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM recoverable_entries WHERE workspace_id = ?")
      .get("ws-1") as { n: number };
    expect(count.n).toBe(1);
  });
});


// docs/08 "double-adoption guard (advisor)" and docs/07 §8: two AMBIGUOUS rows must never adopt
// the same Clockify entry. The guard is the partial unique index on
// (workspace_id, new_entry_id), not application logic, so it is tested at the database.
describe("double-adoption guard", () => {
  function ambiguousRow(db: ReturnType<typeof openDatabase>, id: string, sourceEntryId: string) {
    ingestDeletedEntry(db, {
      id,
      workspaceId: "ws-1",
      sourceEntryId,
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: source({ entryId: sourceEntryId }),
    });
    db.prepare("UPDATE recoverable_entries SET lifecycle_state='AMBIGUOUS' WHERE id=?").run(id);
  }

  it("rejects a second row adopting an already-adopted new_entry_id", () => {
    const db = openDatabase(":memory:");
    ambiguousRow(db, "re-a", "entry-a");
    ambiguousRow(db, "re-b", "entry-b");

    const input = {
      workspaceId: "ws-1",
      newEntryId: "new-entry-x",
      recreatedAt: "2026-08-08T10:00:00Z",
      recreatedBy: "user-1",
    };
    expect(adopt(db, { id: "re-a", ...input })?.lifecycleState).toBe("RECREATED");

    // The route maps this throw to 409 and leaves the row AMBIGUOUS for the user to resolve.
    let thrown: unknown;
    try {
      adopt(db, { id: "re-b", ...input });
    } catch (err) {
      thrown = err;
    }
    expect(String((thrown as { code?: string })?.code)).toMatch(/^SQLITE_CONSTRAINT/);

    const rowB = getById(db, "ws-1", "re-b");
    expect(rowB?.lifecycleState).toBe("AMBIGUOUS");
    expect(rowB?.newEntryId).toBeNull();
  });

  it("allows the same new_entry_id in a different workspace", () => {
    const db = openDatabase(":memory:");
    ambiguousRow(db, "re-a", "entry-a");
    ingestDeletedEntry(db, {
      id: "re-other",
      workspaceId: "ws-2",
      sourceEntryId: "entry-a",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: source({ workspaceId: "ws-2" }),
    });
    db.prepare("UPDATE recoverable_entries SET lifecycle_state='AMBIGUOUS' WHERE id=?").run(
      "re-other",
    );

    const common = { recreatedAt: "2026-08-08T10:00:00Z", recreatedBy: "user-1" };
    expect(
      adopt(db, { id: "re-a", workspaceId: "ws-1", newEntryId: "new-entry-x", ...common })
        ?.lifecycleState,
    ).toBe("RECREATED");
    expect(
      adopt(db, { id: "re-other", workspaceId: "ws-2", newEntryId: "new-entry-x", ...common })
        ?.lifecycleState,
    ).toBe("RECREATED");
  });
});
