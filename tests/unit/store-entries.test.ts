// UT-L01 (docs/13): lineage linking on ingestion. Pure store-level test against an in-memory
// migrated database.
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";
import { ingestDeletedEntry, getById, adopt, list } from "../../src/store/entries.js";
import * as attempts from "../../src/store/attempts.js";
import { insertAttemptFixture } from "../support/attempt-fixture.js";
import * as plans from "../../src/store/plans.js";
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

  it("does not link a recreated entry owned by another member", () => {
    const db = openDatabase(":memory:");
    const { entry: foreignParent } = ingestDeletedEntry(db, {
      id: "re-foreign",
      workspaceId: "ws-1",
      sourceEntryId: "foreign-source",
      ownerId: "user-2",
      detectedAt: "2026-08-08T09:00:00Z",
      source: source({ entryId: "foreign-source", ownerId: "user-2" }),
    });
    db.prepare(
      "UPDATE recoverable_entries SET lifecycle_state='RECREATED', new_entry_id='shared-clockify-id' WHERE id=?",
    ).run(foreignParent.id);

    const { entry: child } = ingestDeletedEntry(db, {
      id: "re-child",
      workspaceId: "ws-1",
      sourceEntryId: "shared-clockify-id",
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:05:00Z",
      source: source({ entryId: "shared-clockify-id", ownerId: "user-1" }),
    });

    expect(child.parentRecoverableId).toBeNull();
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
  function ambiguousRow(
    db: ReturnType<typeof openDatabase>,
    id: string,
    sourceEntryId: string,
    workspaceId = "ws-1",
  ) {
    ingestDeletedEntry(db, {
      id,
      workspaceId,
      sourceEntryId,
      ownerId: "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: source({ workspaceId, entryId: sourceEntryId }),
    });
    plans.createActive(db, {
      id: `plan-${id}`,
      recoverableEntryId: id,
      createdBy: "user-1",
      createdAt: "2026-08-08T09:00:01Z",
      sourceHash: "hash",
      choices: {},
      resolution: [],
      plannedRequest: {
        workspaceId,
        userId: "user-1",
        start: "2026-08-08T10:00:00Z",
        end: "2026-08-08T11:00:00Z",
      },
      warnings: [],
      blockers: [],
      actionRequired: [],
      fidelity: "FULL",
    });
    insertAttemptFixture(db, {
      id: `attempt-${id}`,
      planId: `plan-${id}`,
      recoverableEntryId: id,
      startedAt: "2026-08-08T09:00:02Z",
      baseline: [],
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
      diffs: [],
    };
    expect(adopt(db, {
      id: "re-a",
      expectedAttemptId: "attempt-re-a",
      ...input,
    })?.lifecycleState).toBe("RECREATED");

    // The route maps this throw to 409 and leaves the row AMBIGUOUS for the user to resolve.
    let thrown: unknown;
    try {
      adopt(db, { id: "re-b", expectedAttemptId: "attempt-re-b", ...input });
    } catch (err) {
      thrown = err;
    }
    expect(String((thrown as { code?: string })?.code)).toMatch(/^SQLITE_CONSTRAINT/);

    const rowB = getById(db, "ws-1", "re-b");
    expect(rowB?.lifecycleState).toBe("AMBIGUOUS");
    expect(rowB?.newEntryId).toBeNull();
    expect(attempts.getById(db, "attempt-re-b")?.outcome).toBeNull();
  });

  it("allows the same new_entry_id in a different workspace", () => {
    const db = openDatabase(":memory:");
    ambiguousRow(db, "re-a", "entry-a");
    ambiguousRow(db, "re-other", "entry-a", "ws-2");

    const common = { recreatedAt: "2026-08-08T10:00:00Z", recreatedBy: "user-1", diffs: [] };
    expect(
      adopt(db, {
        id: "re-a",
        workspaceId: "ws-1",
        expectedAttemptId: "attempt-re-a",
        newEntryId: "new-entry-x",
        ...common,
      })
        ?.lifecycleState,
    ).toBe("RECREATED");
    expect(
      adopt(db, {
        id: "re-other",
        workspaceId: "ws-2",
        expectedAttemptId: "attempt-re-other",
        newEntryId: "new-entry-x",
        ...common,
      })
        ?.lifecycleState,
    ).toBe("RECREATED");
  });
});

