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
import { renderResolutionWidgets, type MutableChoices } from "../../src/ui/views/resolution-widgets.js";
import type { Ctx } from "../../src/ui/state.js";
import type { ActionRequiredItem, DeletedTimeEntry, RecreationPlan } from "../../src/ui/types.js";

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
