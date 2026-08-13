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
import { renderList } from "../../src/ui/views/list.js";
import { renderResolutionWidgets, type MutableChoices } from "../../src/ui/views/resolution-widgets.js";
import { renderResult } from "../../src/ui/views/result.js";
import { withLoading } from "../../src/ui/views/shared.js";
import { ApiError, MutationTransportError, SessionExpiredError } from "../../src/ui/api.js";
import type { Ctx, ResolutionDraft } from "../../src/ui/state.js";
import type { ActionRequiredItem, BulkPreflightRow, BulkRecreateRow, DeletedTimeEntry, DetailResponse, RecreationPlan } from "../../src/ui/types.js";

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
    presentation: {
      project: { id: "proj-new", name: "Customer API", outcome: "substituted" },
      task: null,
      tags: [{ id: "tag-1", name: "support", outcome: "kept" }],
      customFields: [],
      editable: [],
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
    api: { get: vi.fn(), post: vi.fn(), mutate: vi.fn() } as unknown as Ctx["api"],
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole: true,
    getNavigationVersion: () => 0,
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
    expect(shown).toContain("Customer API");
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
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockRejectedValue(
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

  it("treats a missing mutation response as unknown and does not offer recreate again", async () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockRejectedValue(new MutationTransportError());
    renderConfirm(ctx, "re-1", plan(), source());

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate entry")?.click();
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("We do not know whether the entry was recreated."));

    const labels = Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent);
    expect(labels).toEqual(["Open entry"]);
    expect(ctx.root.textContent).toContain("Do not recreate the entry again.");
  });

  it("treats a JSON object without a result as unknown", async () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockResolvedValue({});
    renderConfirm(ctx, "re-1", plan(), source());

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate entry")?.click();
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("We do not know whether the entry was recreated."));

    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Open entry"]);
  });

  it("requires a new check for a legacy plan without presentation metadata", () => {
    const ctx = stubCtx();
    renderConfirm(ctx, "re-1", plan({ presentation: null }), source());

    expect(ctx.root.textContent).toContain("This saved plan does not have the details needed for confirmation.");
    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("Recreate entry");
  });

  it("shows a kept custom-field value when Clockify will attach the current default", () => {
    const ctx = stubCtx();
    const sourceWithDefault = source({
      customFieldValues: [{ customFieldId: "cf-priority", name: "Old priority name", value: "Normal" }],
    });
    const base = plan();
    const planWithDefault = plan({
      presentation: {
        ...base.presentation!,
        customFields: [{ id: "cf-priority", name: "Priority", outcome: "kept" }],
      },
    });

    renderConfirm(ctx, "re-1", planWithDefault, sourceWithDefault);

    const row = Array.from(ctx.root.querySelectorAll("tbody tr")).find((candidate) =>
      candidate.querySelector("th")?.textContent === "Custom field: Priority",
    );
    expect(Array.from(row?.querySelectorAll("td") ?? []).map((cell) => cell.textContent)).toEqual(["Normal", "Normal"]);
  });
});

