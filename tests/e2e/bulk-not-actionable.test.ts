// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUiSessionState, type Ctx } from "../../src/ui/state.js";
import { MutationTransportError } from "../../src/ui/api.js";
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
    api: { get: vi.fn(), post: vi.fn(), mutate: vi.fn() } as unknown as Ctx["api"],
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole: true,
    session: createUiSessionState(),
    getNavigationVersion: () => 0,
    navigate: vi.fn(),
    announce: vi.fn(),
    reload: vi.fn(),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("bulk review state changes", () => {
  it("keeps the previous review readable but disables recreation while a return refresh is running", async () => {
    const ctx = stubCtx();
    let finish: ((value: { results: readonly BulkPreflightRow[] }) => void) | undefined;
    (ctx.api.post as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((resolve) => {
      finish = resolve;
    }));
    const rows: BulkPreflightRow[] = [{
      entryId: "re-1",
      status: "ready",
      source: source(),
      plan: {
        id: "plan-1",
        plannedRequest: { workspaceId: "ws-1", userId: "user-1", start: source().start, end: source().end },
        presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
        warnings: [], blockers: [], actionRequired: [], fidelity: "FULL",
      } as unknown as NonNullable<BulkPreflightRow["plan"]>,
    }];
    ctx.session.selectedEntryIds.add("re-1");

    renderBulkReview(ctx, rows, true);

    const recreate = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 1 entry");
    expect(ctx.root.textContent).toContain("Refreshing review…");
    expect(recreate?.disabled).toBe(true);
    expect(ctx.api.post).toHaveBeenCalledWith("/api/entries/bulk-preflight", { ids: ["re-1"] });

    finish?.({ results: rows });
    await vi.waitFor(() => expect(Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 1 entry")?.disabled).toBe(false));
  });

  it("sends one request when the user clicks Recreate twice", () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => undefined));
    const rows: BulkPreflightRow[] = [{
      entryId: "re-1",
      status: "ready",
      source: source(),
      plan: {
        id: "plan-1",
        plannedRequest: { workspaceId: "ws-1", userId: "user-1", start: source().start, end: source().end },
        presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
        warnings: [],
        blockers: [],
        actionRequired: [],
        fidelity: "FULL",
      } as unknown as NonNullable<BulkPreflightRow["plan"]>,
    }];

    ctx.session.selectedEntryIds.add("re-1");
    renderBulkReview(ctx, rows);

    const recreate = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 1 entry");
    expect(recreate).toBeDefined();
    recreate?.click();
    recreate?.click();

    expect(recreate?.disabled).toBe(true);
    expect(ctx.api.mutate).toHaveBeenCalledTimes(1);
  });

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
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-1", returnTo: "bulk-review" });
  });

  it("locks the snapshotted selection and shows an identified unknown result after transport loss", async () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockRejectedValue(new MutationTransportError());
    const row: BulkPreflightRow = {
      entryId: "re-1",
      status: "ready",
      source: source(),
      plan: {
        id: "plan-1",
        plannedRequest: { workspaceId: "ws-1", userId: "user-1", start: source().start, end: source().end },
        presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
        warnings: [],
        blockers: [],
        actionRequired: [],
        fidelity: "FULL",
      } as unknown as NonNullable<BulkPreflightRow["plan"]>,
    };
    ctx.session.selectedEntryIds.add("re-1");
    renderBulkReview(ctx, [row]);

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 1 entry")?.click();
    const checkbox = ctx.root.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox?.disabled).toBe(true);
    expect(Array.from(ctx.root.querySelectorAll("button")).every((button) => button.disabled)).toBe(true);
    await vi.waitFor(() => expect(ctx.navigate).toHaveBeenCalledWith({
      kind: "bulk-results",
      rows: [{ entryId: "re-1", planId: "plan-1", outcome: "AMBIGUOUS" }],
      reviewRows: [row],
    }));
  });

  it("treats a JSON object without bulk results as unknown for the snapshot", async () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const row: BulkPreflightRow = {
      entryId: "re-1",
      status: "ready",
      source: source(),
      plan: {
        id: "plan-1",
        plannedRequest: { workspaceId: "ws-1", userId: "user-1", start: source().start, end: source().end },
        presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
        warnings: [],
        blockers: [],
        actionRequired: [],
        fidelity: "FULL",
      } as unknown as NonNullable<BulkPreflightRow["plan"]>,
    };
    ctx.session.selectedEntryIds.add("re-1");
    renderBulkReview(ctx, [row]);

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 1 entry")?.click();

    await vi.waitFor(() => expect(ctx.navigate).toHaveBeenCalledWith({
      kind: "bulk-results",
      rows: [{ entryId: "re-1", planId: "plan-1", outcome: "AMBIGUOUS" }],
      reviewRows: [row],
    }));
  });

  it("does not offer Open for an entry that does not exist", () => {
    const ctx = stubCtx();
    renderBulkReview(ctx, [{ entryId: "missing", status: "not-found" }]);
    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("Open");
  });
});
