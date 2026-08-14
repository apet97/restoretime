// Result views (docs/10 §6). Every branch answers the three questions docs/10 §8 requires: what
// happened, whether anything was created, what to do next. The "unknown result" view never implies
// the entry was not created — it says plainly that Clockify's answer never arrived.

import { el } from "../dom.js";
import type { Ctx, ReturnTarget } from "../state.js";
import type { AttemptRecreationResult, DetailResponse, ReconcileResponse, ReconcileResult, RecreationPlan } from "../types.js";
import { fidelityLabel } from "../format.js";
import { bindBusyAction, mountView, renderApiError, renderDifferences, renderLineage, renderNotice, withLoading } from "./shared.js";

export function renderResult(
  ctx: Ctx,
  entryId: string,
  plan: RecreationPlan,
  result: AttemptRecreationResult,
  lineage?: DetailResponse["lineage"],
  returnTo: ReturnTarget = "list",
): void {
  if (result.outcome === "RECREATED") {
    renderSuccess(ctx, plan, result, lineage, returnTo);
  } else if (result.outcome === "FAILED") {
    renderFailed(ctx, entryId, result, lineage, returnTo);
  } else {
    renderAmbiguous(ctx, entryId, returnTo);
  }
}

// --- Success (docs/10 §6) -------------------------------------------------------------------

function renderSuccess(
  ctx: Ctx,
  plan: RecreationPlan,
  result: Extract<AttemptRecreationResult, { outcome: "RECREATED" }>,
  lineage: DetailResponse["lineage"] | undefined,
  returnTo: ReturnTarget,
): void {
  const nodes: (Node | string)[] = [
    el("p", {}, "This is a new entry. It does not share the deleted entry's historical identity."),
    el("p", {}, `Fidelity: ${fidelityLabel(plan.fidelity)}.`),
    renderDifferences(plan),
  ];

  const lineageSection = renderLineage(ctx, lineage);
  if (lineageSection) nodes.push(lineageSection);

  const visibleDiffs = result.diffs.filter((diff) => diff.field !== "_verification");
  const verificationDiffs = result.diffs.filter((diff) => diff.field === "_verification");
  if (visibleDiffs.length > 0) {
    nodes.push(
      el(
        "section",
        {},
        el("h3", {}, "Clockify applied these changes"),
        el(
          "ul",
          {},
          ...visibleDiffs.map((diff) => renderVerificationDiff(diff, plan, ctx.locale)),
        ),
      ),
    );
  }
  for (const diff of verificationDiffs) nodes.push(renderNotice("info", renderVerificationDiff(diff, plan, ctx.locale).textContent ?? "The entry was created, but RestoreTime could not verify every saved value."));

  const openButton = el("button", { type: "button", class: "rt-primary" }, "Open in Clockify tracker");
  openButton.addEventListener("click", () => ctx.bridge.navigate("tracker"));
  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));
  const reviewButton = returnTo === "bulk-review"
    ? el("button", { type: "button" }, "Back to review")
    : null;
  reviewButton?.addEventListener("click", () => ctx.navigate({ kind: "bulk-review", rows: ctx.session.bulkReviewRows ?? [], refresh: true }));
  nodes.push(el("div", { class: "rt-action-group" }, openButton, backButton, reviewButton));

  mountView(ctx, el("h2", {}, "Time entry recreated."), ...nodes);
}

// --- Failed (docs/10 §6) --------------------------------------------------------------------

