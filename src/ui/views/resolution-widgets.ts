// Resolution widgets (docs/10 §4). Every widget mutates a shared, mutable `PreflightChoices`
// object and calls `reflow()`, which re-runs `POST /api/entries/preflight` with the updated
// choices and re-renders the detail view from the response (docs/07 §4 "Every selection re-runs
// preflight"). No widget decides what is valid, missing, or required — that is entirely the set of
// `ActionRequiredItem`s the server returned; a widget only exists because one of those items named
// its `ruleId`.

import { el } from "../dom.js";
import type { Ctx } from "../state.js";
import type { ActionRequiredItem, CustomFieldOption, DeletedTimeEntry, OptionItem, PreflightChoices } from "../types.js";

export type MutableChoices = {
  projectId?: string | null;
  taskId?: string | null;
  dropTagIds?: string[];
  addTagIds?: string[];
  description?: string;
  runningMode?: "running" | "completed";
  completedEnd?: string;
  customFieldInputs?: { customFieldId: string; value: unknown }[];
  dropCustomFieldIds?: string[];
};

export function toPreflightChoices(choices: MutableChoices): PreflightChoices {
  return { ...choices };
}

function itemsFor(items: readonly ActionRequiredItem[], ruleId: string): ActionRequiredItem[] {
  return items.filter((i) => i.ruleId === ruleId);
}

/** P-RUN / P-RUN-END: running-timer disposition (docs/10 §4 "Running entry"). */
function renderRunningWidget(choices: MutableChoices, reflow: () => void, items: readonly ActionRequiredItem[]): HTMLElement | null {
  const runItem = itemsFor(items, "P-RUN")[0];
  const endItem = itemsFor(items, "P-RUN-END")[0];
  if (!runItem && !endItem) return null;

  const container = el("fieldset", {}, el("legend", {}, "This entry was running when it was deleted"));
  if (runItem) {
    container.append(el("p", {}, runItem.message));
    const name = "running-mode";
    const runningRadio = el("input", { type: "radio", name });
    runningRadio.checked = choices.runningMode === "running";
    runningRadio.addEventListener("change", () => {
      choices.runningMode = "running";
      delete choices.completedEnd;
      reflow();
    });
    const completedRadio = el("input", { type: "radio", name });
    completedRadio.checked = choices.runningMode === "completed";
    completedRadio.addEventListener("change", () => {
      choices.runningMode = "completed";
      reflow();
    });
    container.append(
      el("label", {}, runningRadio, " Start a running timer (start time as recorded, no end)"),
      el("label", {}, completedRadio, " Set an end time"),
    );
  }
  if (choices.runningMode === "completed") {
    const endInput = el("input", { type: "datetime-local" });
    endInput.addEventListener("change", () => {
      if (endInput.value) {
        choices.completedEnd = new Date(endInput.value).toISOString();
        reflow();
      }
    });
    container.append(el("label", {}, "End time", endInput));
    if (endItem) container.append(el("p", { role: "alert" }, endItem.message));
  }
  return container;
}

async function fetchOptions(ctx: Ctx, kind: string, extra: Record<string, string> = {}): Promise<OptionItem[]> {
  const res = (await ctx.api.get("/api/options", { kind, ...extra })) as { items: OptionItem[] };
  return res.items;
}

/** P-PROJ-GONE / P-PROJ-REQ: replacement project picker. */
function renderProjectWidget(ctx: Ctx, choices: MutableChoices, reflow: () => void, items: readonly ActionRequiredItem[]): HTMLElement | null {
  const item = itemsFor(items, "P-PROJ-GONE")[0] ?? itemsFor(items, "P-PROJ-REQ")[0];
  if (!item) return null;
  const canRemove = (item.options ?? []).includes("remove");

  const select = el("select", {}, el("option", { value: "" }, "Choose a project…"));
  if (canRemove) select.append(el("option", { value: "__none__" }, "No project"));
  select.addEventListener("change", () => {
    if (select.value === "") return;
    choices.projectId = select.value === "__none__" ? null : select.value;
    reflow();
  });
  fetchOptions(ctx, "projects")
    .then((projects) => {
      for (const p of projects) select.append(el("option", { value: p.id }, p.name));
    })
    .catch(() => {
      /* The select stays usable with just its two fixed options; the next preflight call still
       * reports the same ACTION_REQUIRED item if nothing was picked. */
    });

  return el("fieldset", {}, el("legend", {}, "Project"), el("p", {}, item.message), select);
}

