// Detail view (docs/10 §3-§4): DELETED ENTRY vs NEW ENTRY (planned) facts, the Differences
// section, and — while ACTION_REQUIRED items remain — the resolution widgets. Every fact rendered
// here comes from the plan the server just computed; nothing is decided client-side (AGENTS.md:
// "the UI holds no business rules").

import { clear, el } from "../dom.js";
import { formatEntryHeader } from "../format.js";
import type { ChoiceLabels, Ctx, ResolutionDraft, ReturnTarget } from "../state.js";
import { bindBusyAction, mountView, renderApiError, renderBlockers, renderDifferences, renderLineage, renderNotice, runAction, withLoading } from "./shared.js";
import { renderResult } from "./result.js";
import { renderResolutionWidgets, toPreflightChoices, type MutableChoices } from "./resolution-widgets.js";
import type { ActionRequiredItem, DeletedTimeEntry, DetailResponse, PreflightResponse, RecreationPlan } from "../types.js";

export function renderDetail(ctx: Ctx, entryId: string, forceResolve = false, draft?: ResolutionDraft, returnTo: ReturnTarget = "list"): void {
  void withLoading(
    ctx,
    () => ctx.api.get("/api/entries/detail", { id: entryId }) as Promise<DetailResponse>,
    (data) => routeDetail(ctx, entryId, data, forceResolve, draft, returnTo),
    "Loading entry…",
    "Recheck entry",
  );
}

function routeDetail(ctx: Ctx, entryId: string, data: DetailResponse, forceResolve: boolean, draft: ResolutionDraft | undefined, returnTo: ReturnTarget): void {
  const { entry } = data;

  if (data.disabled || data.broken) {
    renderReadOnlyDetail(ctx, entry.source, data.plan, data.broken, data.lineage, returnTo);
    return;
  }

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
        returnTo,
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
        returnTo,
      );
      return;
    }
    if (entry.lifecycleState === "AMBIGUOUS" && data.plan) {
      renderResult(ctx, entryId, data.plan, { outcome: "AMBIGUOUS" }, data.lineage, returnTo);
      return;
    }
    if (entry.lifecycleState === "RECREATING") {
      renderRecreating(ctx, entryId, data.lineage, returnTo);
      return;
    }
    if (entry.lifecycleState === "DISMISSED") {
      renderDismissed(ctx, entryId, data.lineage, returnTo);
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
  const shell = renderInitialDetailShell(ctx, data.entry.source, data.lineage, returnTo);
  runPreflightAndRender(ctx, entryId, data.entry.source, initialChoices, actionRequired, labels, false, data.lineage, returnTo, shell);
}

function renderReadOnlyDetail(
  ctx: Ctx,
  source: DeletedTimeEntry,
  plan: RecreationPlan | null,
  broken: boolean,
  lineage: DetailResponse["lineage"],
  returnTo: ReturnTarget,
): void {
  const back = el("button", { type: "button" }, backLabel(returnTo));
  back.addEventListener("click", () => backToReturnTarget(ctx, returnTo));
  const notice = broken
    ? "RestoreTime is no longer connected to this workspace. Ask a workspace admin to reinstall this add-on, then reload RestoreTime."
    : "RestoreTime is disabled for this workspace.";
  mountView(
    ctx,
    el("h2", {}, "Deleted time entry"),
    renderDeletedEntryFacts(source, ctx.locale),
    renderLineage(ctx, lineage),
    renderNotice(broken ? "danger" : "info", notice),
    ...(plan ? [renderFactsTable(source, plan, ctx.locale), renderDifferences(plan)] : []),
    back,
  );
}

function backToReturnTarget(ctx: Ctx, returnTo: ReturnTarget): void {
  if (returnTo === "bulk-review") {
    const rows = ctx.session.bulkReviewRows ?? [];
    ctx.navigate({ kind: "bulk-review", rows, refresh: true });
    return;
  }
  ctx.navigate({ kind: "list" });
}

function backLabel(returnTo: ReturnTarget): string {
  return returnTo === "bulk-review" ? "Back to review" : "Back to deleted entries";
}