// UT-L02 (docs/13, docs/10 §2). The admin list filters on the owner/project name stored on the
// row, never on a Clockify lookup — a deleted project and a deactivated member are exactly the
// rows this product exists for, and neither appears in any current options list.
describe("UT-L02 name filters match the names stored at deletion time", () => {
  function seed(db: ReturnType<typeof openDatabase>, id: string, overrides: Partial<DeletedTimeEntry>): void {
    ingestDeletedEntry(db, {
      id,
      workspaceId: "ws-1",
      sourceEntryId: id,
      ownerId: overrides.ownerId ?? "user-1",
      detectedAt: "2026-08-08T09:00:00Z",
      source: source({ entryId: id, ...overrides }),
    });
  }

  function ids(db: ReturnType<typeof openDatabase>, filters: Parameters<typeof list>[2]): string[] {
    return list(db, "ws-1", filters).rows.map((r) => r.id);
  }

  it("matches a substring of either name, and folds ASCII case", () => {
    const db = openDatabase(":memory:");
    seed(db, "re-a", { ownerName: "Ada Lovelace", projectName: "Analytical Engine" });
    seed(db, "re-b", { ownerName: "Grace Hopper", projectName: "COBOL" });

    expect(ids(db, { ownerName: "lovelace" })).toEqual(["re-a"]);
    expect(ids(db, { ownerName: "GRACE" })).toEqual(["re-b"]);
    expect(ids(db, { projectName: "engine" })).toEqual(["re-a"]);
    // An empty filter string is not a filter — it must not narrow the list to nothing.
    expect(ids(db, { ownerName: "" }).sort()).toEqual(["re-a", "re-b"]);
  });

  // SQLite's built-in LIKE folds ASCII only. This is the documented limit of the filter
  // (docs/10 §2), and it is asserted rather than assumed, because a name like "Ötzi" is exactly
  // the case a reader would expect to work.
  it("does NOT fold non-ASCII case — the documented limit of SQLite's LIKE", () => {
    const db = openDatabase(":memory:");
    seed(db, "re-a", { ownerName: "Ötzi Iceman" });
    expect(ids(db, { ownerName: "Ötzi" })).toEqual(["re-a"]);
    expect(ids(db, { ownerName: "ötzi" })).toEqual([]);
  });

  it("treats SQLite's own wildcards as literal text, so a name containing % or _ is searchable", () => {
    const db = openDatabase(":memory:");
    seed(db, "re-pct", { projectName: "Q3 100% Margin" });
    seed(db, "re-us", { projectName: "back_office" });
    seed(db, "re-bs", { projectName: "path\\to\\thing" });
    seed(db, "re-plain", { projectName: "Q3 100x Margin" });

    // "100%" must not read as "100 followed by anything".
    expect(ids(db, { projectName: "100%" })).toEqual(["re-pct"]);
    // "_" must not read as "any single character".
    expect(ids(db, { projectName: "back_office" })).toEqual(["re-us"]);
    expect(ids(db, { projectName: "backXoffice" })).toEqual([]);
    // The escape character itself is escaped, so a backslash in a name is findable.
    expect(ids(db, { projectName: "to\\thing" })).toEqual(["re-bs"]);
  });

  it("a project-less row never matches a project-name filter, and an unnamed owner never matches a user filter", () => {
    const db = openDatabase(":memory:");
    // `projectName: null` is a manual entry with no project; `ownerName: ""` is what the webhook
    // normalizer stores when the payload carries no user name (src/ingest/deleted-entry.ts).
    seed(db, "re-none", { projectName: null, ownerName: "" });
    seed(db, "re-named", { projectName: "COBOL", ownerName: "Grace Hopper" });

    expect(ids(db, { projectName: "COBOL" })).toEqual(["re-named"]);
    // No non-empty filter can match an empty stored name, so the unnamed-owner row is reachable
    // only with the filter cleared. `"o"` is in "Grace Hopper" and in nothing on the other row.
    expect(ids(db, { ownerName: "o" })).toEqual(["re-named"]);
    expect(ids(db, {}).sort()).toEqual(["re-named", "re-none"]);
  });

  it("combines with the id filters rather than replacing them (both narrow)", () => {
    const db = openDatabase(":memory:");
    seed(db, "re-a", { ownerId: "user-1", ownerName: "Ada Lovelace" });
    seed(db, "re-b", { ownerId: "user-2", ownerName: "Ada Byron" });

    expect(ids(db, { ownerName: "Ada" }).sort()).toEqual(["re-a", "re-b"]);
    expect(ids(db, { ownerName: "Ada", userId: "user-2" })).toEqual(["re-b"]);
    expect(ids(db, { ownerName: "Grace", userId: "user-2" })).toEqual([]);
  });
});