describe("action lifecycle", () => {
  it("shows the session-expired takeover when Undismiss cannot refresh the session", async () => {
    const ctx = stubCtx();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      entry: { id: "re-1", lifecycleState: "DISMISSED" },
      plan: null,
      attempts: [],
      lineage: { parent: null, child: null },
      disabled: false,
      canMarkNotCreated: false,
    } as unknown as DetailResponse);
    (ctx.api.post as ReturnType<typeof vi.fn>).mockRejectedValue(new SessionExpiredError());

    renderDetail(ctx, "re-1");
    const undismiss = await vi.waitFor(() => {
      const button = Array.from(ctx.root.querySelectorAll("button")).find((item) => item.textContent === "Undismiss");
      expect(button).toBeDefined();
      return button;
    });
    undismiss?.click();

    await vi.waitFor(() => expect(ctx.navigate).toHaveBeenCalledWith({ kind: "session-expired" }));
  });

  it("ignores an action result after the user navigates away", async () => {
    let navigationVersion = 1;
    let resolveRequest: ((value: unknown) => void) | undefined;
    const ctx = stubCtx();
    ctx.getNavigationVersion = () => navigationVersion;
    ctx.navigate = vi.fn(() => {
      navigationVersion += 1;
    });
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockReturnValue(new Promise((resolve) => {
      resolveRequest = resolve;
    }));

    renderConfirm(ctx, "re-1", plan(), source());
    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate entry")?.click();
    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Back")?.click();
    resolveRequest?.({ result: { outcome: "RECREATED", newEntryId: "new-1", diffs: [] } });
    await Promise.resolve();

    expect(ctx.navigate).toHaveBeenCalledTimes(1);
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-1", forceResolve: true });
    expect(ctx.root.textContent).toContain("Confirm recreation");
    expect(ctx.root.textContent).not.toContain("Time entry recreated.");
  });

  it("sends one bulk-preflight request when the user clicks Review selected twice", async () => {
    const ctx = stubCtx();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => Promise.resolve(
      path === "/api/entries"
        ? {
            entries: [{
              id: "re-1",
              lifecycleState: "IDLE",
              detectedAt: "2026-08-07T12:00:00Z",
              source: source(),
              preflightSummary: { blockerCount: 0, actionRequiredCount: 0 },
            }],
            disabled: false,
            broken: false,
            clockifyUnavailable: false,
            truncated: false,
            limit: 200,
          }
        : { items: [] },
    ));
    (ctx.api.post as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => undefined));

    renderList(ctx);
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("API investigation"));
    const bulkMode = Array.from(ctx.root.querySelectorAll('input[type="checkbox"]')).find((input) =>
      input.closest("label")?.textContent?.includes("Bulk mode"),
    ) as HTMLInputElement;
    bulkMode.checked = true;
    bulkMode.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("Review selected (0)"));
    const rowCheckbox = Array.from(ctx.root.querySelectorAll('li input[type="checkbox"]'))[0] as HTMLInputElement;
    rowCheckbox.checked = true;
    rowCheckbox.dispatchEvent(new Event("change"));
    const review = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Review selected (1)");
    review?.click();
    review?.click();

    expect(review?.hasAttribute("disabled")).toBe(true);
    expect(rowCheckbox.disabled).toBe(true);
    expect(rowCheckbox.getAttribute("aria-label")).toContain("Ana Markovic");
    expect(rowCheckbox.getAttribute("aria-label")).toContain("API investigation");
    expect(ctx.api.post).toHaveBeenCalledTimes(1);
  });

  it("ignores an older load that finishes after a newer load", async () => {
    const ctx = stubCtx();
    let finishFirst: ((value: string) => void) | undefined;
    let finishSecond: ((value: string) => void) | undefined;
    const first = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<string>((resolve) => {
      finishSecond = resolve;
    });

    void withLoading(ctx, () => first, (value) => {
      ctx.root.textContent = value;
    });
    void withLoading(ctx, () => second, (value) => {
      ctx.root.textContent = value;
    });
    finishSecond?.("new response");
    await vi.waitFor(() => expect(ctx.root.textContent).toBe("new response"));
    finishFirst?.("old response");
    await Promise.resolve();

    expect(ctx.root.textContent).toBe("new response");
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

    const reviewed: BulkPreflightRow = { entryId: "re-1", status: "ready", source: source(), plan: plan() };
    renderBulkResults(ctx, rows, [reviewed]);

    expect(ctx.root.textContent).toContain("Unknown result");
    expect(ctx.root.textContent).toContain(message);
    expect(ctx.root.textContent).toContain("Ana Markovic");
    expect(ctx.root.textContent).toContain("API investigation");
    expect(ctx.root.textContent).not.toContain("Failed");
  });

  it("warns against a second recreation when the browser received no result", () => {
    const ctx = stubCtx();
    renderBulkResults(
      ctx,
      [{ entryId: "re-1", planId: "plan-1", outcome: "AMBIGUOUS" }],
      [{ entryId: "re-1", status: "ready", source: source(), plan: plan() }],
    );

    expect(ctx.root.textContent).toContain("Do not recreate this entry again.");
    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("Recreate");
  });
});