function renderRecreating(ctx: Ctx, entryId: string, lineage: DetailResponse["lineage"], returnTo: ReturnTarget): void {
  const refresh = el("button", { type: "button" }, "Check status");
  refresh.addEventListener("click", () => renderDetail(ctx, entryId));
  const back = el("button", { type: "button" }, backLabel(returnTo));
  back.addEventListener("click", () => backToReturnTarget(ctx, returnTo));
  mountView(
    ctx,
    el("h2", {}, "Recreating"),
    el("p", {}, "RestoreTime is sending this entry to Clockify."),
    renderLineage(ctx, lineage),
    refresh,
    back,
  );
}

function renderDismissed(
  ctx: Ctx,
  entryId: string,
  lineage: DetailResponse["lineage"],
  returnTo: ReturnTarget,
): void {
  const back = el("button", { type: "button" }, backLabel(returnTo));
  back.addEventListener("click", () => backToReturnTarget(ctx, returnTo));

  const undismiss = el("button", { type: "button" }, "Undismiss");
  const errorRegion = el("div", { class: "rt-inline-error", "aria-label": "Dismissal error" });
  bindBusyAction({
    ctx,
    button: undismiss,
    busyLabel: "Undismissing…",
    conflictingControls: [back],
    action: () => ctx.api.post("/api/entries/undismiss", { entryId }),
    onSuccess: () => {
      ctx.session.list.dismissed = false;
      renderDetail(ctx, entryId, false, undefined, returnTo);
    },
    onError: (err) => renderApiError({ region: errorRegion, err, context: "", action: () => renderDetail(ctx, entryId, false, undefined, returnTo), actionLabel: "Recheck entry" }),
  });
  mountView(
    ctx,
    el("h2", {}, "Dismissed"),
    el("p", {}, "This entry is hidden from the default list."),
    renderLineage(ctx, lineage),
    errorRegion,
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
  returnTo: ReturnTarget,
  shell?: DetailShell,
  focusKey?: string | null,
): void {
  const preflightChoices = snapshotChoices(choices);
  const load = () => ctx.api.post("/api/entries/preflight", { entryId, choices: preflightChoices }) as Promise<PreflightResponse>;
  if (!shell) throw new Error("A detail preflight needs a mounted detail shell.");
  const preflightNumber = ++shell.latestPreflight;
  const accept = (res: PreflightResponse) => {
    for (const item of res.plan.actionRequired) {
      if (!knownActionRequired.some((known) => known.ruleId === item.ruleId && known.refId === item.refId)) knownActionRequired.push(item);
    }
    shell.planRegion.removeAttribute("aria-busy");
    if (shell.initial) {
      renderResolveBody(ctx, entryId, source, choices, knownActionRequired, labels, res.plan, disabled, lineage, returnTo);
      return;
    }
    renderPlanRegion(ctx, shell, entryId, source, choices, knownActionRequired, labels, res.plan, disabled, lineage, returnTo, focusKey ?? null);
  };
  shell.planRegion.setAttribute("aria-busy", "true");
  shell.planRegion.querySelector(".rt-plan-status")?.remove();
  shell.planRegion.append(el("p", { role: "status", class: "rt-plan-status" }, "Checking choices…"));
  const restoreControls = disableSubmittingControlGroup();
  const run = async () => {
    if (!shell.planRegion.isConnected) return;
    await runAction(
      ctx,
      load,
      (res) => {
        restoreControls();
        if (preflightNumber !== shell.latestPreflight || !shell.planRegion.isConnected) return;
        accept(res);
      },
      (err) => {
        restoreControls();
        if (preflightNumber !== shell.latestPreflight || !shell.planRegion.isConnected) return;
        shell.planRegion.removeAttribute("aria-busy");
        shell.planRegion.querySelector(".rt-plan-status")?.remove();
        renderApiError({
          region: shell.errorRegion,
          err,
          context: shell.initial ? "RestoreTime could not update this plan. Stored deleted-entry facts remain available." : "",
          action: () => runPreflightAndRender(ctx, entryId, source, choices, knownActionRequired, labels, disabled, lineage, returnTo, shell, focusKey),
          actionLabel: "Check choices again",
        });
      },
    );
  };
  if (shell.initial) {
    void run();
    return;
  }
  shell.preflightQueue = shell.preflightQueue.then(run, run);
  void shell.preflightQueue;
}

function snapshotChoices(choices: MutableChoices): MutableChoices {
  return {
    ...(choices.projectId !== undefined ? { projectId: choices.projectId } : {}),
    ...(choices.taskId !== undefined ? { taskId: choices.taskId } : {}),
    ...(choices.dropTagIds ? { dropTagIds: [...choices.dropTagIds] } : {}),
    ...(choices.addTagIds ? { addTagIds: [...choices.addTagIds] } : {}),
    ...(choices.description !== undefined ? { description: choices.description } : {}),
    ...(choices.runningMode !== undefined ? { runningMode: choices.runningMode } : {}),
    ...(choices.completedEnd !== undefined ? { completedEnd: choices.completedEnd } : {}),
    ...(choices.customFieldInputs
      ? {
          customFieldInputs: choices.customFieldInputs.map((item) => ({
            ...item,
            ...(Array.isArray(item.value) ? { value: [...item.value] } : {}),
          })),
        }
      : {}),
    ...(choices.dropCustomFieldIds ? { dropCustomFieldIds: [...choices.dropCustomFieldIds] } : {}),
  };
}

function disableSubmittingControlGroup(): () => void {
  const active = document.activeElement as HTMLElement | null;
  if (!active?.matches("input, select, textarea, button")) return () => undefined;
  const group = active?.closest("fieldset") ?? active?.parentElement;
  if (!group) return () => undefined;
  const controls = Array.from(group.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button"));
  const previous = controls.map((control) => ({ control, disabled: control.disabled }));
  for (const { control } of previous) control.disabled = true;
  return () => {
    for (const { control, disabled } of previous) control.disabled = disabled;
  };
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

/** Deleted-entry facts belong to the stable detail shell. The comparison table below can update
 * after every preflight choice, but these source facts must stay mounted while that happens. */
export function renderDeletedEntryFacts(source: DeletedTimeEntry, locale: string): HTMLElement {
  const projectAndTask = [source.projectName, source.taskName].filter((value): value is string => Boolean(value)).join(" — ") || "none";
  const rows: readonly [string, string][] = [
    ["Date and time", formatEntryHeader(source.start, source.end, locale)],
    ["Description", source.description || "(no description)"],
    ["Project and task", projectAndTask],
    ["Tags", source.tags.map((tag) => tag.name).join(", ") || "none"],
    ["Owner", source.ownerName],
  ];
  return el(
    "section",
    { class: "rt-deleted-facts", "aria-label": "Deleted entry facts" },
    el("h3", {}, "Deleted entry facts"),
    el("dl", {}, ...rows.map(([label, value]) => el("div", {}, el("dt", {}, label), el("dd", {}, value)))),
  );
}

interface DetailShell {
  readonly planRegion: HTMLElement;
  readonly errorRegion: HTMLElement;
  readonly initial: boolean;
  preflightQueue: Promise<void>;
  latestPreflight: number;
}

function renderInitialDetailShell(
  ctx: Ctx,
  source: DeletedTimeEntry,
  lineage: DetailResponse["lineage"],
  returnTo: ReturnTarget,
): DetailShell {
  const planRegion = el("section", { class: "rt-plan-region", "aria-label": "Recreation plan" });
  const errorRegion = el("div", { class: "rt-inline-error", "aria-label": "Plan error" });
  const backButton = el("button", { type: "button" }, backLabel(returnTo));
  backButton.addEventListener("click", () => backToReturnTarget(ctx, returnTo));
  const shell: DetailShell = { planRegion, errorRegion, initial: true, preflightQueue: Promise.resolve(), latestPreflight: 0 };
  mountView(
    ctx,
    el("h2", {}, "Deleted time entry"),
    renderDeletedEntryFacts(source, ctx.locale),
    renderLineage(ctx, lineage),
    errorRegion,
    planRegion,
    el("div", { class: "rt-action-group" }, backButton),
  );
  return shell;
}

function draftFor(choices: MutableChoices, knownActionRequired: readonly ActionRequiredItem[], labels: ChoiceLabels): ResolutionDraft {
  return {
    choices: toPreflightChoices(choices),
    actionRequired: [...knownActionRequired],
    labels: {
      ...(labels.project !== undefined ? { project: labels.project } : {}),
      ...(labels.task !== undefined ? { task: labels.task } : {}),
      tags: { ...labels.tags },
      customFields: { ...labels.customFields },
    },
  };
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
  returnTo: ReturnTarget,
): void {
  const planRegion = el("section", { class: "rt-plan-region", "aria-label": "Recreation plan" });
  const errorRegion = el("div", { class: "rt-inline-error", "aria-label": "Plan error" });
  const shell: DetailShell = { planRegion, errorRegion, initial: false, preflightQueue: Promise.resolve(), latestPreflight: 0 };
  const backButton = el("button", { type: "button" }, backLabel(returnTo));
  backButton.addEventListener("click", () => backToReturnTarget(ctx, returnTo));
  const actionGroup = el("div", { class: "rt-action-group" });

  if (!disabled) {
    const dismissButton = el("button", { type: "button" }, "Dismiss");
    bindBusyAction({
      ctx,
      button: dismissButton,
      busyLabel: "Dismissing…",
      conflictingControls: [backButton],
      action: () => ctx.api.post("/api/entries/dismiss", { entryId }),
      onSuccess: () => backToReturnTarget(ctx, returnTo),
      onError: (err) => renderApiError({ region: errorRegion, err, context: "", action: () => renderDetail(ctx, entryId, false, undefined, returnTo), actionLabel: "Recheck entry" }),
    });
    actionGroup.append(dismissButton);
  }
  actionGroup.append(backButton);

  renderPlanRegion(ctx, shell, entryId, source, choices, knownActionRequired, labels, plan, disabled, lineage, returnTo, null);
  mountView(
    ctx,
    el("h2", {}, "Deleted time entry"),
    renderDeletedEntryFacts(source, ctx.locale),
    renderLineage(ctx, lineage),
    errorRegion,
    planRegion,
    actionGroup,
  );
}

function renderPlanRegion(
  ctx: Ctx,
  shell: DetailShell,
  entryId: string,
  source: DeletedTimeEntry,
  choices: MutableChoices,
  knownActionRequired: ActionRequiredItem[],
  labels: ChoiceLabels,
  plan: RecreationPlan,
  disabled: boolean,
  lineage: DetailResponse["lineage"],
  returnTo: ReturnTarget,
  focusKey: string | null,
): void {
  clear(shell.planRegion);
  const reflow = () => {
    const active = document.activeElement as HTMLElement | null;
    const activeFocusKey = active?.getAttribute("data-focus-key") ?? null;
    runPreflightAndRender(ctx, entryId, source, choices, knownActionRequired, labels, disabled, lineage, returnTo, shell, activeFocusKey);
  };
  const blockerSection = renderBlockers(plan.blockers);
  if (blockerSection) shell.planRegion.append(blockerSection);
  shell.planRegion.append(renderFactsTable(source, plan, ctx.locale, labels), renderDifferences(plan));

  if (disabled) {
    shell.planRegion.append(renderNotice("danger", "RestoreTime is not connected to Clockify. This entry is read-only."));
    return;
  }

  if (knownActionRequired.length > 0) {
    const widgets = renderResolutionWidgets(ctx, choices, reflow, knownActionRequired, effectiveProjectId(plan), source, labels);
    if (widgets) shell.planRegion.append(widgets);
  }
  const canConfirm = plan.presentation !== null && plan.blockers.length === 0 && plan.actionRequired.length === 0;
  const continueButton = el("button", { type: "button", class: "rt-primary", "data-focus-key": "continue" }, "Continue to confirm");
  continueButton.disabled = !canConfirm;
  continueButton.addEventListener("click", () => ctx.navigate({ kind: "confirm", entryId, plan, source, disabled, draft: draftFor(choices, knownActionRequired, labels), returnTo }));
  if (plan.presentation === null) shell.planRegion.append(renderNotice("warning", "This plan needs a new check before you can confirm it."));
  shell.planRegion.append(el("div", { class: "rt-action-group" }, continueButton));

  const target = focusKey
    ? Array.from(shell.planRegion.querySelectorAll<HTMLElement>("[data-focus-key]")).find((node) => node.dataset.focusKey === focusKey)
    : shell.planRegion.querySelector<HTMLElement>("[data-focus-key]");
  if (target) target.focus();
}
