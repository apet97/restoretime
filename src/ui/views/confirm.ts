// Confirm view (docs/10 §5). The exact planned values, warnings and differences, a fidelity
// badge, and the one primary action. Every confirm is revalidated server-side (docs/07 §7),
// regardless of the plan's age; this view never checks the plan itself, it just sends `planId`
// and handles whatever the server decides (a 200 outcome, or a 409 `stale` with a fresh plan to
// show instead).

import { el } from "../dom.js";
import { fidelityLabel } from "../format.js";
import { renderFactsTable } from "./detail.js";
import type { Ctx, ResolutionDraft, ReturnTarget } from "../state.js";
import { ApiError, MutationTransportError } from "../api.js";
import { bindBusyAction, mountView, renderApiError, renderDifferences, renderNotice, renderWarningMessages } from "./shared.js";
import { renderResult } from "./result.js";
import type { DeletedTimeEntry, RecreateResponse, RecreationPlan } from "../types.js";

/** docs/10 §5: "the exact planned values (as in the detail view's NEW ENTRY column)". The same
 * cell renderers the detail view uses, so the user confirms values they can read — a raw Clockify
 * id is not a value anyone can check a recreation against. */
export function renderConfirm(
  ctx: Ctx,
  entryId: string,
  plan: RecreationPlan,
  source: DeletedTimeEntry,
  disabled = false,
  draft?: ResolutionDraft,
  returnTo: ReturnTarget = "list",
): void {
  const heading = el("h2", {}, "Confirm recreation");
  const nodes: (Node | string)[] = [
    renderFactsTable(source, plan, ctx.locale, draft?.labels),
    el("p", {}, el("strong", {}, "Fidelity: "), fidelityLabel(plan.fidelity)),
    fidelityExplanation(plan.fidelity),
    el("p", {}, "RestoreTime will create one new time entry in Clockify with these values. The deleted entry's history stays unchanged."),
  ];

  const warnings = renderWarningMessages(plan.warnings);
  if (warnings) nodes.push(el("section", {}, el("h3", {}, "Warnings"), warnings));
  nodes.push(renderDifferences(plan));

  const backButton = el("button", { type: "button" }, returnTo === "bulk-review" ? "Back to review" : "Back to entry");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId, forceResolve: true, ...(draft ? { draft } : {}), returnTo }));

  // docs/10 §8: while the addon is disabled the notice replaces the action. The server refuses it
  // too (routes.ts `actionGuard`); this keeps the user from being told "yes" and then "no".
  if (disabled) {
    nodes.push(renderNotice("info", "RestoreTime is disabled for this workspace."), backButton);
    mountView(ctx, heading, ...nodes);
    return;
  }

  if (plan.presentation === null) {
    const refresh = el("button", { type: "button", class: "rt-primary" }, "Check the plan again");
    refresh.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId, forceResolve: true, ...(draft ? { draft } : {}), returnTo }));
    nodes.push(renderNotice("warning", "This saved plan does not have the details needed for confirmation."), refresh, backButton);
    mountView(ctx, heading, ...nodes);
    return;
  }

  const confirmButton = el("button", { type: "button", class: "rt-primary" }, "Recreate entry");
  const errorRegion = el("div", { class: "rt-inline-error", "aria-label": "Recreation error" });
  bindBusyAction({
    ctx,
    button: confirmButton,
    busyLabel: "Recreating…",
    action: () => ctx.api.mutate("/api/entries/recreate", { entryId, planId: plan.id }) as Promise<RecreateResponse>,
    onSuccess: (res) => {
        if (!isRecreateResponse(res)) {
          renderUnknownMutation(ctx, entryId, returnTo);
          return;
        }
        // docs/10 §10 bridge integration: showToast alongside the success view's navigate("tracker")
        // — a toast only on the mutation that just happened, never when a stored RECREATED entry is
        // reopened later (renderResult/renderSuccess is shared with that read-only path).
        if (res.result.outcome === "RECREATED") ctx.bridge.showToast("success", "Time entry recreated.");
        renderResult(ctx, entryId, plan, res.result, undefined, returnTo);
    },
    onError: (err) => handleConfirmError(ctx, entryId, plan, source, draft, returnTo, errorRegion, err),
  });

  nodes.push(errorRegion, el("div", { class: "rt-action-group" }, confirmButton, backButton));
  mountView(ctx, heading, ...nodes);
}

