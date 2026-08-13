// Resolution widgets (docs/10 §4). Every widget mutates a shared, mutable `PreflightChoices`
// object and calls `reflow()`, which re-runs `POST /api/entries/preflight` with the updated
// choices and re-renders the detail view from the response (docs/07 §4 "Every selection re-runs
// preflight"). No widget decides what is valid, missing, or required — that is entirely the set of
// `ActionRequiredItem`s the server returned; a widget only exists because one of those items named
// its `ruleId`.

import { el } from "../dom.js";
import { formatTime } from "../format.js";
import type { ChoiceLabels, Ctx } from "../state.js";
import type { ActionRequiredItem, CustomFieldOption, DeletedTimeEntry, OptionItem, PreflightChoices } from "../types.js";
import { runBackgroundRequest } from "./shared.js";

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
function renderRunningWidget(
  choices: MutableChoices,
  reflow: () => void,
  items: readonly ActionRequiredItem[],
  source: DeletedTimeEntry,
  locale: string,
): HTMLElement | null {
  const endItem = itemsFor(items, "P-RUN-END")[0];
  // The radios exist because the SOURCE was running, not because P-RUN is currently open. P-RUN
  // stops firing the moment `runningMode` is set (docs/07 §3), so keying the radios on the item
  // made the first click permanent — a user who mis-clicked "Set an end time" could never get
  // back to "Start a running timer" for that entry. docs/10 §4 specifies a persistent pair.
  if (!source.wasRunning) return null;

  const container = el("fieldset", {}, el("legend", {}, "This entry was running when it was deleted"));
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
    // docs/10 §4 names the start time in the label and states the single-timer consequence.
    el("label", {}, runningRadio, ` Start a running timer (start time ${formatTime(source.start, locale)}, no end)`),
    el("label", {}, completedRadio, " Set an end time"),
    el(
      "p",
      {},
      "Clockify allows one running timer per user. Starting this timer stops the timer that is running now.",
    ),
  );
  if (choices.runningMode === "completed") {
    const endDate = choices.completedEnd ? new Date(choices.completedEnd) : null;
    const localEnd = endDate
      ? new Date(endDate.getTime() - endDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
      : "";
    const endInput = el("input", { type: "datetime-local", value: localEnd });
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

async function fetchOptions<T extends OptionItem = OptionItem>(ctx: Ctx, kind: string, extra: Record<string, string> = {}): Promise<T[]> {
  const res = (await ctx.api.get("/api/options", { kind, ...extra })) as { items: T[] };
  return res.items;
}

/** P-PROJ-GONE / P-PROJ-REQ: replacement project picker. */
function renderProjectWidget(
  ctx: Ctx,
  choices: MutableChoices,
  labels: ChoiceLabels,
  reflow: () => void,
  items: readonly ActionRequiredItem[],
): HTMLElement | null {
  const item = itemsFor(items, "P-PROJ-GONE")[0] ?? itemsFor(items, "P-PROJ-REQ")[0];
  if (!item) return null;
  const canRemove = (item.options ?? []).includes("remove");

  const select = el("select", { "aria-label": "Replacement project" }, el("option", { value: "" }, "Choose a project…"));
  if (canRemove) select.append(el("option", { value: "__none__" }, "No project"));
  select.addEventListener("change", () => {
    if (select.value === "") return;
    choices.projectId = select.value === "__none__" ? null : select.value;
    labels.project = select.value === "__none__" ? null : { id: select.value, name: select.selectedOptions[0]?.textContent ?? select.value };
    delete choices.taskId;
    delete labels.task;
    reflow();
  });
  void runBackgroundRequest(
    ctx,
    () => fetchOptions(ctx, "projects"),
    (projects) => {
      for (const p of projects) {
        select.append(el("option", { value: p.id }, p.name));
      }
      if (choices.projectId === null && canRemove) select.value = "__none__";
      else if (typeof choices.projectId === "string") select.value = choices.projectId;
    },
    () => {
      /* The select stays usable with just its two fixed options; the next preflight call still
       * reports the same ACTION_REQUIRED item if nothing was picked. */
    },
  );

  return el("fieldset", {}, el("legend", {}, "Project"), el("p", {}, item.message), select);
}

/** P-TASK-GONE: replacement task picker, scoped to the effective project. */
function renderTaskWidget(
  ctx: Ctx,
  choices: MutableChoices,
  labels: ChoiceLabels,
  reflow: () => void,
  items: readonly ActionRequiredItem[],
  effectiveProjectId: string | null,
): HTMLElement | null {
  const item = itemsFor(items, "P-TASK-GONE")[0];
  if (!item || effectiveProjectId === null) return null;
  const canRemove = (item.options ?? []).includes("remove");

  const select = el("select", { "aria-label": "Replacement task" }, el("option", { value: "" }, "Choose a task…"));
  if (canRemove) select.append(el("option", { value: "__none__" }, "No task"));
  select.addEventListener("change", () => {
    if (select.value === "") return;
    choices.taskId = select.value === "__none__" ? null : select.value;
    labels.task = select.value === "__none__" ? null : { id: select.value, name: select.selectedOptions[0]?.textContent ?? select.value };
    reflow();
  });
  void runBackgroundRequest(
    ctx,
    () => fetchOptions(ctx, "tasks", { projectId: effectiveProjectId }),
    (tasks) => {
      for (const t of tasks) {
        select.append(el("option", { value: t.id }, t.name));
      }
      if (choices.taskId === null && canRemove) select.value = "__none__";
      else if (typeof choices.taskId === "string") select.value = choices.taskId;
    },
  );

  return el("fieldset", {}, el("legend", {}, "Task"), el("p", {}, item.message), select);
}

/** P-TAG-GONE / P-TAG-ARCH / P-TAG-REQ: one checkbox per missing/archived tag, plus a multi-select
 * of current tags to add. */
function renderTagsWidget(
  ctx: Ctx,
  choices: MutableChoices,
  labels: ChoiceLabels,
  reflow: () => void,
  items: readonly ActionRequiredItem[],
): HTMLElement | null {
  const removable = [...itemsFor(items, "P-TAG-GONE"), ...itemsFor(items, "P-TAG-ARCH")];
  const reqItem = itemsFor(items, "P-TAG-REQ")[0];
  if (removable.length === 0 && !reqItem) return null;

  const container = el("fieldset", {}, el("legend", {}, "Tags"));
  for (const item of removable) {
    if (!item.refId) continue;
    const refId = item.refId;
    if (!(item.options ?? []).includes("remove")) {
      const remove = el("button", { type: "button" }, "Remove this replacement tag");
      remove.addEventListener("click", () => {
        choices.addTagIds = (choices.addTagIds ?? []).filter((id) => id !== refId);
        reflow();
      });
      container.append(el("div", {}, el("p", {}, item.message), remove));
      continue;
    }
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

  const addSelect = el("select", { multiple: "multiple", "aria-label": "Current tags to add" });
  addSelect.addEventListener("change", () => {
    const selected = Array.from(addSelect.options).filter((option) => option.selected);
    choices.addTagIds = selected.map((option) => option.value);
    labels.tags = Object.fromEntries(selected.map((option) => [option.value, option.textContent ?? option.value]));
    reflow();
  });
  void runBackgroundRequest(
    ctx,
    () => fetchOptions(ctx, "tags"),
    (tags) => {
      for (const t of tags) {
        addSelect.append(el("option", { value: t.id }, t.name));
      }
      const selectedIds = new Set(choices.addTagIds ?? []);
      for (const option of Array.from(addSelect.options)) {
        option.selected = selectedIds.has(option.value);
      }
    },
  );
  container.append(el("label", {}, "Add current tags", addSelect));

  return container;
}

/** P-DESC: a description is required and the effective one is empty. */
function renderDescriptionWidget(choices: MutableChoices, reflow: () => void, items: readonly ActionRequiredItem[]): HTMLElement | null {
  const item = itemsFor(items, "P-DESC")[0];
  if (!item) return null;
  const input = el("input", { type: "text", value: choices.description ?? "", "aria-label": "Description" });
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
  labels: ChoiceLabels,
  reflow: () => void,
  item: ActionRequiredItem,
  source: DeletedTimeEntry,
  fieldsPromise: Promise<readonly CustomFieldOption[]>,
): HTMLElement | null {
  const refId = item.refId;
  if (!refId) return null;
  const container = el("div", {}, el("p", {}, item.message));

  const setInput = (value: unknown): void => {
    choices.dropCustomFieldIds = (choices.dropCustomFieldIds ?? []).filter((id) => id !== refId);
    choices.customFieldInputs = [
      ...(choices.customFieldInputs ?? []).filter((candidate) => candidate.customFieldId !== refId),
      { customFieldId: refId, value },
    ];
    reflow();
  };

  const dropValue = (): void => {
    choices.customFieldInputs = (choices.customFieldInputs ?? []).filter((candidate) => candidate.customFieldId !== refId);
    choices.dropCustomFieldIds = [...new Set([...(choices.dropCustomFieldIds ?? []), refId])];
    reflow();
  };

  const savedInput = choices.customFieldInputs?.find((candidate) => candidate.customFieldId === refId)?.value;
  if ((choices.dropCustomFieldIds ?? []).includes(refId)) {
    container.append(el("p", { role: "status" }, "This value will not be sent."));
  } else if (savedInput !== undefined) {
    const sourceValue = source.customFieldValues.find((candidate) => candidate.customFieldId === refId)?.value;
    const sameAsSource = JSON.stringify(savedInput) === JSON.stringify(sourceValue);
    container.append(el("p", { role: "status" }, sameAsSource ? "The original value will be sent." : `Selected value: ${JSON.stringify(savedInput)}`));
  }

  const unavailable = (): HTMLParagraphElement =>
    el("p", { role: "alert" }, "Current field settings are not available. Reload the page and try again.");

  if (item.ruleId === "P-CF-OPT") {
    const replacement = el("div", {}, el("p", {}, "Loading current field settings…"));
    const keep = el("button", { type: "button" }, "Keep the original value");
    keep.addEventListener("click", () => {
      const value = source.customFieldValues.find((candidate) => candidate.customFieldId === refId)?.value ?? null;
      setInput(value);
    });
    const drop = el("button", { type: "button" }, "Drop this value");
    drop.addEventListener("click", dropValue);
    void runBackgroundRequest(
      ctx,
      () => fieldsPromise,
      (fields) => {
        const field = fields.find((candidate) => candidate.id === refId);
        if (!field) {
          replacement.replaceChildren(unavailable());
          return;
        }
        labels.customFields[refId] = field.name;

        const multiple = field.type === "DROPDOWN_MULTIPLE";
        const select = el(
          "select",
          multiple ? { multiple: "multiple", "aria-label": field.name } : { "aria-label": field.name },
          multiple ? null : el("option", { value: "" }, "Choose a value…"),
          ...(field.allowedValues ?? []).map((value) => el("option", { value }, value)),
        );
        const saved = choices.customFieldInputs?.find((candidate) => candidate.customFieldId === refId)?.value;
        for (const option of Array.from(select.options)) {
          option.selected = Array.isArray(saved) ? saved.includes(option.value) : saved === option.value;
        }
        const useSelected = el("button", { type: "button" }, multiple ? "Use selected values" : "Use selected value");
        useSelected.addEventListener("click", () => {
          if (multiple) {
            const values = Array.from(select.options).filter((option) => option.selected).map((option) => option.value);
            if (values.length > 0) setInput(values);
          } else if (select.value !== "") {
            setInput(select.value);
          }
        });
        replacement.replaceChildren(select, useSelected);
      },
      () => replacement.replaceChildren(unavailable()),
    );
    container.append(replacement, keep, drop);
    return container;
  }

  const controls = el("div", {}, el("p", {}, "Loading current field settings…"));
  void runBackgroundRequest(
    ctx,
    () => fieldsPromise,
    (fields) => {
      const field = fields.find((candidate) => candidate.id === refId);
      if (!field) {
        controls.replaceChildren(unavailable());
        return;
      }
      labels.customFields[refId] = field.name;

      if (field.type === "CHECKBOX") {
        const select = el(
          "select",
          { "aria-label": field.name },
          el("option", { value: "" }, "Choose a value…"),
          el("option", { value: "true" }, "Checked"),
          el("option", { value: "false" }, "Not checked"),
        );
        const saved = choices.customFieldInputs?.find((candidate) => candidate.customFieldId === refId)?.value;
        if (typeof saved === "boolean") select.value = String(saved);
        const save = el("button", { type: "button" }, "Save value");
        save.addEventListener("click", () => {
          if (select.value !== "") setInput(select.value === "true");
        });
        controls.replaceChildren(select, save);
        return;
      }

      if (field.type === "DROPDOWN_SINGLE" || field.type === "DROPDOWN_MULTIPLE") {
        const multiple = field.type === "DROPDOWN_MULTIPLE";
        const select = el(
          "select",
          multiple ? { multiple: "multiple", "aria-label": field.name } : { "aria-label": field.name },
          multiple ? null : el("option", { value: "" }, "Choose a value…"),
          ...(field.allowedValues ?? []).map((value) => el("option", { value }, value)),
        );
        const saved = choices.customFieldInputs?.find((candidate) => candidate.customFieldId === refId)?.value;
        for (const option of Array.from(select.options)) {
          option.selected = Array.isArray(saved) ? saved.includes(option.value) : saved === option.value;
        }
        const save = el("button", { type: "button" }, multiple ? "Save values" : "Save value");
        save.addEventListener("click", () => {
          if (multiple) {
            const values = Array.from(select.options).filter((option) => option.selected).map((option) => option.value);
            if (values.length > 0) setInput(values);
          } else if (select.value !== "") {
            setInput(select.value);
          }
        });
        controls.replaceChildren(select, save);
        return;
      }

      const input = el("input", { type: field.type === "NUMBER" ? "number" : "text", "aria-label": field.name });
      const saved = choices.customFieldInputs?.find((candidate) => candidate.customFieldId === refId)?.value;
      if (saved !== undefined && saved !== null) input.value = String(saved);
      const save = el("button", { type: "button" }, "Save value");
      save.addEventListener("click", () => {
        if (input.value !== "") setInput(input.value);
      });
      controls.replaceChildren(input, save);
    },
    () => controls.replaceChildren(unavailable()),
  );
  container.append(controls);
  return container;
}

function renderCustomFieldsWidget(
  ctx: Ctx,
  choices: MutableChoices,
  labels: ChoiceLabels,
  reflow: () => void,
  items: readonly ActionRequiredItem[],
  source: DeletedTimeEntry,
): HTMLElement | null {
  const cfItems = [...itemsFor(items, "P-CF-OPT"), ...itemsFor(items, "P-CF-REQ")];
  if (cfItems.length === 0) return null;
  const container = el("fieldset", {}, el("legend", {}, "Custom fields"));
  // All items need the same current workspace settings. Share the request for this render so a
  // form with several custom fields does not repeat the same Clockify read.
  const fieldsPromise = fetchOptions<CustomFieldOption>(ctx, "customFields");
  for (const item of cfItems) {
    const node = renderCustomFieldItem(ctx, choices, labels, reflow, item, source, fieldsPromise);
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
  labels: ChoiceLabels = { tags: {}, customFields: {} },
): HTMLElement {
  const widgets = [
    renderRunningWidget(choices, reflow, actionRequired, source, ctx.locale),
    renderProjectWidget(ctx, choices, labels, reflow, actionRequired),
    renderTaskWidget(ctx, choices, labels, reflow, actionRequired, effectiveProjectId),
    renderTagsWidget(ctx, choices, labels, reflow, actionRequired),
    renderDescriptionWidget(choices, reflow, actionRequired),
    renderCustomFieldsWidget(ctx, choices, labels, reflow, actionRequired, source),
  ].filter((w): w is HTMLElement => w !== null);
  return el("section", { "aria-label": "Needs your input", class: "rt-notice" }, el("h3", {}, "Needs your input"), ...widgets);
}
