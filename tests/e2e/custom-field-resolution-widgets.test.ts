// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderResolutionWidgets, type MutableChoices } from "../../src/ui/views/resolution-widgets.js";
import type { Ctx } from "../../src/ui/state.js";
import type { ActionRequiredItem, CustomFieldOption, DeletedTimeEntry } from "../../src/ui/types.js";

const FIELDS: readonly CustomFieldOption[] = [
  { id: "cf-single", name: "Priority", type: "DROPDOWN_SINGLE", allowedValues: ["Low", "High"], required: true },
  { id: "cf-multiple", name: "Regions", type: "DROPDOWN_MULTIPLE", allowedValues: ["North", "South"], required: true },
  { id: "cf-stale-multiple", name: "Teams", type: "DROPDOWN_MULTIPLE", allowedValues: ["Platform", "Support"], required: false },
  { id: "cf-checkbox", name: "Approved", type: "CHECKBOX", allowedValues: null, required: true },
];

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
    customFieldValues: [{ customFieldId: "cf-stale-multiple", name: "Teams", value: ["Legacy"] }],
  };
}

function stubCtx() {
  const get = vi.fn().mockResolvedValue({ items: FIELDS });
  const root = document.createElement("main");
  document.body.appendChild(root);
  const ctx: Ctx = {
    root,
    api: { get, post: vi.fn() } as unknown as Ctx["api"],
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole: true,
    navigate: vi.fn(),
  };
  return { ctx, get };
}

function action(ruleId: "P-CF-REQ" | "P-CF-OPT", refId: string, message: string): ActionRequiredItem {
  return { ruleId, refId, message };
}

function itemNode(root: HTMLElement, message: string): HTMLElement {
  const node = Array.from(root.querySelectorAll<HTMLElement>("fieldset > div")).find((candidate) => candidate.textContent?.includes(message));
  if (!node) throw new Error(`Custom-field widget not found: ${message}`);
  return node;
}

async function waitForSelect(node: HTMLElement): Promise<HTMLSelectElement> {
  await vi.waitFor(() => expect(node.querySelector("select")).not.toBeNull());
  return node.querySelector("select") as HTMLSelectElement;
}

function clickButton(node: HTMLElement, label: string): void {
  const button = Array.from(node.querySelectorAll("button")).find((candidate) => candidate.textContent === label);
  if (!button) throw new Error(`Button not found: ${label}`);
  button.click();
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("custom-field resolution widgets", () => {
  it("uses current options for a required single dropdown and submits one string", async () => {
    const { ctx } = stubCtx();
    const choices: MutableChoices = {};
    const message = "Priority is required.";
    const rendered = renderResolutionWidgets(ctx, choices, vi.fn(), [action("P-CF-REQ", "cf-single", message)], null, source());
    const node = itemNode(rendered, message);
    const select = await waitForSelect(node);

    expect(select.multiple).toBe(false);
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "Low", "High"]);
    select.value = "High";
    clickButton(node, "Save value");

    expect(choices.customFieldInputs).toEqual([{ customFieldId: "cf-single", value: "High" }]);
  });

  it("uses current options for a required multiple dropdown and submits a string array", async () => {
    const { ctx } = stubCtx();
    const choices: MutableChoices = {};
    const message = "Regions is required.";
    const rendered = renderResolutionWidgets(ctx, choices, vi.fn(), [action("P-CF-REQ", "cf-multiple", message)], null, source());
    const node = itemNode(rendered, message);
    const select = await waitForSelect(node);

    expect(select.multiple).toBe(true);
    select.options[0]!.selected = true;
    select.options[1]!.selected = true;
    clickButton(node, "Save values");

    expect(choices.customFieldInputs).toEqual([{ customFieldId: "cf-multiple", value: ["North", "South"] }]);
  });

  it("submits a boolean for a required checkbox", async () => {
    const { ctx } = stubCtx();
    const choices: MutableChoices = {};
    const message = "Approved is required.";
    const rendered = renderResolutionWidgets(ctx, choices, vi.fn(), [action("P-CF-REQ", "cf-checkbox", message)], null, source());
    const node = itemNode(rendered, message);
    const select = await waitForSelect(node);

    expect(Array.from(select.options).map((option) => [option.value, option.textContent])).toEqual([
      ["", "Choose a value…"],
      ["true", "Checked"],
      ["false", "Not checked"],
    ]);
    select.value = "false";
    clickButton(node, "Save value");

    expect(choices.customFieldInputs).toEqual([{ customFieldId: "cf-checkbox", value: false }]);
  });

  it("keeps explicit keep and drop actions for a stale multiple dropdown and accepts several replacement values", async () => {
    const { ctx } = stubCtx();
    const choices: MutableChoices = {};
    const message = "Teams has a stale value.";
    const rendered = renderResolutionWidgets(ctx, choices, vi.fn(), [action("P-CF-OPT", "cf-stale-multiple", message)], null, source());
    const node = itemNode(rendered, message);
    const select = await waitForSelect(node);

    expect(select.multiple).toBe(true);
    expect(Array.from(node.querySelectorAll("button")).map((button) => button.textContent)).toEqual([
      "Use selected values",
      "Keep the original value",
      "Drop this value",
    ]);
    select.options[0]!.selected = true;
    select.options[1]!.selected = true;
    clickButton(node, "Use selected values");

    expect(choices.customFieldInputs).toEqual([{ customFieldId: "cf-stale-multiple", value: ["Platform", "Support"] }]);
    expect(choices.dropCustomFieldIds).toEqual([]);

    clickButton(node, "Keep the original value");
    expect(choices.customFieldInputs).toEqual([{ customFieldId: "cf-stale-multiple", value: ["Legacy"] }]);
    expect(choices.dropCustomFieldIds).toEqual([]);

    clickButton(node, "Drop this value");
    expect(choices.customFieldInputs).toEqual([]);
    expect(choices.dropCustomFieldIds).toEqual(["cf-stale-multiple"]);
  });

  it("loads current custom-field settings once for several items in one render", () => {
    const { ctx, get } = stubCtx();
    renderResolutionWidgets(
      ctx,
      {},
      vi.fn(),
      [
        action("P-CF-REQ", "cf-single", "Priority is required."),
        action("P-CF-REQ", "cf-multiple", "Regions is required."),
        action("P-CF-OPT", "cf-stale-multiple", "Teams has a stale value."),
      ],
      null,
      source(),
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/options", { kind: "customFields" });
  });
});
