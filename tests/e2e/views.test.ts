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
import { renderBulkResults, renderBulkReview } from "../../src/ui/views/bulk.js";
import { renderDetail } from "../../src/ui/views/detail.js";
import { renderList } from "../../src/ui/views/list.js";
import { renderResolutionWidgets, type MutableChoices } from "../../src/ui/views/resolution-widgets.js";
import { renderResult } from "../../src/ui/views/result.js";
import { renderSessionExpired, withLoading } from "../../src/ui/views/shared.js";
import { ApiError, MutationTransportError, SessionExpiredError } from "../../src/ui/api.js";
import { createUiSessionState, type Ctx, type ResolutionDraft } from "../../src/ui/state.js";
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
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-1", returnTo: "list" });
  });

  it("treats a missing mutation response as unknown and does not offer recreate again", async () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockRejectedValue(new MutationTransportError());
    renderConfirm(ctx, "re-1", plan(), source());

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate entry")?.click();
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("We do not know whether the entry was recreated."));

    const labels = Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent);
    expect(labels).toEqual(["Open entry", "Back to deleted entries"]);
    expect(ctx.root.textContent).toContain("Do not recreate the entry again.");
  });

  it("treats a JSON object without a result as unknown", async () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockResolvedValue({});
    renderConfirm(ctx, "re-1", plan(), source());

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate entry")?.click();
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("We do not know whether the entry was recreated."));

    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).toEqual(["Open entry", "Back to deleted entries"]);
  });

  it("requires a new check for a legacy plan without presentation metadata", () => {
    const ctx = stubCtx();
    renderConfirm(ctx, "re-1", plan({ presentation: null }), source());

    expect(ctx.root.textContent).toContain("This saved plan does not have the details needed for confirmation.");
    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("Recreate entry");
  });

  it("keeps the bulk-review return path when it checks a legacy plan", () => {
    const ctx = stubCtx();
    renderConfirm(ctx, "re-1", plan({ presentation: null }), source(), false, undefined, "bulk-review");

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Check the plan again")?.click();

    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-1", forceResolve: true, returnTo: "bulk-review" });
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

  it("marks a substituted project when its current name stayed the same", () => {
    const ctx = stubCtx();
    const base = plan();
    const sameNamePlan = plan({
      plannedRequest: { ...base.plannedRequest, projectId: "project-new" },
      presentation: {
        ...base.presentation!,
        project: { id: "project-new", name: "Operations", outcome: "substituted" },
      },
    });

    renderConfirm(ctx, "re-1", sameNamePlan, source({ projectId: "project-old", projectName: "Operations" }));

    const row = Array.from(ctx.root.querySelectorAll("tbody tr")).find((candidate) => candidate.querySelector("th")?.textContent === "Project");
    const [deletedCell, plannedCell] = Array.from(row?.querySelectorAll("td") ?? []);
    expect(deletedCell?.textContent).toBe("Operations");
    expect(plannedCell?.textContent).toBe("Operations");
    expect(plannedCell?.classList.contains("rt-cell--changed")).toBe(true);
    expect(plannedCell?.getAttribute("aria-label")).toBe("Changed planned value: Operations");
    expect(ctx.root.textContent).not.toContain("project-old");
    expect(ctx.root.textContent).not.toContain("project-new");
  });

  it("marks kept project and task values when real names equal absence placeholders", () => {
    const ctx = stubCtx();
    const base = plan();
    const keptPlan = plan({
      plannedRequest: { ...base.plannedRequest, projectId: "project-1", taskId: "task-1" },
      presentation: {
        ...base.presentation!,
        project: { id: "project-1", name: "— (no project)", outcome: "kept" },
        task: { id: "task-1", name: "— (no task)", outcome: "kept" },
      },
    });

    renderConfirm(ctx, "re-1", keptPlan, source({ projectId: "project-1", projectName: "—", taskId: "task-1", taskName: "—" }));

    const rows = Array.from(ctx.root.querySelectorAll("tbody tr"));
    const cells = (label: string) => Array.from(rows.find((candidate) => candidate.querySelector("th")?.textContent === label)?.querySelectorAll("td") ?? []);
    const [deletedProject, plannedProject] = cells("Project");
    const [deletedTask, plannedTask] = cells("Task");
    expect(deletedProject?.textContent).toBe("—");
    expect(plannedProject?.textContent).toBe("— (no project)");
    expect(plannedProject?.classList.contains("rt-cell--changed")).toBe(true);
    expect(plannedProject?.getAttribute("aria-label")).toBe("Changed planned value: — (no project)");
    expect(deletedTask?.textContent).toBe("—");
    expect(plannedTask?.textContent).toBe("— (no task)");
    expect(plannedTask?.classList.contains("rt-cell--changed")).toBe(true);
    expect(plannedTask?.getAttribute("aria-label")).toBe("Changed planned value: — (no task)");
  });

  it("does not mark truly absent projects or tasks as changed", () => {
    const ctx = stubCtx();
    const base = plan();
    const { projectId: _projectId, taskId: _taskId, ...plannedRequest } = base.plannedRequest;
    const absentPlan = plan({
      plannedRequest,
      presentation: { ...base.presentation!, project: null, task: null },
    });

    renderConfirm(ctx, "re-1", absentPlan, source({ projectId: null, projectName: null, taskId: null, taskName: null }));

    const rows = Array.from(ctx.root.querySelectorAll("tbody tr"));
    const plannedCell = (label: string) =>
      Array.from(rows.find((candidate) => candidate.querySelector("th")?.textContent === label)?.querySelectorAll("td") ?? [])[1];
    expect(plannedCell("Project")?.classList.contains("rt-cell--changed")).toBe(false);
    expect(plannedCell("Task")?.classList.contains("rt-cell--changed")).toBe(false);
  });

  it("marks a kept custom-field default when its display text equals an absent source value", () => {
    const ctx = stubCtx();
    const base = plan();
    const defaultPlan = plan({
      presentation: {
        ...base.presentation!,
        customFields: [{ id: "cf-status", name: "Status", outcome: "kept", plannedValue: "not sent" }],
      },
    });

    renderConfirm(ctx, "re-1", defaultPlan, source({ customFieldValues: [] }));

    const row = Array.from(ctx.root.querySelectorAll("tbody tr")).find((candidate) => candidate.querySelector("th")?.textContent === "Custom field: Status");
    const [deletedCell, plannedCell] = Array.from(row?.querySelectorAll("td") ?? []);
    expect(deletedCell?.textContent).toBe("not sent");
    expect(plannedCell?.textContent).toBe("not sent");
    expect(plannedCell?.classList.contains("rt-cell--changed")).toBe(true);
  });

  it("marks a kept tag when its visible name changed", () => {
    const ctx = stubCtx();
    const base = plan();
    const renamedTagPlan = plan({
      presentation: {
        ...base.presentation!,
        tags: [{ id: "tag-1", name: "incident", outcome: "kept" }],
      },
    });

    renderConfirm(ctx, "re-1", renamedTagPlan, source());

    const row = Array.from(ctx.root.querySelectorAll("tbody tr")).find((candidate) => candidate.querySelector("th")?.textContent === "Tags");
    const [deletedCell, plannedCell] = Array.from(row?.querySelectorAll("td") ?? []);
    expect(deletedCell?.textContent).toBe("support");
    expect(plannedCell?.textContent).toBe("incident");
    expect(plannedCell?.classList.contains("rt-cell--changed")).toBe(true);
  });

  it("marks a legacy custom field when its type changes but its display text does not", () => {
    const ctx = stubCtx();
    const base = plan();
    const legacyPlan = plan({
      plannedRequest: {
        ...base.plannedRequest,
        customFields: [{ customFieldId: "cf-legacy", sourceType: "WORKSPACE", value: 1 }],
      },
      presentation: { ...base.presentation!, customFields: [] },
    });

    renderConfirm(ctx, "re-1", legacyPlan, source({ customFieldValues: [{ customFieldId: "cf-legacy", name: "Legacy value", value: "1" }] }));

    const row = Array.from(ctx.root.querySelectorAll("tbody tr")).find((candidate) => candidate.querySelector("th")?.textContent === "Custom field: Legacy value");
    const [deletedCell, plannedCell] = Array.from(row?.querySelectorAll("td") ?? []);
    expect(deletedCell?.textContent).toBe("1");
    expect(plannedCell?.textContent).toBe("1");
    expect(plannedCell?.classList.contains("rt-cell--changed")).toBe(true);
  });

  it("marks a presented kept custom field when its type changes but its display text does not", () => {
    const ctx = stubCtx();
    const base = plan();
    const presentedPlan = plan({
      plannedRequest: {
        ...base.plannedRequest,
        customFields: [{ customFieldId: "cf-presented", sourceType: "WORKSPACE", value: "1" }],
      },
      presentation: {
        ...base.presentation!,
        customFields: [{ id: "cf-presented", name: "Presented value", outcome: "kept" }],
      },
    });

    renderConfirm(ctx, "re-1", presentedPlan, source({ customFieldValues: [{ customFieldId: "cf-presented", name: "Presented value", value: 1 }] }));

    const row = Array.from(ctx.root.querySelectorAll("tbody tr")).find((candidate) => candidate.querySelector("th")?.textContent === "Custom field: Presented value");
    const [deletedCell, plannedCell] = Array.from(row?.querySelectorAll("td") ?? []);
    expect(deletedCell?.textContent).toBe("1");
    expect(plannedCell?.textContent).toBe("1");
    expect(plannedCell?.classList.contains("rt-cell--changed")).toBe(true);
  });

  it("marks only planned values that differ, and treats em-dash placeholders as no change", () => {
    const ctx = stubCtx();
    const base = plan();
    const changedPlan = plan({
      presentation: {
        ...base.presentation!,
        customFields: [{ id: "cf-cost", name: "Cost code", outcome: "dropped" }],
      },
    });

    renderConfirm(ctx, "re-1", changedPlan, source({ customFieldValues: [{ customFieldId: "cf-cost", name: "Cost code", value: "AZ-104" }] }));

    const rows = Array.from(ctx.root.querySelectorAll("tbody tr"));
    const plannedCell = (label: string) =>
      Array.from(rows.find((candidate) => candidate.querySelector("th")?.textContent === label)?.querySelectorAll("td") ?? [])[1];
    // Project is substituted and the custom field is dropped: real changes, marked on the planned
    // cell only. Task compares "—" with "— (no task)" — the same no-value fact, so no mark.
    expect(plannedCell("Custom field: Cost code")?.textContent).toBe("not sent");
    expect(plannedCell("Custom field: Cost code")?.classList.contains("rt-cell--changed")).toBe(true);
    expect(plannedCell("Project")?.classList.contains("rt-cell--changed")).toBe(true);
    expect(plannedCell("Task")?.classList.contains("rt-cell--changed")).toBe(false);
    expect(plannedCell("Date and time")?.classList.contains("rt-cell--changed")).toBe(false);
    expect(plannedCell("Owner")?.classList.contains("rt-cell--changed")).toBe(false);
  });

  it("shows warnings ahead of the routine differences", () => {
    const ctx = stubCtx();
    renderConfirm(ctx, "re-1", plan({ warnings: [{ ruleId: "P-CF-GONE", code: "CUSTOM_FIELD_GONE", message: "The custom field is not sent." }] }), source());

    const shown = ctx.root.textContent ?? "";
    expect(shown.indexOf("Warnings")).toBeGreaterThanOrEqual(0);
    expect(shown.indexOf("Warnings")).toBeLessThan(shown.indexOf("Differences"));
    // The action area states what the one click does, directly before the buttons.
    const bar = ctx.root.querySelector(".rt-action-bar");
    expect(bar?.textContent).toContain("RestoreTime will create one new time entry in Clockify with these values.");
    expect(bar?.querySelector("button.rt-primary")?.textContent).toBe("Recreate entry");
  });
});

