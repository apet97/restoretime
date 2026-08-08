// Detail view (docs/10 §3-§4): DELETED ENTRY vs NEW ENTRY (planned) facts, the Differences
// section, and — while ACTION_REQUIRED items remain — the resolution widgets. Every fact rendered
// here comes from the plan the server just computed; nothing is decided client-side (AGENTS.md:
// "the UI holds no business rules").

import { el, mount } from "../dom.js";
import { formatEntryHeader } from "../format.js";
import type { Ctx } from "../state.js";
import { renderApiError, renderBlockers, renderDifferences, withLoading } from "./shared.js";
import { renderResult } from "./result.js";
import { renderResolutionWidgets, toPreflightChoices, type MutableChoices } from "./resolution-widgets.js";
import type { DeletedTimeEntry, DetailResponse, PreflightResponse, RecreationPlan } from "../types.js";

export function renderDetail(ctx: Ctx, entryId: string, forceResolve = false): void {
  void withLoading(
    ctx,
    () => ctx.api.get("/api/entries/detail", { id: entryId }) as Promise<DetailResponse>,
    (data) => routeDetail(ctx, entryId, data, forceResolve),
    "Loading entry…",
  );
}

function routeDetail(ctx: Ctx, entryId: string, data: DetailResponse, forceResolve: boolean): void {
  const { entry } = data;

  if (!forceResolve) {
    if (entry.lifecycleState === "RECREATED" && data.plan && entry.newEntryId) {
      const attempt = data.attempts.find((a) => a.outcome === "SUCCESS") ?? data.attempts[0];
      renderResult(ctx, entryId, data.plan, {
        outcome: "RECREATED",
        newEntryId: entry.newEntryId,
        diffs: attempt?.diffs ?? [],
      });
      return;
    }
    if (entry.lifecycleState === "FAILED" && data.plan) {
      const attempt = data.attempts.find((a) => a.outcome === "FAILED") ?? data.attempts[0];
      renderResult(ctx, entryId, data.plan, {
        outcome: "FAILED",
        status: attempt?.errorStatus ?? null,
        code: attempt?.errorCode ?? null,
        message: attempt?.errorMessage ?? "Clockify rejected the request.",
      });
      return;
    }
    if (entry.lifecycleState === "AMBIGUOUS" && data.plan) {
      const attempt = data.attempts[0];
      renderResult(ctx, entryId, data.plan, { outcome: "AMBIGUOUS", baseline: attempt?.baseline ?? [] });
      return;
    }
    if (entry.lifecycleState === "RECREATING") {
      renderRecreating(ctx, entryId);
      return;
    }
    if (entry.lifecycleState === "DISMISSED") {
      renderDismissed(ctx, entryId);
      return;
    }
  }

  const initialChoices: MutableChoices = data.plan ? { ...(data.plan.choices as MutableChoices) } : {};
  runPreflightAndRender(ctx, entryId, data.entry.source, initialChoices, data.disabled);
}

function renderRecreating(ctx: Ctx, entryId: string): void {
  const refresh = el("button", { type: "button" }, "Check status");
  refresh.addEventListener("click", () => renderDetail(ctx, entryId));
  const back = el("button", { type: "button" }, "Back to deleted entries");
  back.addEventListener("click", () => ctx.navigate({ kind: "list" }));
  mount(ctx.root, el("h2", {}, "Recreating…"), el("p", {}, "RestoreTime is sending this entry to Clockify."), refresh, back);
}

function renderDismissed(ctx: Ctx, entryId: string): void {
  const undismiss = el("button", { type: "button" }, "Undismiss");
  undismiss.addEventListener("click", () => {
    ctx.api
      .post("/api/entries/undismiss", { entryId })
      .then(() => renderDetail(ctx, entryId))
      .catch((err) => renderApiError(ctx.root, err, () => renderDismissed(ctx, entryId)));
  });
  const back = el("button", { type: "button" }, "Back to deleted entries");
  back.addEventListener("click", () => ctx.navigate({ kind: "list" }));
  mount(ctx.root, el("h2", {}, "Dismissed"), el("p", {}, "This entry is hidden from the default list."), undismiss, back);
}

function runPreflightAndRender(ctx: Ctx, entryId: string, source: DeletedTimeEntry, choices: MutableChoices, disabled: boolean): void {
  void withLoading(
    ctx,
    () => ctx.api.post("/api/entries/preflight", { entryId, choices: toPreflightChoices(choices) }) as Promise<PreflightResponse>,
    (res) => renderResolveBody(ctx, entryId, source, choices, res.plan, disabled),
    "Checking what can be recreated…",
  );
}

