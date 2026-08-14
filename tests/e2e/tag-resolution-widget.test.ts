// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUiSessionState, type Ctx } from "../../src/ui/state.js";
import type { ActionRequiredItem, DeletedTimeEntry } from "../../src/ui/types.js";
import { renderResolutionWidgets, type MutableChoices } from "../../src/ui/views/resolution-widgets.js";

function source(): DeletedTimeEntry {
  return {
    workspaceId: "ws-1",
    entryId: "entry-1",
    ownerId: "user-1",
    ownerName: "Ana Markovic",
    description: "Investigation",
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
    api: { get: vi.fn().mockResolvedValue({ items: [{ id: "tag-current", name: "Current tag" }] }), post: vi.fn() } as unknown as Ctx["api"],
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole: false,
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

describe("replacement tag resolution", () => {
  it("removes a stale replacement from addTagIds instead of adding it to dropTagIds", () => {
    const ctx = stubCtx();
    const choices: MutableChoices = { addTagIds: ["tag-archived", "tag-current"] };
    const reflow = vi.fn();
    const issue: ActionRequiredItem = {
      ruleId: "P-TAG-ARCH",
      refId: "tag-archived",
      message: "The selected replacement tag is archived. Select a current tag.",
    };

    const rendered = renderResolutionWidgets(ctx, choices, reflow, [issue], null, source());
    const remove = Array.from(rendered.querySelectorAll("button")).find((button) => button.textContent === "Remove this replacement tag");

    expect(remove).toBeDefined();
    remove?.click();
    expect(choices.addTagIds).toEqual(["tag-current"]);
    expect(choices.dropTagIds).toBeUndefined();
    expect(reflow).toHaveBeenCalledTimes(1);
  });
});
