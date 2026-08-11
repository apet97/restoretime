// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Ctx } from "../../src/ui/state.js";
import type { DetailResponse, RecreationPlan } from "../../src/ui/types.js";
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
    navigate: vi.fn(),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("ambiguous result refresh", () => {
  it("returns to the detail router when reconciliation has already recreated the entry", async () => {
    const detail = {
      entry: { id: "re-1", lifecycleState: "RECREATED", newEntryId: "clockify-1" },
      plan: {},
      attempts: [],
      lineage: { parent: null, child: null },
      disabled: false,
      canMarkNotCreated: false,
    } as unknown as DetailResponse;
    const ctx = stubCtx(detail);

    renderResult(ctx, "re-1", {} as RecreationPlan, { outcome: "AMBIGUOUS", baseline: [] });

    await vi.waitFor(() => expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-1" }));
    expect(ctx.root.textContent).not.toContain("We do not know whether Clockify created this entry.");
  });

  it("lets the user mark an eligible ambiguous entry as not created", async () => {
    const detail = {
      entry: { id: "re-1", lifecycleState: "AMBIGUOUS", newEntryId: null },
      plan: {},
      attempts: [{
        outcome: "AMBIGUOUS",
        finishedAt: null,
        baseline: [],
        reconcile: { checks: 3, checkedAt: "2026-08-07T12:00:00Z", candidateIds: [], truncated: false },
      }],
      lineage: { parent: null, child: null },
      disabled: false,
      canMarkNotCreated: true,
    } as unknown as DetailResponse;
    const ctx = stubCtx(detail);
    (ctx.api.post as ReturnType<typeof vi.fn>).mockResolvedValue({});

    renderResult(ctx, "re-1", {} as RecreationPlan, { outcome: "AMBIGUOUS", baseline: [] });

    const button = await vi.waitFor(() => {
      const found = Array.from(ctx.root.querySelectorAll("button")).find((item) => item.textContent === "It was not created");
      expect(found).toBeDefined();
      return found;
    });
    button?.click();

    await vi.waitFor(() => expect(ctx.api.post).toHaveBeenCalledWith("/api/entries/mark-not-created", { entryId: "re-1" }));
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "list" });
  });
});
