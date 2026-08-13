// Detail view (docs/10 §3-§4): DELETED ENTRY vs NEW ENTRY (planned) facts, the Differences
// section, and — while ACTION_REQUIRED items remain — the resolution widgets. Every fact rendered
// here comes from the plan the server just computed; nothing is decided client-side (AGENTS.md:
// "the UI holds no business rules").

import { el, mount } from "../dom.js";
import { formatEntryHeader } from "../format.js";
import type { ChoiceLabels, Ctx, ResolutionDraft } from "../state.js";
import { renderApiError, renderBlockers, renderDifferences, renderLineage, runAction, withLoading } from "./shared.js";
import { renderResult } from "./result.js";
import { renderResolutionWidgets, toPreflightChoices, type MutableChoices } from "./resolution-widgets.js";
import type { ActionRequiredItem, DeletedTimeEntry, DetailResponse, PreflightResponse, RecreationPlan } from "../types.js";

export function renderDetail(ctx: Ctx, entryId: string, forceResolve = false, draft?: ResolutionDraft): void {
  void withLoading(
    ctx,
    () => ctx.api.get("/api/entries/detail", { id: entryId }) as Promise<DetailResponse>,
    (data) => routeDetail(ctx, entryId, data, forceResolve, draft),
    "Loading entry…",
  );
}

function routeDetail(ctx: Ctx, entryId: string, data: DetailResponse, forceResolve: boolean, draft?: ResolutionDraft): void {
  const { entry } = data;

  if (!forceResolve) {
    if (entry.lifecycleState === "RECREATED" && data.plan && entry.newEntryId) {
      const attempt = data.attempts.find((a) => a.outcome === "SUCCESS") ?? data.attempts[0];
      renderResult(
        ctx,
        entryId,
        data.plan,
        {
          outcome: "RECREATED",
          newEntryId: entry.newEntryId,
          diffs: attempt?.diffs ?? [],
        },
        data.lineage,
      );
      return;
    }
    if (entry.lifecycleState === "FAILED" && data.plan) {
      const attempt = data.attempts.find((a) => a.outcome === "FAILED") ?? data.attempts[0];
      renderResult(
        ctx,
        entryId,
        data.plan,
        {
          outcome: "FAILED",
          status: attempt?.errorStatus ?? null,
          code: attempt?.errorCode ?? null,
          message: attempt?.errorMessage ?? "Clockify rejected the request.",
        },
        data.lineage,
      );
      return;
    }
    if (entry.lifecycleState === "AMBIGUOUS" && data.plan) {
      renderResult(ctx, entryId, data.plan, { outcome: "AMBIGUOUS" });
      return;
    }
    if (entry.lifecycleState === "RECREATING") {
      renderRecreating(ctx, entryId, data.lineage);
      return;
    }
    if (entry.lifecycleState === "DISMISSED") {
      renderDismissed(ctx, entryId, data.disabled, data.lineage);
      return;
    }
  }

  const initial = draft?.choices ?? data.plan?.choices ?? {};
  const initialChoices = {
    ...initial,
    ...(initial.dropTagIds ? { dropTagIds: [...initial.dropTagIds] } : {}),
    ...(initial.addTagIds ? { addTagIds: [...initial.addTagIds] } : {}),
    ...(initial.customFieldInputs ? { customFieldInputs: initial.customFieldInputs.map((item) => ({ ...item })) } : {}),
    ...(initial.dropCustomFieldIds ? { dropCustomFieldIds: [...initial.dropCustomFieldIds] } : {}),
  } as MutableChoices;
  const actionRequired = [...(draft?.actionRequired ?? data.plan?.presentation?.editable ?? data.plan?.actionRequired ?? [])];
  const labels: ChoiceLabels = {
    ...(draft?.labels.project !== undefined ? { project: draft.labels.project } : {}),
    ...(draft?.labels.task !== undefined ? { task: draft.labels.task } : {}),
    tags: { ...(draft?.labels.tags ?? {}) },
    customFields: { ...(draft?.labels.customFields ?? {}) },
  };
  runPreflightAndRender(ctx, entryId, data.entry.source, initialChoices, actionRequired, labels, data.disabled, data.lineage);
}

function renderRecreating(ctx: Ctx, entryId: string, lineage: DetailResponse["lineage"]): void {
  const refresh = el("button", { type: "button" }, "Check status");
  refresh.addEventListener("click", () => renderDetail(ctx, entryId));
  const back = el("button", { type: "button" }, "Back to deleted entries");
  back.addEventListener("click", () => ctx.navigate({ kind: "list" }));
  mount(
    ctx.root,
    el("h2", {}, "Recreating…"),
    el("p", {}, "RestoreTime is sending this entry to Clockify."),
    renderLineage(ctx, lineage),
    refresh,
    back,
  );
}