describe("action lifecycle", () => {
  it("focuses and announces each full screen, but leaves focus in the updated plan region", async () => {
    const ctx = stubCtx();
    const initial = plan({
      actionRequired: [{ ruleId: "P-DESC", message: "Enter a description." }],
      presentation: { ...plan().presentation!, editable: [{ ruleId: "P-DESC", message: "Enter a description." }] },
    });
    const resolved = plan({ choices: { description: "Revised description" } });
    (ctx.api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      entry: { id: "re-1", lifecycleState: "IDLE", source: source({ description: "" }) },
      plan: initial,
      attempts: [],
      lineage: { parent: null, child: null },
      disabled: false,
      broken: false,
      canMarkNotCreated: false,
    } as unknown as DetailResponse);
    (ctx.api.post as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ plan: initial })
      .mockResolvedValueOnce({ plan: resolved });

    renderDetail(ctx, "re-1");
    await vi.waitFor(() => expect(ctx.root.querySelector('[data-view-heading]')?.textContent).toBe("Deleted time entry"));
    const heading = ctx.root.querySelector<HTMLElement>('[data-view-heading]');
    const facts = ctx.root.querySelector<HTMLElement>('[aria-label="Deleted entry facts"]');
    expect(document.activeElement).toBe(heading);
    expect(ctx.announce).toHaveBeenCalledWith("Deleted time entry");

    const description = ctx.root.querySelector<HTMLInputElement>('input[aria-label="Description"]');
    if (!description) throw new Error("Description control is missing.");
    description.value = "Revised description";
    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Save description")?.click();

    await vi.waitFor(() => expect(ctx.root.querySelector<HTMLButtonElement>('button[data-focus-key="continue"]')?.disabled).toBe(false));
    expect(ctx.root.querySelector('[data-view-heading]')).toBe(heading);
    expect(ctx.root.querySelector('[aria-label="Deleted entry facts"]')).toBe(facts);
    expect(document.activeElement).toBe(ctx.root.querySelector('input[data-focus-key="description"]'));
  });

  it("serializes preflight requests and keeps each submitting control group disabled", async () => {
    const ctx = stubCtx();
    let resolveFirst: ((value: { plan: RecreationPlan }) => void) | undefined;
    let resolveSecond: ((value: { plan: RecreationPlan }) => void) | undefined;
    const initial = plan({
      actionRequired: [
        { ruleId: "P-PROJ-GONE", message: "Select a current project." },
        { ruleId: "P-DESC", message: "Enter a description." },
      ],
      presentation: {
        ...plan().presentation!,
        editable: [
          { ruleId: "P-PROJ-GONE", message: "Select a current project." },
          { ruleId: "P-DESC", message: "Enter a description." },
        ],
      },
    });
    const first = new Promise<{ plan: RecreationPlan }>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<{ plan: RecreationPlan }>((resolve) => {
      resolveSecond = resolve;
    });
    (ctx.api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string, query?: Record<string, string>) => {
      if (path === "/api/entries/detail") {
        return Promise.resolve({
          entry: { id: "re-1", lifecycleState: "IDLE", source: source({ description: "" }) },
          plan: initial,
          attempts: [],
          lineage: { parent: null, child: null },
          disabled: false,
          broken: false,
          canMarkNotCreated: false,
        } as unknown as DetailResponse);
      }
      if (query?.kind === "projects") return Promise.resolve({ items: [{ id: "proj-new", name: "Customer API" }] });
      return Promise.resolve({ items: [] });
    });
    (ctx.api.post as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ plan: initial })
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    renderDetail(ctx, "re-1");
    const project = await vi.waitFor(() => {
      const select = ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Replacement project"]');
      expect(select).not.toBeNull();
      expect(select?.options).toHaveLength(2);
      return select!;
    });
    project.value = "proj-new";
    project.focus();
    project.dispatchEvent(new Event("change"));
    expect(project.disabled).toBe(true);

    const description = ctx.root.querySelector<HTMLInputElement>('input[aria-label="Description"]');
    if (!description) throw new Error("Description control is missing.");
    description.value = "New description";
    const save = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Save description");
    save?.focus();
    save?.click();
    expect(save?.disabled).toBe(true);
    await vi.waitFor(() => expect(ctx.api.post).toHaveBeenCalledTimes(2));

    resolveFirst?.({ plan: plan({ choices: { projectId: "proj-new" } }) });
    await vi.waitFor(() => expect(ctx.api.post).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(project.disabled).toBe(false));
    expect(vi.mocked(ctx.api.post).mock.calls.at(-1)).toEqual([
      "/api/entries/preflight",
      { entryId: "re-1", choices: { projectId: "proj-new", description: "New description" } },
    ]);

    resolveSecond?.({ plan: plan({ choices: { projectId: "proj-new", description: "New description" } }) });
    await vi.waitFor(() => expect(ctx.root.querySelector<HTMLButtonElement>('button[data-focus-key="continue"]')?.disabled).toBe(false));
  });

  it("keeps stored deleted-entry facts visible when the initial preflight is unavailable", async () => {
    const ctx = stubCtx();
    const detail = {
      entry: { id: "re-1", lifecycleState: "IDLE", source: source() },
      plan: plan(),
      attempts: [],
      lineage: { parent: null, child: null },
      disabled: false,
      broken: false,
      canMarkNotCreated: false,
    } as unknown as DetailResponse;
    (ctx.api.get as ReturnType<typeof vi.fn>).mockResolvedValue(detail);
    (ctx.api.post as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new ApiError(502, { error: "Clockify could not be reached. Nothing was created. Try again in a moment." }))
      .mockResolvedValueOnce({ plan: detail.plan });

    renderDetail(ctx, "re-1");
    await vi.waitFor(() => expect(ctx.root.querySelector('[aria-label="Plan error"]')?.textContent).toContain("Stored deleted-entry facts remain available."));
    expect(ctx.root.querySelector('[data-view-heading]')?.textContent).toBe("Deleted time entry");
    expect(ctx.root.querySelector('[aria-label="Deleted entry facts"]')?.textContent).toContain("API investigation");
    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).toContain("Check choices again");
    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).not.toContain("Continue to confirm");

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Check choices again")?.click();
    await vi.waitFor(() => expect(ctx.root.querySelector<HTMLButtonElement>('button[data-focus-key="continue"]')?.disabled).toBe(false));
  });

  it("states why Continue to confirm is unavailable while required choices are open", async () => {
    const ctx = stubCtx();
    const initial = plan({
      actionRequired: [{ ruleId: "P-DESC", message: "Enter a description." }],
      presentation: { ...plan().presentation!, editable: [{ ruleId: "P-DESC", message: "Enter a description." }] },
    });
    (ctx.api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      entry: { id: "re-1", lifecycleState: "IDLE", source: source({ description: "" }) },
      plan: initial,
      attempts: [],
      lineage: { parent: null, child: null },
      disabled: false,
      broken: false,
      canMarkNotCreated: false,
    } as unknown as DetailResponse);
    (ctx.api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: initial });

    renderDetail(ctx, "re-1");

    const continueButton = await vi.waitFor(() => {
      const button = ctx.root.querySelector<HTMLButtonElement>('button[data-focus-key="continue"]');
      expect(button?.disabled).toBe(true);
      return button!;
    });
    const reason = ctx.root.querySelector<HTMLElement>("#rt-continue-reason");
    expect(reason?.textContent).toContain("unavailable until you make the required choices");
    expect(continueButton.getAttribute("aria-describedby")).toBe("rt-continue-reason");
  });

  it("keeps a mutation single-flight and exposes its busy state", () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => undefined));
    renderConfirm(ctx, "re-1", plan(), source());

    const recreate = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate entry");
    recreate?.click();
    recreate?.click();

    expect(ctx.api.mutate).toHaveBeenCalledTimes(1);
    expect(recreate?.disabled).toBe(true);
    expect(recreate?.getAttribute("aria-busy")).toBe("true");
    expect(recreate?.textContent).toBe("Recreating…");
    expect(recreate?.getAttribute("aria-label")).toBe("Recreate entry");
  });

  it("keeps the confirm context and restores a safe action after a normal error", async () => {
    const ctx = stubCtx();
    (ctx.api.mutate as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(500, { error: "Clockify could not complete this request." }));
    renderConfirm(ctx, "re-1", plan(), source());

    const recreate = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate entry");
    recreate?.click();

    await vi.waitFor(() => expect(ctx.root.querySelector('[role="alert"]')?.textContent).toContain("Clockify could not complete this request."));
    expect(ctx.root.textContent).toContain("Confirm recreation");
    expect(recreate?.disabled).toBe(false);
    expect(recreate?.textContent).toBe("Recreate entry");
  });

  it("reloads an expired session only once", () => {
    const ctx = stubCtx();
    renderSessionExpired(ctx);
    const reload = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Reload RestoreTime");
    reload?.click();
    reload?.click();
    expect(ctx.reload).toHaveBeenCalledTimes(1);
    expect(reload?.disabled).toBe(true);
  });

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

  it("keeps the bulk-review return path when it checks a recreating entry", async () => {
    const ctx = stubCtx();
    (ctx.api.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      entry: { id: "re-1", lifecycleState: "RECREATING", source: source() },
      plan: null,
      attempts: [],
      lineage: { parent: null, child: null },
      disabled: false,
      broken: false,
      canMarkNotCreated: false,
    } as unknown as DetailResponse);

    renderDetail(ctx, "re-1", false, undefined, "bulk-review");
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("Recreating"));
    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Check status")?.click();

    await vi.waitFor(() => expect(ctx.api.get).toHaveBeenCalledTimes(2));
    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).toContain("Back to review");
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
    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Back to entry")?.click();
    resolveRequest?.({ result: { outcome: "RECREATED", newEntryId: "new-1", diffs: [] } });
    await Promise.resolve();

    expect(ctx.navigate).toHaveBeenCalledTimes(1);
    expect(ctx.navigate).toHaveBeenCalledWith({ kind: "detail", entryId: "re-1", forceResolve: true, returnTo: "list" });
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

  it("clears a saved bulk selection when the list becomes read-only", async () => {
    const ctx = stubCtx();
    ctx.session.list.bulkMode = true;
    ctx.session.selectedEntryIds.add("re-1");
    (ctx.api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => Promise.resolve(
      path === "/api/entries"
        ? {
            entries: [{
              id: "re-1",
              lifecycleState: "IDLE",
              detectedAt: "2026-08-07T12:00:00Z",
              source: source(),
              preflightSummary: null,
            }],
            disabled: false,
            broken: false,
            clockifyUnavailable: true,
            truncated: false,
            limit: 200,
          }
        : { items: [] },
    ));

    renderList(ctx);

    await vi.waitFor(() => expect(ctx.root.textContent).toContain("This list is read-only until you reload it."));
    expect(ctx.session.selectedEntryIds.size).toBe(0);
    expect(ctx.announce).toHaveBeenCalledWith("Selection cleared.");
    const review = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Review selected (0)");
    expect(review?.disabled).toBe(true);
    expect(ctx.api.post).not.toHaveBeenCalled();
  });

  it("shows a persistent selection summary and marks the selected row", async () => {
    const ctx = stubCtx();
    ctx.session.list.bulkMode = true;
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

    renderList(ctx);
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("API investigation"));
    const summary = ctx.root.querySelector(".rt-bulk-bar .rt-selection-summary");
    expect(summary?.textContent).toBe("0 entries selected (maximum 50).");

    const checkbox = ctx.root.querySelector<HTMLInputElement>('li input[type="checkbox"]');
    const item = checkbox?.closest("li");
    expect(item?.classList.contains("rt-entry--selected")).toBe(false);
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event("change"));
    expect(item?.classList.contains("rt-entry--selected")).toBe(true);
    expect(summary?.textContent).toBe("1 entry selected (maximum 50).");

    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change"));
    expect(item?.classList.contains("rt-entry--selected")).toBe(false);
    expect(summary?.textContent).toBe("0 entries selected (maximum 50).");
  });

  it("clears applied filters without touching the list options", async () => {
    const ctx = stubCtx();
    ctx.session.list.search = "investigation";
    ctx.session.list.projectName = "Legacy API";
    ctx.session.list.bulkMode = true;
    const queries: (Record<string, string> | undefined)[] = [];
    (ctx.api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string, query?: Record<string, string>) => {
      if (path === "/api/entries") {
        queries.push(query);
        return Promise.resolve({ entries: [], disabled: false, broken: false, clockifyUnavailable: false, truncated: false, limit: 200 });
      }
      return Promise.resolve({ items: [] });
    });

    renderList(ctx);
    await vi.waitFor(() => expect(ctx.root.textContent).toContain("No deleted time entries"));
    expect(queries[0]).toMatchObject({ search: "investigation", projectName: "Legacy API" });

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Clear filters")?.click();
    await vi.waitFor(() => expect(queries).toHaveLength(2));
    expect(queries[1] ?? {}).not.toHaveProperty("search");
    expect(queries[1] ?? {}).not.toHaveProperty("projectName");
    expect(ctx.session.list.bulkMode).toBe(true);
  });

  it("clears unsaved filter input without loading entries or clearing the current selection", async () => {
    const ctx = stubCtx();
    ctx.session.list.bulkMode = true;
    ctx.session.selectedEntryIds.add("re-1");
    let entryReads = 0;
    let optionReads = 0;
    (ctx.api.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/api/entries") {
        entryReads += 1;
        return Promise.resolve({ entries: [], disabled: false, broken: false, clockifyUnavailable: false, truncated: false, limit: 200 });
      }
      if (path === "/api/options") {
        optionReads += 1;
        return Promise.resolve({ items: [] });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    renderList(ctx);
    await vi.waitFor(() => expect(entryReads).toBe(1));
    await vi.waitFor(() => expect(optionReads).toBe(2));
    const userInput = ctx.root.querySelector<HTMLInputElement>('input[placeholder="User name"]');
    const searchInput = ctx.root.querySelector<HTMLInputElement>('input[placeholder="Search description"]');
    userInput!.value = "Ana";
    searchInput!.value = "investigation";

    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Clear filters")?.click();

    expect(userInput?.value).toBe("");
    expect(searchInput?.value).toBe("");
    expect(entryReads).toBe(1);
    expect(optionReads).toBe(2);
    expect(ctx.session.list.bulkMode).toBe(true);
    expect(ctx.session.list.dismissed).toBe(false);
    expect(ctx.session.selectedEntryIds).toEqual(new Set(["re-1"]));
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
    }, undefined, "Reload list");
    void withLoading(ctx, () => second, (value) => {
      ctx.root.textContent = value;
    }, undefined, "Reload list");
    finishSecond?.("new response");
    await vi.waitFor(() => expect(ctx.root.textContent).toBe("new response"));
    finishFirst?.("old response");
    await Promise.resolve();

    expect(ctx.root.textContent).toBe("new response");
  });
});

