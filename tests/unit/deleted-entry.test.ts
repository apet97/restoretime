// UT-N01 / UT-N02 (docs/13). Guard rejects malformed bodies; normalization builds the exact
// DeletedTimeEntry shape from a flat webhook payload.
import { describe, expect, it } from "vitest";
import {
  guardDeletedEntryPayload,
  normalizeDeletedEntry,
  type RawDeletedEntryPayload,
} from "../../src/ingest/deleted-entry.js";

function validBody(): Record<string, unknown> {
  return {
    id: "ENTRY_1",
    workspaceId: "WS_1",
    userId: "USER_1",
    description: "hello",
    billable: true,
    projectId: "PROJ_1",
    type: "REGULAR",
    currentlyRunning: false,
    timeInterval: { start: "2026-08-08T10:00:00Z", end: "2026-08-08T11:00:00Z", timeZone: "UTC" },
    project: { name: "Project One", clientName: "Client A" },
    task: { id: "TASK_1", name: "Task One" },
    tags: [{ id: "TAG_1", name: "Tag One" }],
    user: { name: "Firstname Lastname" },
    customFieldValues: [{ customFieldId: "CF_1", timeEntryId: "ENTRY_1", value: "x", name: "F" }],
  };
}

describe("UT-N01 guardDeletedEntryPayload", () => {
  it("accepts a well-formed body", () => {
    const result = guardDeletedEntryPayload(validBody());
    expect(result.ok).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect(guardDeletedEntryPayload(null).ok).toBe(false);
    expect(guardDeletedEntryPayload("x").ok).toBe(false);
    expect(guardDeletedEntryPayload([1, 2]).ok).toBe(false);
  });

  it("rejects when id is missing", () => {
    const body = validBody();
    delete body.id;
    expect(guardDeletedEntryPayload(body).ok).toBe(false);
  });

  it("rejects when workspaceId is missing", () => {
    const body = validBody();
    delete body.workspaceId;
    expect(guardDeletedEntryPayload(body).ok).toBe(false);
  });

  it("rejects when timeInterval.start is missing", () => {
    const body = validBody();
    body.timeInterval = { end: null, timeZone: "UTC" };
    expect(guardDeletedEntryPayload(body).ok).toBe(false);
  });

  it("rejects wrong types (id as number)", () => {
    const body = validBody();
    body.id = 123;
    expect(guardDeletedEntryPayload(body).ok).toBe(false);
  });

  it("rejects wrong types (billable as string)", () => {
    const body = validBody();
    body.billable = "true";
    expect(guardDeletedEntryPayload(body).ok).toBe(false);
  });

  it("rejects wrong types (currentlyRunning as string)", () => {
    const body = validBody();
    body.currentlyRunning = "false";
    expect(guardDeletedEntryPayload(body).ok).toBe(false);
  });

  it("rejects an empty-string id", () => {
    const body = validBody();
    body.id = "";
    expect(guardDeletedEntryPayload(body).ok).toBe(false);
  });

  it("accepts a null project, task and empty tags/customFieldValues", () => {
    const body = validBody();
    body.project = null;
    body.task = null;
    body.tags = [];
    body.customFieldValues = [];
    expect(guardDeletedEntryPayload(body).ok).toBe(true);
  });
});

describe("UT-N02 normalizeDeletedEntry", () => {
  it("builds the exact DeletedTimeEntry shape from a flat payload", () => {
    const guarded = guardDeletedEntryPayload(validBody());
    if (!guarded.ok) throw new Error("expected guard to accept");
    const entry = normalizeDeletedEntry(guarded.payload);

    expect(entry).toEqual({
      workspaceId: "WS_1",
      entryId: "ENTRY_1",
      ownerId: "USER_1",
      ownerName: "Firstname Lastname",
      description: "hello",
      billable: true,
      start: "2026-08-08T10:00:00Z",
      end: "2026-08-08T11:00:00Z",
      wasRunning: false,
      type: "REGULAR",
      timeZone: "UTC",
      projectId: "PROJ_1",
      projectName: "Project One",
      clientName: "Client A",
      taskId: "TASK_1",
      taskName: "Task One",
      tags: [{ id: "TAG_1", name: "Tag One" }],
      customFieldValues: [{ customFieldId: "CF_1", name: "F", value: "x" }],
    });
  });

  it("reads embedded task.id and tags[].id, not any top-level taskId/tagIds (W2)", () => {
    const body = validBody();
    // The webhook payload never carries top-level taskId/tagIds; simulate that absence.
    const guarded = guardDeletedEntryPayload(body);
    if (!guarded.ok) throw new Error("expected guard to accept");
    const entry = normalizeDeletedEntry(guarded.payload);
    expect(entry.taskId).toBe("TASK_1");
    expect(entry.tags).toEqual([{ id: "TAG_1", name: "Tag One" }]);
  });

  it("running shape: currentlyRunning true -> wasRunning true, end null", () => {
    const body = validBody();
    body.currentlyRunning = true;
    body.timeInterval = { start: "2026-08-08T10:00:00Z", end: null, timeZone: "UTC" };
    const guarded = guardDeletedEntryPayload(body);
    if (!guarded.ok) throw new Error("expected guard to accept");
    const entry = normalizeDeletedEntry(guarded.payload);
    expect(entry.wasRunning).toBe(true);
    expect(entry.end).toBeNull();
  });

  it("auto-stopped shape (W12): currentlyRunning false with an end -> wasRunning false, not inferred from end", () => {
    const body = validBody();
    body.currentlyRunning = false;
    body.timeInterval = { start: "2026-08-08T10:00:00Z", end: "2026-08-08T10:00:03Z", timeZone: "UTC" };
    const guarded = guardDeletedEntryPayload(body);
    if (!guarded.ok) throw new Error("expected guard to accept");
    const entry = normalizeDeletedEntry(guarded.payload);
    expect(entry.wasRunning).toBe(false);
    expect(entry.end).toBe("2026-08-08T10:00:03Z");
  });

  it("defaults ownerName, projectName, clientName, taskName, tags, customFieldValues when absent", () => {
    const body = validBody();
    body.project = null;
    body.task = null;
    body.tags = [];
    body.user = null;
    body.customFieldValues = [];
    const guarded = guardDeletedEntryPayload(body);
    if (!guarded.ok) throw new Error("expected guard to accept");
    const entry = normalizeDeletedEntry(guarded.payload as RawDeletedEntryPayload);
    expect(entry.ownerName).toBe("");
    expect(entry.projectName).toBeNull();
    expect(entry.clientName).toBeNull();
    expect(entry.taskId).toBeNull();
    expect(entry.taskName).toBeNull();
    expect(entry.tags).toEqual([]);
    expect(entry.customFieldValues).toEqual([]);
  });
});