function renderDismissed(ctx: Ctx, entryId: string, disabled: boolean, lineage: DetailResponse["lineage"]): void {
  const back = el("button", { type: "button" }, "Back to deleted entries");
  back.addEventListener("click", () => ctx.navigate({ kind: "list" }));

  if (disabled) {
    const refresh = el("button", { type: "button" }, "Check status");
    refresh.addEventListener("click", () => renderDetail(ctx, entryId));
    mount(
      ctx.root,
      el("h2", {}, "Dismissed"),
      el("p", {}, "This entry is hidden from the default list."),
      el("p", { role: "alert" }, "RestoreTime is disabled for this workspace."),
      renderLineage(ctx, lineage),
      refresh,
      back,
    );
    return;
  }

  const undismiss = el("button", { type: "button" }, "Undismiss");
  undismiss.addEventListener("click", () => {
    undismiss.disabled = true;
    back.disabled = true;
    void runAction(
      ctx,
      () => ctx.api.post("/api/entries/undismiss", { entryId }),
      () => renderDetail(ctx, entryId),
      (err) => renderApiError(ctx.root, err, () => renderDetail(ctx, entryId)),
    );
  });
  mount(
    ctx.root,
    el("h2", {}, "Dismissed"),
    el("p", {}, "This entry is hidden from the default list."),
    renderLineage(ctx, lineage),
    undismiss,
    back,
  );
}

function runPreflightAndRender(
  ctx: Ctx,
  entryId: string,
  source: DeletedTimeEntry,
  choices: MutableChoices,
  knownActionRequired: ActionRequiredItem[],
  labels: ChoiceLabels,
  disabled: boolean,
  lineage: DetailResponse["lineage"],
): void {
  void withLoading(
    ctx,
    () => ctx.api.post("/api/entries/preflight", { entryId, choices: toPreflightChoices(choices) }) as Promise<PreflightResponse>,
    (res) => {
      for (const item of res.plan.actionRequired) {
        if (!knownActionRequired.some((known) => known.ruleId === item.ruleId && known.refId === item.refId)) knownActionRequired.push(item);
      }
      renderResolveBody(ctx, entryId, source, choices, knownActionRequired, labels, res.plan, disabled, lineage);
    },
    "Checking what can be recreated…",
  );
}

function effectiveProjectId(plan: RecreationPlan): string | null {
  const projectEntries = plan.resolution.filter((r) => r.kind === "project");
  const last = projectEntries[projectEntries.length - 1];
  return last?.refId ?? null;
}

export function projectCell(source: DeletedTimeEntry, plan: RecreationPlan, labels?: ChoiceLabels): string {
  const presented = plan.presentation?.project;
  if (presented) return presented.outcome === "dropped" ? "— (no project)" : presented.name;
  if (plan.plannedRequest.projectId === undefined) return "— (no project)";
  if (labels?.project?.id === plan.plannedRequest.projectId) return labels.project.name;
  if (plan.plannedRequest.projectId === source.projectId) return source.projectName ?? "—";
  return "Current project name is not available";
}

export function taskCell(source: DeletedTimeEntry, plan: RecreationPlan, labels?: ChoiceLabels): string {
  const presented = plan.presentation?.task;
  if (presented) return presented.outcome === "dropped" ? "— (no task)" : presented.name;
  if (plan.plannedRequest.taskId === undefined) return "— (no task)";
  if (labels?.task?.id === plan.plannedRequest.taskId) return labels.task.name;
  if (plan.plannedRequest.taskId === source.taskId) return source.taskName ?? "—";
  return "Current task name is not available";
}

export function tagsCell(source: DeletedTimeEntry, plan: RecreationPlan, labels?: ChoiceLabels): string {
  const plannedIds = new Set(plan.plannedRequest.tagIds ?? []);
  const presented = plan.presentation?.tags.filter((tag) => plannedIds.has(tag.id)).map((tag) => tag.name) ?? [];
  const known = new Map([...source.tags.map((tag) => [tag.id, tag.name] as const), ...Object.entries(labels?.tags ?? {})]);
  const names = presented.length > 0 ? presented : [...plannedIds].map((id) => known.get(id) ?? "Current tag name is not available");
  return names.length > 0 ? names.join(", ") : "none";
}