describe("bulk result view (docs/10 §7)", () => {
  it("renders a post-attempt error as Result uncertain with its truthful message", () => {
    const ctx = stubCtx();
    const message =
      "The recreation might have reached Clockify, but RestoreTime did not get a clear result. It is not known whether the entry was created.";
    const rows: BulkRecreateRow[] = [
      { entryId: "re-1", planId: "plan-1", outcome: "AMBIGUOUS", message },
    ];

    const reviewed: BulkPreflightRow = { entryId: "re-1", status: "ready", source: source(), plan: plan() };
    renderBulkResults(ctx, rows, [reviewed]);

    expect(ctx.root.textContent).toContain("Result uncertain");
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

describe("bulk review view (docs/10 §7)", () => {
  it("gives no-resolution guidance only when selected rows need it", () => {
    const ctx = stubCtx();
    const ready: BulkPreflightRow = { entryId: "re-1", status: "ready", source: source(), plan: plan() };
    ctx.session.selectedEntryIds.add(ready.entryId);

    renderBulkReview(ctx, [ready]);

    const checkbox = ctx.root.querySelector<HTMLInputElement>('li input[type="checkbox"]');
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change"));

    const recreate = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 0 entries");
    const summary = ctx.root.querySelector(".rt-selection-summary")?.textContent ?? "";
    expect(ctx.session.selectedEntryIds.size).toBe(0);
    expect(summary).toBe("No entries are selected. Select one or more ready entries to recreate.");
    expect(summary).not.toContain("resolve");
    expect(summary).not.toContain("needs input");
    expect(recreate?.disabled).toBe(true);
    expect(recreate?.classList.contains("rt-primary")).toBe(false);
  });

  it("keeps a zero-ready review readable without making the disabled action dominant", () => {
    const ctx = stubCtx();
    ctx.session.selectedEntryIds.add("re-1");
    renderBulkReview(ctx, [{ entryId: "re-1", status: "needs-review", source: source(), message: "Open this entry and review its changes." }]);

    const recreate = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 0 entries");
    expect(recreate?.disabled).toBe(true);
    expect(recreate?.classList.contains("rt-primary")).toBe(false);
    expect(ctx.root.querySelector(".rt-selection-summary")?.textContent).toBe(
      "No selected entries are ready to recreate. Open each selected entry that needs input or review. Resolve it, then return. The review refreshes when you return.",
    );
    expect(Array.from(ctx.root.querySelectorAll("button")).map((button) => button.textContent)).toContain("Open");
  });

  it("summarizes the ready selection, tones each row, and unmarks an unchecked row", () => {
    const ctx = stubCtx();
    const ready: BulkPreflightRow = { entryId: "re-1", status: "ready", source: source(), plan: plan() };
    const needsReview: BulkPreflightRow = { entryId: "re-2", status: "needs-review", source: source({ description: "Second entry" }) };
    ctx.session.selectedEntryIds.add("re-1");
    ctx.session.selectedEntryIds.add("re-2");

    renderBulkReview(ctx, [ready, needsReview]);

    expect(ctx.root.querySelector(".rt-selection-summary")?.textContent).toBe("1 of 2 selected entries are ready to recreate.");
    const items = Array.from(ctx.root.querySelectorAll("li"));
    expect(items.some((item) => item.classList.contains("rt-review-row--success"))).toBe(true);
    expect(items.some((item) => item.classList.contains("rt-review-row--warning"))).toBe(true);

    const recreate = Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 1 entry");
    expect(recreate?.classList.contains("rt-primary")).toBe(true);

    const checkbox = ctx.root.querySelector<HTMLInputElement>('li input[type="checkbox"]');
    const readyItem = checkbox?.closest("li");
    expect(readyItem?.classList.contains("rt-review-row--selected")).toBe(true);
    checkbox!.checked = false;
    checkbox!.dispatchEvent(new Event("change"));
    expect(readyItem?.classList.contains("rt-review-row--selected")).toBe(false);
    expect(recreate?.classList.contains("rt-primary")).toBe(false);
    expect(ctx.root.querySelector(".rt-selection-summary")?.textContent).toContain("No selected entries are ready to recreate.");
  });

  it("keeps the ready summary aligned with 50 current selections", () => {
    const ctx = stubCtx();
    const rows = Array.from({ length: 50 }, (_, index): BulkPreflightRow => {
      const entryId = `re-${index + 1}`;
      ctx.session.selectedEntryIds.add(entryId);
      return {
        entryId,
        status: "ready",
        source: source({ entryId: `entry-${index + 1}` }),
        plan: plan({ id: `plan-${index + 1}`, recoverableEntryId: entryId }),
      };
    });

    renderBulkReview(ctx, rows);

    const checkboxes = Array.from(ctx.root.querySelectorAll<HTMLInputElement>('li input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(50);
    expect(Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 50 entries")).toBeDefined();
    expect(ctx.root.querySelector(".rt-selection-summary")?.textContent).toBe("50 of 50 selected entries are ready to recreate.");

    checkboxes[0]!.checked = false;
    checkboxes[0]!.dispatchEvent(new Event("change"));

    expect(ctx.session.selectedEntryIds.size).toBe(49);
    expect(Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Recreate 49 entries")).toBeDefined();
    expect(ctx.root.querySelector(".rt-selection-summary")?.textContent).toBe("49 of 49 selected entries are ready to recreate.");
  });
});

describe("resolved plan values", () => {
  it("keeps saved project, task, and tags editable after Confirm then Back", async () => {
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
    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Back to entry")?.click();
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

    await vi.waitFor(() => expect(ctx.root.textContent).toContain("Customer API"));
    expect(ctx.root.textContent).toContain("Investigation");
    expect(ctx.root.textContent).toContain("urgent");
    await vi.waitFor(() => expect(ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Replacement project"]')?.value).toBe("proj-new"));
    expect(ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Replacement task"]')?.value).toBe("task-new");
    expect(ctx.root.textContent).toContain("Add current tags");
    Array.from(ctx.root.querySelectorAll("button")).find((button) => button.textContent === "Continue to confirm")?.click();
    const confirmState = vi.mocked(ctx.navigate).mock.calls.at(-1)?.[0];
    if (confirmState?.kind !== "confirm") throw new Error("Continue did not navigate to confirm.");
    expect(confirmState.draft?.actionRequired).toEqual(editable);
  });

  it("shows the persisted planned values after reviewing a new plan", async () => {
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

    await vi.waitFor(() => expect(ctx.root.textContent).toContain("Customer API"));
    await vi.waitFor(() => expect(ctx.root.querySelector<HTMLSelectElement>('select[aria-label="Replacement project"]')?.value).toBe("proj-new"));
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
    expect(ctx.root.textContent).toContain("could not re-read it to verify every saved value");
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
