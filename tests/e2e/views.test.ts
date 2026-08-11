// @vitest-environment happy-dom
//
// View-level regressions for defects an adversarial review found in PASS-03. Each one was
// reachable only by reasoning about rendered DOM and user sequence, not by typecheck, lint, or any
// API-level test — so each gets an assertion here rather than a note in a report.
//
// These render single views against a stub Ctx instead of driving the whole flow: the defects are
// in what a view puts on screen, and a full flow would bury that behind five other assertions.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderConfirm } from "../../src/ui/views/confirm.js";
import { renderBulkResults } from "../../src/ui/views/bulk.js";
import { renderDetail } from "../../src/ui/views/detail.js";
import { renderResolutionWidgets, type MutableChoices } from "../../src/ui/views/resolution-widgets.js";
import { renderResult } from "../../src/ui/views/result.js";
import { ApiError } from "../../src/ui/api.js";
import type { Ctx } from "../../src/ui/state.js";
import type { ActionRequiredItem, BulkRecreateRow, DeletedTimeEntry, DetailResponse, RecreationPlan } from "../../src/ui/types.js";

function source(overrides: Partial<DeletedTimeEntry> = {}): DeletedTimeEntry {
  return {
    workspaceId: "ws-1",
    entryId: "entry-a",
    ownerId: "user-1",
    ownerName: "Ana Markovic",
    description: "API investigation",
    billable: true,
    start: "2026-08-07T09:00:00Z",
    end: "2026-08-07T11:30:00Z",
    wasRunning: false,
    type: "REGULAR",
    timeZone: "UTC",
    projectId: "proj-old",
    projectName: "Legacy API",
    clientName: null,
    taskId: null,
    taskName: null,
    tags: [{ id: "tag-1", name: "support" }],
    customFieldValues: [],
    ...overrides,
  };
}

function plan(overrides: Partial<RecreationPlan> = {}): RecreationPlan {
  return {
    id: "plan-1",
    recoverableEntryId: "re-1",
    createdBy: "user-1",
    createdAt: "2026-08-07T12:00:00Z",
    sourceHash: "hash",
    choices: {},
    resolution: [
      { kind: "project", refId: "proj-new", outcome: "substituted" },
      { kind: "tag", refId: "tag-1", outcome: "kept" },
    ],
    plannedRequest: {
      workspaceId: "ws-1",
      userId: "user-1",
      start: "2026-08-07T09:00:00Z",
      end: "2026-08-07T11:30:00Z",
      description: "API investigation",
      billable: true,
      projectId: "proj-new",
      tagIds: ["tag-1"],
    },
    warnings: [],
    blockers: [],
    actionRequired: [],
    fidelity: "ADJUSTED",
    status: "ACTIVE",
    ...overrides,
  } as RecreationPlan;
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

describe("confirm view (docs/10 §5)", () => {
  it("shows readable planned values, never raw Clockify ids", () => {
    const ctx = stubCtx();
    renderConfirm(ctx, "re-1", plan(), source());
    const shown = ctx.root.textContent ?? "";

    // §5: "the exact planned values (as in the detail view's NEW ENTRY column)". A user cannot
    // authorize a mutation described by an opaque id.
    expect(shown).not.toContain("proj-new");
    expect(shown).toContain("A replacement project (selected above)");
    expect(shown).toContain("support");
    expect(shown).not.toContain("tag(s)");
    // §3's rows include the owner; it was missing entirely from confirm.
    expect(shown).toContain("Ana Markovic");
  });

  it("replaces the action with the notice when the installation is disabled", () => {
    const ctx = stubCtx();
    renderConfirm(ctx, "re-1", plan(), source(), true);
    const shown = ctx.root.textContent ?? "";
    expect(shown).toContain("RestoreTime is disabled for this workspace.");
    const buttons = Array.from(ctx.root.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).not.toContain("Recreate entry");
  });

  it("opens the entry status after an unknown write result and never offers to retry the consumed plan", async () => {
    const ctx = stubCtx();
    const message =
      "The recreation might have reached Clockify, but RestoreTime did not get a clear result. It is not known whether the entry was created. Do not create it by hand. Wait a moment, then open this entry again to check its status.";
    (ctx.api.post as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(502, { error: message, unknownResult: true }),
    );
    renderConfirm(ctx, "re-1", plan(), source());

    const recreate = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate entry");
    recreate?.click();
    await vi.waitFor(() => expect(ctx.root.textContent).toContain(message));

    const buttons = Array.from(ctx.root.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).not.toContain("Try again");
    const open = buttons.find((button) => button.textContent === "Open entry");
    expect(open).toBeDefined();
    open?.click();
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-1" });
  });
});

describe("bulk result view (docs/10 §7)", () => {
  it("renders a post-attempt error as Unknown result with its truthful message", () => {
    const ctx = stubCtx();
    const message =
      "The recreation might have reached Clockify, but RestoreTime did not get a clear result. It is not known whether the entry was created.";
    const rows: BulkRecreateRow[] = [
      { entryId: "re-1", planId: "plan-1", outcome: "AMBIGUOUS", message },
    ];

    renderBulkResults(ctx, rows);

    expect(ctx.root.textContent).toContain("Unknown result");
    expect(ctx.root.textContent).toContain(message);
    expect(ctx.root.textContent).not.toContain("Failed");
  });
});

describe("success result view (docs/10 §6)", () => {
  it("does not show an empty changes section for internal verification evidence", () => {
    const ctx = stubCtx();

    renderResult(ctx, "re-1", plan(), {
      outcome: "RECREATED",
      newEntryId: "entry-new",
      diffs: [{ field: "_verification", planned: null, actual: "list-unavailable" }],
    });

    expect(ctx.root.textContent).toContain("Time entry recreated.");
    expect(ctx.root.textContent).not.toContain("Clockify applied these changes");
  });
});

describe("deleted-entry lineage (F14)", () => {
  function detail(lifecycleState: "IDLE" | "RECREATED" | "AMBIGUOUS"): DetailResponse {
    const current = {
      id: "re-current",
      lifecycleState,
      newEntryId: lifecycleState === "RECREATED" ? "entry-new" : null,
      source: source(),
    };
    const parent = { ...current, id: "re-parent", lifecycleState: "RECREATED", newEntryId: "entry-a" };
    const child = { ...current, id: "re-child", source: source({ entryId: "entry-new" }) };
    const attempt =
      lifecycleState === "RECREATED"
        ? { outcome: "SUCCESS", diffs: [] }
        : lifecycleState === "AMBIGUOUS"
          ? { outcome: "AMBIGUOUS", finishedAt: null, reconcile: null, baseline: [] }
          : null;
    return {
      entry: current,
      plan: plan(),
      attempts: attempt ? [attempt] : [],
      lineage: { parent, child },
      disabled: false,
      canMarkNotCreated: false,
    } as unknown as DetailResponse;
  }

  function lineageButtons(ctx: Ctx): HTMLButtonElement[] {
    return Array.from(ctx.root.querySelectorAll('section[aria-label="Recreation chain"] button'));
  }

  it.each(["IDLE", "RECREATED", "AMBIGUOUS"] as const)("shows links in the %s detail state", async (lifecycleState) => {
    const ctx = stubCtx();
    const response = detail(lifecycleState);
    (ctx.api.get as ReturnType<typeof vi.fn>).mockResolvedValue(response);
    (ctx.api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: response.plan });

    renderDetail(ctx, "re-current");

    await vi.waitFor(() => expect(ctx.root.textContent).toContain("Recreation chain"));
    const buttons = lineageButtons(ctx);
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Open previous deleted entry",
      "Open next deleted entry",
    ]);

    buttons[0]?.click();
    buttons[1]?.click();
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-parent" });
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-child" });
  });
});