function displayValue(value: unknown): string {
  if (value === undefined) return "not sent";
  if (value === null) return "empty";
  if (typeof value === "string") return value;
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

function customFieldRows(source: DeletedTimeEntry, plan: RecreationPlan, labels?: ChoiceLabels): [string, string, string][] {
  const presented = plan.presentation?.customFields ?? [];
  const plannedById = new Map((plan.plannedRequest.customFields ?? []).map((field) => [field.customFieldId, field.value]));
  const ids = new Set([...source.customFieldValues.map((field) => field.customFieldId), ...presented.map((field) => field.id), ...plannedById.keys()]);
  return [...ids].map((id) => {
    const sourceField = source.customFieldValues.find((field) => field.customFieldId === id);
    const presentation = presented.find((field) => field.id === id);
    const name = presentation?.name ?? labels?.customFields[id] ?? sourceField?.name ?? "Unnamed custom field";
    const plannedValue = plannedById.has(id)
      ? plannedById.get(id)
      : presentation && "plannedValue" in presentation
        ? presentation.plannedValue
        : presentation?.outcome === "kept"
          ? sourceField?.value
          : undefined;
    return [`Custom field: ${name}`, displayValue(sourceField?.value), displayValue(plannedValue)];
  });
}

export function renderFactsTable(source: DeletedTimeEntry, plan: RecreationPlan, locale: string, labels?: ChoiceLabels): HTMLElement {
  const planned = plan.plannedRequest;
  const rows: [string, string, string][] = [
    ["Date and time", formatEntryHeader(source.start, source.end, locale), formatEntryHeader(planned.start, planned.end ?? null, locale, "planned")],
    ["Description", source.description, planned.description ?? source.description],
    ["Project", source.projectName ?? "—", projectCell(source, plan, labels)],
    ["Task", source.taskName ?? "—", taskCell(source, plan, labels)],
    ["Tags", source.tags.map((t) => t.name).join(", ") || "none", tagsCell(source, plan, labels)],
    ["Billable", source.billable ? "yes" : "no", (planned.billable ?? source.billable) ? "yes" : "no"],
    ["Owner", source.ownerName, source.ownerName],
  ];
  rows.push(...customFieldRows(source, plan, labels));
  return el(
    "div",
    { class: "rt-table-scroll", tabindex: "0", "aria-label": "Deleted and planned entry values" },
    el(
      "table",
      {},
      el("caption", {}, "Deleted entry compared with the new entry RestoreTime plans to create"),
      el("thead", {}, el("tr", {}, el("th", {}, "Field"), el("th", {}, "Deleted entry"), el("th", {}, "New entry (planned)"))),
      el("tbody", {}, ...rows.map(([label, left, right]) => el("tr", {}, el("th", {}, label), el("td", {}, left), el("td", {}, right)))),
    ),
  );
}

function renderResolveBody(
  ctx: Ctx,
  entryId: string,
  source: DeletedTimeEntry,
  choices: MutableChoices,
  knownActionRequired: ActionRequiredItem[],
  labels: ChoiceLabels,
  plan: RecreationPlan,
  disabled: boolean,
  lineage: DetailResponse["lineage"],
): void {
  const reflow = () => runPreflightAndRender(ctx, entryId, source, choices, knownActionRequired, labels, disabled, lineage);
  const nodes: (Node | string)[] = [el("h2", {}, "Deleted time entry")];

  const lineageSection = renderLineage(ctx, lineage);
  if (lineageSection) nodes.push(lineageSection);

  const blockerSection = renderBlockers(plan.blockers);
  if (blockerSection) nodes.push(blockerSection);

  nodes.push(renderFactsTable(source, plan, ctx.locale, labels));
  nodes.push(renderDifferences(plan));

  // docs/10 §8: while the addon is disabled the notice replaces actions, but the entry stays
  // readable. The facts and differences above are still rendered; only the form and the confirm
  // button go away — matching what the server will accept (routes.ts `actionGuard`).
  if (disabled) {
    const back = el("button", { type: "button" }, "Back to deleted entries");
    back.addEventListener("click", () => ctx.navigate({ kind: "list" }));
    nodes.push(el("p", { role: "alert" }, "RestoreTime is disabled for this workspace."), back);
    mount(ctx.root, ...nodes);
    return;
  }

  if (knownActionRequired.length > 0) {
    nodes.push(renderResolutionWidgets(ctx, choices, reflow, knownActionRequired, effectiveProjectId(plan), source, labels));
  }

  const canConfirm = plan.presentation !== null && plan.blockers.length === 0 && plan.actionRequired.length === 0;
  const continueButton = el("button", { type: "button", class: "rt-primary" }, "Continue to confirm");
  continueButton.toggleAttribute("disabled", !canConfirm);
  if (plan.presentation === null) nodes.push(el("p", { role: "alert" }, "This plan needs a new check before you can confirm it."));
  const draft = (): ResolutionDraft => ({
    choices: toPreflightChoices(choices),
    actionRequired: [...knownActionRequired],
    labels: {
      ...(labels.project !== undefined ? { project: labels.project } : {}),
      ...(labels.task !== undefined ? { task: labels.task } : {}),
      tags: { ...labels.tags },
      customFields: { ...labels.customFields },
    },
  });
  continueButton.addEventListener("click", () => ctx.navigate({ kind: "confirm", entryId, plan, source, disabled, draft: draft() }));
  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));
  // docs/06 lifecycle: IDLE/FAILED -> DISMISSED. Without this the server's dismiss endpoint had no
  // caller, so nothing could ever enter the state that docs/10 §2's "Show dismissed" toggle exists
  // to reveal, and a list could only ever grow. `renderDismissed` already offers the inverse.
  const dismissButton = el("button", { type: "button" }, "Dismiss");
  dismissButton.addEventListener("click", () => {
    for (const control of Array.from(ctx.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button"))) {
      control.disabled = true;
    }
    void runAction(
      ctx,
      () => ctx.api.post("/api/entries/dismiss", { entryId }),
      () => ctx.navigate({ kind: "list" }),
      (err) => renderApiError(ctx.root, err, reflow),
    );
  });
  nodes.push(el("div", {}, continueButton, dismissButton, backButton));

  mount(ctx.root, ...nodes);
}