function effectiveProjectId(plan: RecreationPlan): string | null {
  const projectEntries = plan.resolution.filter((r) => r.kind === "project");
  const last = projectEntries[projectEntries.length - 1];
  return last?.refId ?? null;
}

export function projectCell(source: DeletedTimeEntry, plan: RecreationPlan): string {
  const entries = plan.resolution.filter((r) => r.kind === "project");
  const outcome = entries[entries.length - 1];
  if (!outcome || outcome.outcome === "kept") return source.projectName ?? "—";
  if (outcome.outcome === "dropped") return "— (no project)";
  return "A replacement project (selected above)";
}

export function taskCell(source: DeletedTimeEntry, plan: RecreationPlan): string {
  const entries = plan.resolution.filter((r) => r.kind === "task");
  const outcome = entries[entries.length - 1];
  if (!outcome || outcome.outcome === "kept") return source.taskName ?? "—";
  if (outcome.outcome === "dropped") {
    return outcome.detail === "project changed" ? "— (task no longer applies; project changed)" : "— (task removed)";
  }
  return "A replacement task (selected above)";
}

export function tagsCell(source: DeletedTimeEntry, plan: RecreationPlan): string {
  const tagEntries = plan.resolution.filter((r) => r.kind === "tag");
  const keptNames = source.tags.filter((t) => tagEntries.some((r) => r.refId === t.id && r.outcome === "kept")).map((t) => t.name);
  const droppedCount = tagEntries.filter((r) => r.outcome === "dropped").length;
  const addedCount = tagEntries.filter((r) => r.outcome === "substituted").length;
  const parts = [...keptNames];
  if (addedCount > 0) parts.push(`+${addedCount} added`);
  let text = parts.length > 0 ? parts.join(", ") : "none";
  if (droppedCount > 0) text += ` (${droppedCount} removed)`;
  return text;
}

function renderFactsTable(source: DeletedTimeEntry, plan: RecreationPlan, locale: string): HTMLElement {
  const planned = plan.plannedRequest;
  const rows: [string, string, string][] = [
    ["Date and time", formatEntryHeader(source.start, source.end, locale), formatEntryHeader(planned.start, planned.end ?? null, locale, "planned")],
    ["Description", source.description, planned.description ?? source.description],
    ["Project", source.projectName ?? "—", projectCell(source, plan)],
    ["Task", source.taskName ?? "—", taskCell(source, plan)],
    ["Tags", source.tags.map((t) => t.name).join(", ") || "none", tagsCell(source, plan)],
    ["Billable", source.billable ? "yes" : "no", (planned.billable ?? source.billable) ? "yes" : "no"],
    ["Owner", source.ownerName, source.ownerName],
  ];
  return el(
    "table",
    {},
    el("caption", {}, "Deleted entry compared with the new entry RestoreTime plans to create"),
    el("thead", {}, el("tr", {}, el("th", {}, "Field"), el("th", {}, "Deleted entry"), el("th", {}, "New entry (planned)"))),
    el("tbody", {}, ...rows.map(([label, left, right]) => el("tr", {}, el("th", {}, label), el("td", {}, left), el("td", {}, right)))),
  );
}

function renderResolveBody(ctx: Ctx, entryId: string, source: DeletedTimeEntry, choices: MutableChoices, plan: RecreationPlan, disabled: boolean): void {
  const reflow = () => runPreflightAndRender(ctx, entryId, source, choices, disabled);
  const nodes: (Node | string)[] = [el("h2", {}, "Deleted time entry")];

  const blockerSection = renderBlockers(plan.blockers);
  if (blockerSection) nodes.push(blockerSection);

  nodes.push(renderFactsTable(source, plan, ctx.locale));
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

  if (plan.actionRequired.length > 0) {
    nodes.push(renderResolutionWidgets(ctx, choices, reflow, plan.actionRequired, effectiveProjectId(plan), source));
  }

  const canConfirm = plan.blockers.length === 0 && plan.actionRequired.length === 0;
  const continueButton = el("button", { type: "button" }, "Continue to confirm");
  continueButton.toggleAttribute("disabled", !canConfirm);
  continueButton.addEventListener("click", () => ctx.navigate({ kind: "confirm", entryId, plan, source, disabled }));
  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));
  nodes.push(el("div", {}, continueButton, backButton));

  mount(ctx.root, ...nodes);
}