describe("persistent resolution controls", () => {
  it("shows the saved project, task, and tags after Confirm then Back", async () => {
    const ctx = stubCtx();
    const editable: ActionRequiredItem[] = [
      { ruleId: "P-PROJ-GONE", message: "Select a current project.", options: ["substitute"] },
      { ruleId: "P-TASK-GONE", message: "Select a current task.", options: ["substitute"] },
      { ruleId: "P-TAG-REQ", message: "Select a current tag." },
    ];
    const base = plan();
    const savedPlan = plan({
      choices: { projectId: "proj-new", taskId: "task-new", addTagIds: ["tag-2"] },
      plannedRequest: { ...base.plannedRequest, projectId: "proj-new", taskId: "task-new", tagIds: ["tag-1", "tag-2"] },
      presentation: {
        project: { id: "proj-new", name: "Customer API", outcome: "substituted" },
        task: { id: "task-new", name: "Investigation", outcome: "substituted" },
        tags: [
          { id: "tag-1", name: "support", outcome: "kept" },
          { id: "tag-2", name: "urgent", outcome: "substituted" },
        ],
        customFields: [],
        editable,
      },
    });
    const draft: ResolutionDraft = {
      choices: savedPlan.choices,
      actionRequired: editable,
      labels: {
        project: { id: "proj-new", name: "Customer API" },
        task: { id: "task-new", name: "Investigation" },
        tags: { "tag-2": "urgent" },
        customFields: {},
      },
    };
    renderConfirm(ctx, "re-1", savedPlan, source(), false, draft);
    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Back")?.click();
    const backState = vi.mocked(ctx.navigate).mock.calls.at(-1)?.[0];
    if (backState?.kind !== "detail") throw new Error("Back did not navigate to detail.");

    (ctx.api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string, query?: Record<string, string>) => {
      if (path === "/api/entries/detail") {
        return Promise.resolve({
          entry: { id: "re-1", lifecycleState: "IDLE", source: source() },
          plan: savedPlan,
          attempts: [],
          lineage: { parent: null, child: null },
          disabled: false,
          canMarkNotCreated: false,
        } as unknown as DetailResponse);
      }
      if (query?.kind === "projects") return Promise.resolve({ items: [{ id: "proj-new", name: "Customer API" }] });
      if (query?.kind === "tasks") return Promise.resolve({ items: [{ id: "task-new", name: "Investigation" }] });
      if (query?.kind === "tags") return Promise.resolve({ items: [{ id: "tag-2", name: "urgent" }] });
      return Promise.resolve({ items: [] });
    });
    (ctx.api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: savedPlan });

    renderDetail(ctx, backState.entryId, backState.forceResolve, backState.draft);

    await vi.waitFor(() => {
      expect(ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Replacement project"]')?.value).toBe("proj-new");
      expect(ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Replacement task"]')?.value).toBe("task-new");
      expect(Array.from(ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Current tags to add"]')?.selectedOptions ?? []).map((option) => option.value)).toEqual(["tag-2"]);
    });
  });

  it("reloads saved controls from the persisted plan after Try again", async () => {
    const ctx = stubCtx();
    const savedPlan = plan({
      choices: { projectId: "proj-new" },
      presentation: {
        project: { id: "proj-new", name: "Customer API", outcome: "substituted" },
        task: null,
        tags: [{ id: "tag-1", name: "support", outcome: "kept" }],
        customFields: [],
        editable: [{ ruleId: "P-PROJ-GONE", message: "Change the selected project.", options: ["remove"] }],
      },
    });
    (ctx.api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string, query?: Record<string, string>) => {
      if (path === "/api/entries/detail") {
        return Promise.resolve({
          entry: { id: "re-1", lifecycleState: "FAILED", source: source() },
          plan: savedPlan,
          attempts: [],
          lineage: { parent: null, child: null },
          disabled: false,
          canMarkNotCreated: false,
        } as unknown as DetailResponse);
      }
      if (query?.kind === "projects") return Promise.resolve({ items: [{ id: "proj-new", name: "Customer API" }] });
      return Promise.resolve({ items: [] });
    });
    (ctx.api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: savedPlan });

    renderDetail(ctx, "re-1", true);

    await vi.waitFor(() => {
      expect(ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Replacement project"]')?.value).toBe("proj-new");
    });
  });

  it("shows a saved description and completed end time before they are changed", () => {
    const ctx = stubCtx();
    const completedEnd = "2026-08-07T12:34:56.000Z";
    const rendered = renderResolutionWidgets(
      ctx,
      { description: "Saved description", runningMode: "completed", completedEnd },
      vi.fn(),
      [
        { ruleId: "P-DESC", message: "Enter a description." },
        { ruleId: "P-RUN-END", message: "Select an end time." },
      ],
      null,
      source({ wasRunning: true, end: null }),
    );

    expect(rendered.querySelector<HTMLInputElement>('input[aria-label="Description"]')?.value).toBe("Saved description");
    const end = rendered.querySelector<HTMLInputElement>('input[type="datetime-local"]');
    const date = new Date(completedEnd);
    const expected = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    expect(end?.value).toBe(expected);
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
          ? { outcome: "AMBIGUOUS", finishedAt: null, reconcile: null }
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