/** P-TASK-GONE: replacement task picker, scoped to the effective project. */
function renderTaskWidget(
  ctx: Ctx,
  choices: MutableChoices,
  reflow: () => void,
  items: readonly ActionRequiredItem[],
  effectiveProjectId: string | null,
): HTMLElement | null {
  const item = itemsFor(items, "P-TASK-GONE")[0];
  if (!item || effectiveProjectId === null) return null;
  const canRemove = (item.options ?? []).includes("remove");

  const select = el("select", {}, el("option", { value: "" }, "Choose a task…"));
  if (canRemove) select.append(el("option", { value: "__none__" }, "No task"));
  select.addEventListener("change", () => {
    if (select.value === "") return;
    choices.taskId = select.value === "__none__" ? null : select.value;
    reflow();
  });
  fetchOptions(ctx, "tasks", { projectId: effectiveProjectId })
    .then((tasks) => {
      for (const t of tasks) select.append(el("option", { value: t.id }, t.name));
    })
    .catch(() => undefined);

  return el("fieldset", {}, el("legend", {}, "Task"), el("p", {}, item.message), select);
}

/** P-TAG-GONE / P-TAG-ARCH / P-TAG-REQ: one checkbox per missing/archived tag, plus a multi-select
 * of current tags to add. */
function renderTagsWidget(ctx: Ctx, choices: MutableChoices, reflow: () => void, items: readonly ActionRequiredItem[]): HTMLElement | null {
  const removable = [...itemsFor(items, "P-TAG-GONE"), ...itemsFor(items, "P-TAG-ARCH")];
  const reqItem = itemsFor(items, "P-TAG-REQ")[0];
  if (removable.length === 0 && !reqItem) return null;

  const container = el("fieldset", {}, el("legend", {}, "Tags"));
  for (const item of removable) {
    if (!item.refId) continue;
    const refId = item.refId;
    const checkbox = el("input", { type: "checkbox" });
    checkbox.checked = (choices.dropTagIds ?? []).includes(refId);
    checkbox.addEventListener("change", () => {
      const set = new Set(choices.dropTagIds ?? []);
      if (checkbox.checked) set.add(refId);
      else set.delete(refId);
      choices.dropTagIds = [...set];
      reflow();
    });
    container.append(el("div", {}, el("label", {}, checkbox, " ", item.message)));
  }

  if (reqItem) container.append(el("p", {}, reqItem.message));

  const addSelect = el("select", { multiple: "multiple" });
  addSelect.addEventListener("change", () => {
    choices.addTagIds = Array.from(addSelect.selectedOptions).map((o) => o.value);
    reflow();
  });
  fetchOptions(ctx, "tags")
    .then((tags) => {
      for (const t of tags) {
        const option = el("option", { value: t.id }, t.name);
        if ((choices.addTagIds ?? []).includes(t.id)) option.selected = true;
        addSelect.append(option);
      }
    })
    .catch(() => undefined);
  container.append(el("label", {}, "Add current tags", addSelect));

  return container;
}

/** P-DESC: a description is required and the effective one is empty. */
function renderDescriptionWidget(choices: MutableChoices, reflow: () => void, items: readonly ActionRequiredItem[]): HTMLElement | null {
  const item = itemsFor(items, "P-DESC")[0];
  if (!item) return null;
  const input = el("input", { type: "text", value: choices.description ?? "" });
  const save = el("button", { type: "button" }, "Save description");
  save.addEventListener("click", () => {
    choices.description = input.value;
    reflow();
  });
  return el("fieldset", {}, el("legend", {}, "Description"), el("p", {}, item.message), input, save);
}

/** P-CF-OPT / P-CF-REQ: per-custom-field resolution. Needs the field's current type/allowed values
 * (fetched via `kind=customFields`, matched by the item's `refId`) to know whether to render a
 * dropdown, a number input, or a text input. */
