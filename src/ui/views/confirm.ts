// Confirm view (docs/10 §5). The exact planned values, warnings and differences, a fidelity
// badge, and the one primary action. Every confirm is revalidated server-side (docs/07 §7),
// regardless of the plan's age; this view never checks the plan itself, it just sends `planId`
// and handles whatever the server decides (a 200 outcome, or a 409 `stale` with a fresh plan to
// show instead).

import { el, mount } from "../dom.js";
import { fidelityLabel } from "../format.js";
import { renderFactsTable } from "./detail.js";
import type { Ctx, ResolutionDraft } from "../state.js";
import { ApiError, MutationTransportError } from "../api.js";
import { renderApiError, renderDifferences, renderWarningMessages, runAction } from "./shared.js";
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
): void {
  const nodes: (Node | string)[] = [
    el("h2", {}, "Confirm recreation"),
    renderFactsTable(source, plan, ctx.locale, draft?.labels),
    el("p", {}, el("strong", {}, "Fidelity: "), fidelityLabel(plan.fidelity)),
  ];

  const warnings = renderWarningMessages(plan.warnings);
  if (warnings) nodes.push(el("section", {}, el("h3", {}, "Warnings"), warnings));
  nodes.push(renderDifferences(plan));

  const backButton = el("button", { type: "button" }, "Back");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId, forceResolve: true, ...(draft ? { draft } : {}) }));

  // docs/10 §8: while the addon is disabled the notice replaces the action. The server refuses it
  // too (routes.ts `actionGuard`); this keeps the user from being told "yes" and then "no".
  if (disabled) {
    nodes.push(el("p", { role: "alert" }, "RestoreTime is disabled for this workspace."), backButton);
    mount(ctx.root, ...nodes);
    return;
  }

  if (plan.presentation === null) {
    const refresh = el("button", { type: "button", class: "rt-primary" }, "Check the plan again");
    refresh.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId, forceResolve: true, ...(draft ? { draft } : {}) }));
    nodes.push(el("p", { role: "alert" }, "This saved plan does not have the details needed for confirmation."), refresh, backButton);
    mount(ctx.root, ...nodes);
    return;
  }

  const confirmButton = el("button", { type: "button", class: "rt-primary" }, "Recreate entry");

  confirmButton.addEventListener("click", () => {
    confirmButton.toggleAttribute("disabled", true);
    void runAction(
      ctx,
      () => ctx.api.mutate("/api/entries/recreate", { entryId, planId: plan.id }) as Promise<RecreateResponse>,
      (res) => {
        if (!isRecreateResponse(res)) {
          renderUnknownMutation(ctx, entryId);
          return;
        }
        // docs/10 §10 bridge integration: showToast alongside the success view's navigate("tracker")
        // — a toast only on the mutation that just happened, never when a stored RECREATED entry is
        // reopened later (renderResult/renderSuccess is shared with that read-only path).
        if (res.result.outcome === "RECREATED") ctx.bridge.showToast("success", "Time entry recreated.");
        renderResult(ctx, entryId, plan, res.result);
      },
      (err) => handleConfirmError(ctx, entryId, plan, source, draft, err, confirmButton),
    );
  });

  nodes.push(el("div", {}, confirmButton, backButton));
  mount(ctx.root, ...nodes);
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
  err: unknown,
  confirmButton: HTMLButtonElement,
): void {
  if (err instanceof MutationTransportError) {
    renderUnknownMutation(ctx, entryId);
    return;
  }
  confirmButton.toggleAttribute("disabled", false);
  if (
    err instanceof ApiError &&
    typeof err.body === "object" &&
    err.body !== null &&
    "unknownResult" in err.body &&
    (err.body as { unknownResult: unknown }).unknownResult === true
  ) {
    renderApiError(ctx.root, err, () => ctx.navigate({ kind: "detail", entryId }), "Open entry");
    return;
  }
  if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
    renderApiError(ctx.root, err, () => ctx.navigate({ kind: "detail", entryId, forceResolve: true }));
    return;
  }
  renderApiError(ctx.root, err, () => ctx.navigate({ kind: "confirm", entryId, plan, source, ...(draft ? { draft } : {}) }));
}

function renderUnknownMutation(ctx: Ctx, entryId: string): void {
  const open = el("button", { type: "button", class: "rt-primary" }, "Open entry");
  open.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId }));
  mount(
    ctx.root,
    el("h2", {}, "We do not know whether the entry was recreated."),
    el("p", {}, "RestoreTime did not receive a response after it sent the request."),
    el("p", { role: "alert" }, "Do not recreate the entry again. Open it and check its current status."),
    open,
  );
}
