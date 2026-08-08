// Confirm view (docs/10 §5). The exact planned values, warnings and differences, a fidelity
// badge, and the one primary action. A plan older than 5 minutes is revalidated on confirm
// regardless — that is a server-side rule (docs/07 §7); this view never checks the plan's age
// itself, it just sends `planId` and handles whatever the server decides (a 200 outcome, or a 409
// `stale` with a fresh plan to show instead).

import { el, mount } from "../dom.js";
import { fidelityLabel, formatEntryHeader } from "../format.js";
import type { Ctx } from "../state.js";
import { ApiError } from "../api.js";
import { renderApiError, renderDifferences, renderWarningMessages, runAction } from "./shared.js";
import { renderResult } from "./result.js";
import type { RecreateResponse, RecreationPlan } from "../types.js";

function plannedFacts(plan: RecreationPlan, locale: string): HTMLElement {
  const p = plan.plannedRequest;
  const rows: [string, string][] = [
    ["Date and time", formatEntryHeader(p.start, p.end ?? null, locale)],
    ["Description", p.description ?? ""],
    ["Billable", (p.billable ?? false) ? "yes" : "no"],
    ["Project", p.projectId ?? "— (no project)"],
    ["Task", p.taskId ?? "—"],
    ["Tags", (p.tagIds ?? []).length > 0 ? `${(p.tagIds ?? []).length} tag(s)` : "none"],
  ];
  return el(
    "table",
    {},
    el("caption", {}, "New entry (planned)"),
    el("tbody", {}, ...rows.map(([label, value]) => el("tr", {}, el("th", {}, label), el("td", {}, value)))),
  );
}

export function renderConfirm(ctx: Ctx, entryId: string, plan: RecreationPlan): void {
  const nodes: (Node | string)[] = [
    el("h2", {}, "Confirm recreation"),
    plannedFacts(plan, ctx.locale),
    el("p", {}, el("strong", {}, "Fidelity: "), fidelityLabel(plan.fidelity)),
  ];

  const warnings = renderWarningMessages(plan.warnings);
  if (warnings) nodes.push(el("section", {}, el("h3", {}, "Warnings"), warnings));
  nodes.push(renderDifferences(plan));

  const confirmButton = el("button", { type: "button" }, "Recreate entry");
  const backButton = el("button", { type: "button" }, "Back");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId }));

  confirmButton.addEventListener("click", () => {
    confirmButton.toggleAttribute("disabled", true);
    void runAction(
      ctx,
      () => ctx.api.post("/api/entries/recreate", { entryId, planId: plan.id }) as Promise<RecreateResponse>,
      (res) => {
        // docs/10 §10 bridge integration: showToast alongside the success view's navigate("tracker")
        // — a toast only on the mutation that just happened, never when a stored RECREATED entry is
        // reopened later (renderResult/renderSuccess is shared with that read-only path).
        if (res.result.outcome === "RECREATED") ctx.bridge.showToast("success", "Time entry recreated.");
        renderResult(ctx, entryId, plan, res.result);
      },
      (err) => handleConfirmError(ctx, entryId, plan, err, confirmButton),
    );
  });

  nodes.push(el("div", {}, confirmButton, backButton));
  mount(ctx.root, ...nodes);
}

/** A stale plan or a lost claim race (both 409, docs/07 §7) goes back to the resolve flow, which
 * re-runs preflight and hands the user a plan that is definitely current — a stale response already
 * carries the fresh plan, but re-fetching costs one extra round trip and guarantees the detail view
 * and the plan agree. Any other failure (a transport error) just re-shows this same confirm view so
 * the user can press the button again without losing their place. */
function handleConfirmError(ctx: Ctx, entryId: string, plan: RecreationPlan, err: unknown, confirmButton: HTMLButtonElement): void {
  confirmButton.toggleAttribute("disabled", false);
  if (err instanceof ApiError && (err.status === 409 || err.status === 422)) {
    renderApiError(ctx.root, err, () => ctx.navigate({ kind: "detail", entryId, forceResolve: true }));
    return;
  }
  renderApiError(ctx.root, err, () => ctx.navigate({ kind: "confirm", entryId, plan }));
}
