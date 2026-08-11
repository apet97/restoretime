// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../../src/ui/state.js";
import type { BulkPreflightRow, DeletedTimeEntry } from "../../src/ui/types.js";
import { renderBulkReview } from "../../src/ui/views/bulk.js";

function source(): DeletedTimeEntry {
  return {
    workspaceId: "ws-1",
    entryId: "entry-1",
    ownerId: "user-1",
    ownerName: "Ana Markovic",
    description: "API investigation",
    billable: false,
    start: "2026-08-07T09:00:00Z",
    end: "2026-08-07T10:00:00Z",
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
}

function stubCtx(): Ctx {
  const root = document.createElement("main");
  document.body.appendChild(root);
  return {
    root,
    api: { get: vi.fn(), post: vi.fn() } as unknown as Ctx["api"],
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole: true,
    navigate: vi.fn(),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("bulk review state changes", () => {
  it("explains a selected entry that is no longer actionable and lets the user open it", () => {
    const ctx = stubCtx();
    const rows: BulkPreflightRow[] = [{ entryId: "re-1", status: "not-actionable", source: source() }];

    renderBulkReview(ctx, rows);

    expect(ctx.root.textContent).toContain("State changed");
    expect(ctx.root.textContent).toContain("This entry changed after you selected it. Open the entry to see its current status.");
    expect(ctx.root.textContent).toContain("API investigation");
    const open = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Open");
    expect(open).toBeDefined();
    open?.click();
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-1" });
  });
});