describe("running-entry widget (docs/10 §4)", () => {
  const runItem: ActionRequiredItem = { ruleId: "P-RUN", message: "Choose how to recreate this running entry." };
  const endItem: ActionRequiredItem = { ruleId: "P-RUN-END", message: "The end time must be after the start time." };

  function radios(root: HTMLElement) {
    return Array.from(root.querySelectorAll('input[type="radio"]'));
  }

  it("keeps both radios after a choice, so a mis-click is recoverable", () => {
    const ctx = stubCtx();
    const running = source({ wasRunning: true, end: null });

    // Round one: nothing chosen yet, P-RUN is open.
    const before = renderResolutionWidgets(ctx, {}, () => undefined, [runItem], null, running);
    expect(radios(before)).toHaveLength(2);

    // Round two: the user picked "Set an end time", so the server stops emitting P-RUN and only
    // P-RUN-END remains. The radios must still be there — otherwise "Start a running timer" is
    // unreachable for this entry forever, since no UI path unsets runningMode.
    const choices: MutableChoices = { runningMode: "completed" };
    const after = renderResolutionWidgets(ctx, choices, () => undefined, [endItem], null, running);
    const pair = radios(after);
    expect(pair).toHaveLength(2);
    expect((pair[1] as HTMLInputElement).checked).toBe(true);
  });

  it("names the start time and states the single-timer consequence", () => {
    const ctx = stubCtx();
    const rendered = renderResolutionWidgets(ctx, {}, () => undefined, [runItem], null, source({ wasRunning: true, end: null }));
    const shown = rendered.textContent ?? "";
    expect(shown).toContain("Start a running timer (start time");
    expect(shown).toContain("Clockify allows one running timer per user.");
  });

  it("renders nothing when the source was not running", () => {
    const ctx = stubCtx();
    const rendered = renderResolutionWidgets(ctx, {}, () => undefined, [], null, source());
    expect(radios(rendered)).toHaveLength(0);
  });
});