// UT-L03 (docs/10 §2). `status` and `dismissed` both select a `lifecycle_state`, so a request
// carrying both is contradictory rather than narrow. Before this was resolved the two were ANDed
// into `lifecycle_state = 'FAILED' AND lifecycle_state = 'DISMISSED'`, which matches nothing and
// reads to an admin as "no such entries exist" — the same lie `handleListEntries` already refuses
// to tell for an unknown `status`.
describe("UT-L03 status and dismissed resolve to one lifecycle state, never a contradiction", () => {
  function seedStates(db: ReturnType<typeof openDatabase>): void {
    for (const [id, state] of [
      ["re-idle", "IDLE"],
      ["re-failed", "FAILED"],
      ["re-dismissed", "DISMISSED"],
    ] as const) {
      ingestDeletedEntry(db, {
        id,
        workspaceId: "ws-1",
        sourceEntryId: id,
        ownerId: "user-1",
        detectedAt: "2026-08-08T09:00:00Z",
        source: source({ entryId: id }),
      });
      db.prepare("UPDATE recoverable_entries SET lifecycle_state=? WHERE id=?").run(state, id);
    }
  }

  function ids(db: ReturnType<typeof openDatabase>, filters: Parameters<typeof list>[2]): string[] {
    return list(db, "ws-1", filters).rows.map((r) => r.id).sort();
  }

  it("keeps each filter's behaviour on its own", () => {
    const db = openDatabase(":memory:");
    seedStates(db);
    // Default: dismissed rows are hidden, everything else shows.
    expect(ids(db, {})).toEqual(["re-failed", "re-idle"]);
    expect(ids(db, { status: "FAILED" })).toEqual(["re-failed"]);
    expect(ids(db, { dismissed: true })).toEqual(["re-dismissed"]);
    // An explicit DISMISSED status reaches the same row without the toggle.
    expect(ids(db, { status: "DISMISSED" })).toEqual(["re-dismissed"]);
  });

  it("answers a contradictory pair with the dismissed rows, never with an empty list", () => {
    const db = openDatabase(":memory:");
    seedStates(db);
    // `dismissed` wins: reaching a category the default hides is its only purpose. The point of
    // the assertion is the non-emptiness — an empty result here would be indistinguishable from
    // "this workspace has no dismissed entries".
    expect(ids(db, { status: "FAILED", dismissed: true })).toEqual(["re-dismissed"]);
    expect(ids(db, { status: "IDLE", dismissed: true })).toEqual(["re-dismissed"]);
  });

  it("dismissed:false is not a filter — it leaves the default hiding in place", () => {
    const db = openDatabase(":memory:");
    seedStates(db);
    expect(ids(db, { dismissed: false })).toEqual(["re-failed", "re-idle"]);
    expect(ids(db, { status: "FAILED", dismissed: false })).toEqual(["re-failed"]);
  });
});