function renderCustomFieldItem(
  ctx: Ctx,
  choices: MutableChoices,
  reflow: () => void,
  item: ActionRequiredItem,
  source: DeletedTimeEntry,
): HTMLElement | null {
  const refId = item.refId;
  if (!refId) return null;
  const container = el("div", {}, el("p", {}, item.message));

  if (item.ruleId === "P-CF-OPT") {
    const select = el(
      "select",
      {},
      el("option", { value: "" }, "Choose…"),
      el("option", { value: "__keep__" }, "Keep the original value"),
      el("option", { value: "__drop__" }, "Drop this value"),
    );
    select.addEventListener("change", () => {
      if (select.value === "") return;
      choices.dropCustomFieldIds = (choices.dropCustomFieldIds ?? []).filter((id) => id !== refId);
      choices.customFieldInputs = (choices.customFieldInputs ?? []).filter((c) => c.customFieldId !== refId);
      if (select.value === "__drop__") {
        choices.dropCustomFieldIds = [...(choices.dropCustomFieldIds ?? []), refId];
      } else if (select.value === "__keep__") {
        const sourceValue = source.customFieldValues.find((v) => v.customFieldId === refId)?.value ?? null;
        choices.customFieldInputs = [...(choices.customFieldInputs ?? []), { customFieldId: refId, value: sourceValue }];
      } else {
        choices.customFieldInputs = [...(choices.customFieldInputs ?? []), { customFieldId: refId, value: select.value }];
      }
      reflow();
    });
    fetchOptions(ctx, "customFields")
      .then((fields) => {
        const field = (fields as unknown as CustomFieldOption[]).find((f) => f.id === refId);
        for (const value of field?.allowedValues ?? []) {
          select.insertBefore(el("option", { value }, value), select.children[1] ?? null);
        }
      })
      .catch(() => undefined);
    container.append(select);
    return container;
  }

  // P-CF-REQ: text or number input, depending on the field's type.
  const input = el("input", { type: "text" });
  fetchOptions(ctx, "customFields")
    .then((fields) => {
      const field = (fields as unknown as CustomFieldOption[]).find((f) => f.id === refId);
      if (field?.type === "NUMBER") input.setAttribute("type", "number");
    })
    .catch(() => undefined);
  const save = el("button", { type: "button" }, "Save value");
  save.addEventListener("click", () => {
    if (input.value === "") return;
    choices.customFieldInputs = [...(choices.customFieldInputs ?? []).filter((c) => c.customFieldId !== refId), { customFieldId: refId, value: input.value }];
    reflow();
  });
  container.append(input, save);
  return container;
}

function renderCustomFieldsWidget(
  ctx: Ctx,
  choices: MutableChoices,
  reflow: () => void,
  items: readonly ActionRequiredItem[],
  source: DeletedTimeEntry,
): HTMLElement | null {
  const cfItems = [...itemsFor(items, "P-CF-OPT"), ...itemsFor(items, "P-CF-REQ")];
  if (cfItems.length === 0) return null;
  const container = el("fieldset", {}, el("legend", {}, "Custom fields"));
  for (const item of cfItems) {
    const node = renderCustomFieldItem(ctx, choices, reflow, item, source);
    if (node) container.append(node);
  }
  return container;
}

export function renderResolutionWidgets(
  ctx: Ctx,
  choices: MutableChoices,
  reflow: () => void,
  actionRequired: readonly ActionRequiredItem[],
  effectiveProjectId: string | null,
  source: DeletedTimeEntry,
): HTMLElement {
  const widgets = [
    renderRunningWidget(choices, reflow, actionRequired),
    renderProjectWidget(ctx, choices, reflow, actionRequired),
    renderTaskWidget(ctx, choices, reflow, actionRequired, effectiveProjectId),
    renderTagsWidget(ctx, choices, reflow, actionRequired),
    renderDescriptionWidget(choices, reflow, actionRequired),
    renderCustomFieldsWidget(ctx, choices, reflow, actionRequired, source),
  ].filter((w): w is HTMLElement => w !== null);
  return el("section", { "aria-label": "Needs your input" }, el("h3", {}, "Needs your input"), ...widgets);
}