function fidelityExplanation(fidelity: RecreationPlan["fidelity"]): HTMLElement {
  switch (fidelity) {
    case "FULL": return el("p", {}, "All supported values from the deleted entry are included.");
    case "ADJUSTED": return el("p", {}, "The new entry includes the choices you made during review.");
    case "PARTIAL": return el("p", {}, "Some values from the deleted entry cannot be included. Review the differences below.");
    case "IMPOSSIBLE": return el("p", {}, "This plan cannot create a new entry.");
  }
}

function isRecreateResponse(value: unknown): value is RecreateResponse {
  if (typeof value !== "object" || value === null || !("result" in value)) return false;
  const result = (value as { result?: unknown }).result;
  if (typeof result !== "object" || result === null || !("outcome" in result)) return false;
  const outcome = (result as { outcome?: unknown }).outcome;
  return outcome === "RECREATED" || outcome === "FAILED" || outcome === "AMBIGUOUS";
}

/** An unknown write result opens the entry status and never offers a retry. A stale plan or a lost
 * claim race (both 409, docs/07 §7) goes back to the resolve flow, which re-runs preflight and hands
 * the user a current plan. Other operational failures re-show this confirm view. */
function handleConfirmError(
  ctx: Ctx,
  entryId: string,
  plan: RecreationPlan,
  source: DeletedTimeEntry,
  draft: ResolutionDraft | undefined,
  returnTo: ReturnTarget,
  errorRegion: HTMLElement,
  err: unknown,
): void {
  if (err instanceof MutationTransportError) {
    renderUnknownMutation(ctx, entryId, returnTo);
    return;
  }
  if (
    err instanceof ApiError &&
    typeof err.body === "object" &&
    err.body !== null &&
    "unknownResult" in err.body &&
    (err.body as { unknownResult: unknown }).unknownResult === true
  ) {
    renderApiError({ region: errorRegion, err, context: "", action: () => ctx.navigate({ kind: "detail", entryId, returnTo }), actionLabel: "Open entry" });
    return;
  }
  if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
    renderApiError({ region: errorRegion, err, context: "", action: () => ctx.navigate({ kind: "detail", entryId, forceResolve: true, returnTo }), actionLabel: "Review a new plan" });
    return;
  }
  renderApiError({ region: errorRegion, err, context: "", action: () => ctx.navigate({ kind: "confirm", entryId, plan, source, ...(draft ? { draft } : {}), returnTo }), actionLabel: "Review a new plan" });
}

function renderUnknownMutation(ctx: Ctx, entryId: string, returnTo: ReturnTarget): void {
  const open = el("button", { type: "button", class: "rt-primary" }, "Open entry");
  open.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId, returnTo }));
  const back = el("button", { type: "button" }, returnTo === "bulk-review" ? "Back to review" : "Back to deleted entries");
  back.addEventListener("click", () => returnTo === "bulk-review" ? ctx.navigate({ kind: "bulk-review", rows: ctx.session.bulkReviewRows ?? [], refresh: true }) : ctx.navigate({ kind: "list" }));
  mountView(
    ctx,
    el("h2", {}, "Result uncertain"),
    el("p", {}, "We do not know whether the entry was recreated."),
    el("p", {}, "RestoreTime did not receive a response after it sent the request."),
    el("p", { role: "alert" }, "Do not recreate the entry again. Open it and check its current status."),
    el("div", { class: "rt-action-group" }, open, back),
  );
}