function renderFailed(
  ctx: Ctx,
  entryId: string,
  result: Extract<AttemptRecreationResult, { outcome: "FAILED" }>,
  lineage: DetailResponse["lineage"] | undefined,
  returnTo: ReturnTarget,
): void {
  const reviewPlan = el("button", { type: "button", class: "rt-primary" }, "Review a new plan");
  reviewPlan.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId, forceResolve: true, returnTo }));
  const backEntry = el("button", { type: "button" }, "Back to entry");
  backEntry.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId, returnTo }));
  const backList = el("button", { type: "button" }, "Back to deleted entries");
  backList.addEventListener("click", () => ctx.navigate({ kind: "list" }));
  mountView(
    ctx,
    el("h2", {}, "Clockify did not create the entry."),
    el("p", {}, `Reason: ${result.message}`),
    el("p", {}, "Nothing was created. Review a new plan before you recreate the entry."),
    renderLineage(ctx, lineage),
    el("div", { class: "rt-action-group" }, reviewPlan, backEntry, backList),
  );
}

function resultTime(value: unknown, locale: string): string | null {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function yesNo(value: unknown): string | null {
  return typeof value === "boolean" ? (value ? "Yes" : "No") : null;
}

function renderVerificationDiff(diff: { readonly field: string; readonly planned: unknown; readonly actual: unknown }, plan: RecreationPlan, locale: string): HTMLElement {
  if (diff.field === "start" || diff.field === "end") {
    const actual = resultTime(diff.actual, locale) ?? "a different time";
    return el("li", {}, `Clockify saved a different ${diff.field === "start" ? "start" : "end"} time: ${actual}.`);
  }
  if (diff.field === "description") return el("li", {}, "Clockify saved a different description.");
  if (diff.field === "projectId") return el("li", {}, "Clockify saved a different project than planned.");
  if (diff.field === "taskId") return el("li", {}, "Clockify saved a different task than planned.");
  if (diff.field === "tagIds") return el("li", {}, "Clockify saved a different tag selection than planned.");
  if (diff.field === "billable") {
    const planned = yesNo(diff.planned) ?? "an unknown value";
    const actual = yesNo(diff.actual) ?? "an unknown value";
    return el("li", {}, `Clockify saved Billable as ${actual} instead of ${planned}.`);
  }
  if (diff.field === "_verification") return el("li", {}, "The entry was created, but RestoreTime could not re-read it to verify every saved value.");
  if (diff.field.startsWith("customFields.")) {
    const id = diff.field.slice("customFields.".length);
    const name = plan.presentation?.customFields.find((field) => field.id === id)?.name;
    return name ? el("li", {}, `Clockify saved a different value for ${name}.`) : el("li", {}, "Clockify returned one value that differed from the plan.");
  }
  return el("li", {}, "Clockify returned one value that differed from the plan.");
}

// --- Unknown result / AMBIGUOUS (docs/10 §6) ------------------------------------------------

function renderAmbiguous(ctx: Ctx, entryId: string, returnTo: ReturnTarget): void {
  void withLoading(
    ctx,
    () => ctx.api.get("/api/entries/detail", { id: entryId }) as Promise<DetailResponse>,
    (data) => {
      if (data.entry.lifecycleState !== "AMBIGUOUS") {
        ctx.navigate({ kind: "detail", entryId, returnTo });
        return;
      }
      renderAmbiguousBody(ctx, entryId, data, returnTo);
    },
    "Checking the latest status…",
    "Check status again",
  );
}

function renderAmbiguousBody(ctx: Ctx, entryId: string, data: DetailResponse, returnTo: ReturnTarget): void {
  const latestAttempt = data.attempts.find((a) => a.outcome === "AMBIGUOUS" || (a.outcome === null && a.finishedAt === null)) ?? data.attempts[0];
  const reconcile = latestAttempt?.reconcile ?? null;
  const checks = reconcile?.checks ?? 0;

  if (data.disabled || data.broken) {
    const back = resultBackButton(ctx, returnTo);
    mountView(
      ctx,
      el("h2", {}, "Result uncertain"),
      renderNotice(
        data.broken ? "danger" : "info",
        data.broken
          ? "RestoreTime is no longer connected to this workspace. Ask a workspace admin to reinstall this add-on, then reload RestoreTime."
          : "RestoreTime is disabled for this workspace.",
      ),
      renderLineage(ctx, data.lineage),
      back,
    );
    return;
  }

  // docs/00: the UI holds no business rules. The bounded window is the server's decision
  // (docs/07 §8) — deriving it from the browser clock would let a fast clock offer "it was not
  // created" while the server still refuses, and a slow one hide the choice after it is allowed.
  const bounded = data.canMarkNotCreated;

  const nodes: (Node | string)[] = [];
  const errorRegion = el("div", { class: "rt-inline-error", "aria-label": "Status check error" });
  const lineageSection = renderLineage(ctx, data.lineage);
  const lastChecked = reconcile
    ? el("p", {}, `Last checked: ${new Intl.DateTimeFormat(ctx.locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(reconcile.checkedAt))}`)
    : null;

  if (bounded) {
    nodes.push(
      el("p", {}, `We checked Clockify ${checks} times.`),
      ...(lastChecked ? [lastChecked] : []),
      el("p", {}, "The entry does not appear there."),
      el("p", {}, 'If you can see the entry in Clockify, select "It exists". Otherwise select "It was not created".'),
    );
    if (lineageSection) nodes.push(lineageSection);
    const existsButton = el("button", { type: "button" }, "It exists — let me pick it");
    const notCreatedButton = el("button", { type: "button" }, "It was not created");
    const idInput = el("input", { type: "text", autocomplete: "off", spellcheck: "false" });
    const idLabel = el("label", {}, "Clockify time entry ID", idInput);
    idLabel.hidden = true;
    const confirmIdButton = el("button", { type: "button" }, "Use this entry");
    confirmIdButton.hidden = true;
    confirmIdButton.disabled = true;
    existsButton.addEventListener("click", () => {
      idLabel.hidden = false;
      confirmIdButton.hidden = false;
    });
    idInput.addEventListener("input", () => {
      confirmIdButton.disabled = idInput.value.trim().length === 0;
    });
    bindBusyAction({
      ctx,
      button: confirmIdButton,
      busyLabel: "Linking entry…",
      conflictingControls: [existsButton, notCreatedButton],
      action: () => ctx.api.post("/api/entries/resolve-ambiguous", { entryId, newEntryId: idInput.value.trim() }),
      onSuccess: () => ctx.navigate({ kind: "detail", entryId, returnTo }),
      onError: (err) => renderApiError({ region: errorRegion, err, context: "", action: () => renderAmbiguous(ctx, entryId, returnTo), actionLabel: "Recheck entry" }),
    });
    bindBusyAction({
      ctx,
      button: notCreatedButton,
      busyLabel: "Updating status…",
      conflictingControls: [existsButton, confirmIdButton],
      action: () => ctx.api.post("/api/entries/mark-not-created", { entryId }),
      onSuccess: () => backToReturnTarget(ctx, returnTo),
      onError: (err) => renderApiError({ region: errorRegion, err, context: "", action: () => renderAmbiguous(ctx, entryId, returnTo), actionLabel: "Recheck entry" }),
    });
    nodes.push(
      el("p", {}, "Find the time-entry ID in Clockify, then paste it below."),
      errorRegion,
      el("div", { class: "rt-action-group" }, existsButton, notCreatedButton, idLabel, confirmIdButton),
    );
  } else {
    nodes.push(
      el("p", {}, "We do not know whether Clockify created this entry."),
      el("p", {}, "The recreation might have reached Clockify, but RestoreTime did not get a clear result."),
      el("p", { role: "alert" }, "Do not create the entry by hand yet."),
    );
    if (lineageSection) nodes.push(lineageSection);
    const checkNow = el("button", { type: "button" }, "Check now");
    bindBusyAction({
      ctx,
      button: checkNow,
      busyLabel: "Checking…",
      action: () => ctx.api.post("/api/entries/reconcile", { entryId }) as Promise<ReconcileResponse>,
      onSuccess: (res) => handleReconcileOutcome(ctx, entryId, res.result, returnTo),
      onError: (err) => renderApiError({ region: errorRegion, err, context: "", action: () => renderAmbiguous(ctx, entryId, returnTo), actionLabel: "Check status again" }),
    });
    nodes.push(errorRegion, el("div", { class: "rt-action-group" }, checkNow), ...(lastChecked ? [lastChecked] : []));

    const candidateIds = reconcile?.candidateIds ?? [];
    if (candidateIds.length > 0) {
      nodes.push(
        el(
          "section",
          {},
          el("h3", {}, "Clockify shows more than one possible match"),
          el(
            "ul",
            {},
            ...candidateIds.map((id, index) => renderCandidate(ctx, entryId, id, index, data.plan, returnTo, errorRegion)),
          ),
        ),
      );
    }
  }

  nodes.push(resultBackButton(ctx, returnTo));
  mountView(ctx, el("h2", {}, "Result uncertain"), ...nodes);
}

function backToReturnTarget(ctx: Ctx, returnTo: ReturnTarget): void {
  if (returnTo === "bulk-review") {
    ctx.navigate({ kind: "bulk-review", rows: ctx.session.bulkReviewRows ?? [], refresh: true });
    return;
  }
  ctx.navigate({ kind: "list" });
}

function resultBackButton(ctx: Ctx, returnTo: ReturnTarget): HTMLButtonElement {
  const back = el("button", { type: "button" }, returnTo === "bulk-review" ? "Back to review" : "Back to deleted entries");
  back.addEventListener("click", () => backToReturnTarget(ctx, returnTo));
  return back;
}

function handleReconcileOutcome(ctx: Ctx, entryId: string, result: ReconcileResult | null, returnTo: ReturnTarget): void {
  if (result?.kind === "adopted") {
    ctx.navigate({ kind: "detail", entryId, returnTo });
    return;
  }
  renderAmbiguous(ctx, entryId, returnTo);
}

function renderCandidate(
  ctx: Ctx,
  entryId: string,
  candidateId: string,
  index: number,
  plan: RecreationPlan | null,
  returnTo: ReturnTarget,
  errorRegion: HTMLElement,
): HTMLElement {
  const request = plan?.plannedRequest;
  const description = request?.description || "(no description)";
  const start = request ? resultTime(request.start, ctx.locale) ?? request.start : "The planned start time is not available.";
  const end = request?.end ? resultTime(request.end, ctx.locale) ?? request.end : "No end time";
  const project = plan?.presentation?.project?.outcome === "dropped" ? "No project" : plan?.presentation?.project?.name;
  const task = plan?.presentation?.task?.outcome === "dropped" ? "No task" : plan?.presentation?.task?.name;
  const useMatch = el("button", { type: "button", "data-candidate-action": "" }, "Use this match");
  bindBusyAction({
    ctx,
    button: useMatch,
    busyLabel: "Linking entry…",
    conflictingControls: () => Array.from(ctx.root.querySelectorAll<HTMLButtonElement>("[data-candidate-action]")),
    action: () => ctx.api.post("/api/entries/resolve-ambiguous", { entryId, newEntryId: candidateId }),
    onSuccess: () => ctx.navigate({ kind: "detail", entryId, returnTo }),
    onError: (err) => renderApiError({ region: errorRegion, err, context: "", action: () => renderAmbiguous(ctx, entryId, returnTo), actionLabel: "Recheck entry" }),
  });
  return el(
    "li",
    { class: "rt-card" },
    el("h4", {}, `Possible match ${index + 1}`),
    el("p", {}, "This entry matched the planned recreation during the last check."),
    el("p", {}, description),
    el("p", {}, `Planned start: ${start}`),
    el("p", {}, `Planned end: ${end}`),
    ...(project ? [el("p", {}, `Project: ${project}`)] : []),
    ...(task ? [el("p", {}, `Task: ${task}`)] : []),
    el("p", {}, `Entry reference ending ${candidateId.slice(-6)}`),
    el("details", {}, el("summary", {}, "Show full technical reference"), el("p", {}, candidateId)),
    useMatch,
  );
}
