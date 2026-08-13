// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../../src/ui/state.js";
import type { DetailResponse, RecreationPlan } from "../../src/ui/types.js";
import { renderDetail } from "../../src/ui/views/detail.js";
import { renderResult } from "../../src/ui/views/result.js";

function stubCtx(detail: DetailResponse): Ctx {
  const root = document.createElement("main");
  document.body.appendChild(root);
  return {
    root,
    api: { get: vi.fn().mockResolvedValue(detail), post: vi.fn() } as unknown as Ctx["api"],
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole: false,
    getNavigationVersion: () => 0,
    navigate: vi.fn(),
  };
}

function buttonLabels(ctx: Ctx): string[] {
  return Array.from(ctx.root.querySelectorAll("button"), (button) => button.textContent ?? "");
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("disabled detail actions", () => {
  it.each([
    { canMarkNotCreated: true, candidateIds: [] },
    { canMarkNotCreated: false, candidateIds: ["clockify-1", "clockify-2"] },
  ])("keeps an AMBIGUOUS entry readable without action buttons", async ({ canMarkNotCreated, candidateIds }) => {
    const detail = {
      entry: { id: "re-1", lifecycleState: "AMBIGUOUS" },
      plan: {},
      attempts: [
        {
          outcome: "AMBIGUOUS",
          reconcile: { checks: 3, checkedAt: "2026-08-10T09:00:00Z", candidateIds },
        },
      ],
      lineage: { parent: null, child: null },
      disabled: true,
      canMarkNotCreated,
    } as unknown as DetailResponse;
    const ctx = stubCtx(detail);

    renderResult(ctx, "re-1", {} as RecreationPlan, { outcome: "AMBIGUOUS" });

    await vi.waitFor(() => expect(ctx.root.textContent).toContain("RestoreTime is disabled for this workspace."));
    expect(buttonLabels(ctx)).toEqual(["Check status", "Back to deleted entries"]);
    expect(ctx.api.post).not.toHaveBeenCalled();

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Check status")?.click();
    await vi.waitFor(() => expect(ctx.api.get).toHaveBeenCalledTimes(2));
    expect(ctx.api.post).not.toHaveBeenCalled();

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Back to deleted entries")?.click();
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "list" });
  });

  it("keeps a DISMISSED entry readable without the Undismiss action", async () => {
    const detail = {
      entry: { id: "re-1", lifecycleState: "DISMISSED" },
      plan: null,
      attempts: [],
      lineage: { parent: null, child: null },
      disabled: true,
      canMarkNotCreated: false,
    } as unknown as DetailResponse;
    const ctx = stubCtx(detail);

    renderDetail(ctx, "re-1");

    await vi.waitFor(() => expect(ctx.root.textContent).toContain("RestoreTime is disabled for this workspace."));
    expect(ctx.root.textContent).toContain("This entry is hidden from the default list.");
    expect(buttonLabels(ctx)).toEqual(["Check status", "Back to deleted entries"]);
    expect(ctx.api.post).not.toHaveBeenCalled();

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Check status")?.click();
    await vi.waitFor(() => expect(ctx.api.get).toHaveBeenCalledTimes(2));
    expect(ctx.api.post).not.toHaveBeenCalled();
  });
});
