// Result views (docs/10 §6). Every branch answers the three questions docs/10 §8 requires: what
// happened, whether anything was created, what to do next. The "unknown result" view never implies
// the entry was not created — it says plainly that Clockify's answer never arrived.

import { el, mount } from "../dom.js";
import type { Ctx } from "../state.js";
import type { AttemptRecreationResult, DetailResponse, ReconcileResponse, ReconcileResult, RecreationPlan } from "../types.js";
import { fidelityLabel } from "../format.js";
import { renderApiError, renderDifferences, runAction, withLoading } from "./shared.js";

export function renderResult(ctx: Ctx, entryId: string, plan: RecreationPlan, result: AttemptRecreationResult): void {
  if (result.outcome === "RECREATED") {
    renderSuccess(ctx, plan, result);
  } else if (result.outcome === "FAILED") {
    renderFailed(ctx, entryId, result);
  } else {
    renderAmbiguous(ctx, entryId);
  }
}

// --- Success (docs/10 §6) -------------------------------------------------------------------

function renderSuccess(ctx: Ctx, plan: RecreationPlan, result: Extract<AttemptRecreationResult, { outcome: "RECREATED" }>): void {
  const nodes: (Node | string)[] = [
    el("h2", {}, "Time entry recreated."),
    el("p", {}, `Fidelity: ${fidelityLabel(plan.fidelity)}.`),
    renderDifferences(plan),
  ];

  if (result.diffs.length > 0) {
    nodes.push(
      el(
        "section",
        {},
        el("h3", {}, "Clockify applied these changes"),
        el(
          "ul",
          {},
          ...result.diffs
            .filter((d) => d.field !== "_verification")
            .map((d) => el("li", {}, `${d.field}: planned ${JSON.stringify(d.planned)}, actual ${JSON.stringify(d.actual)}`)),
        ),
      ),
    );
  }

  const openButton = el("button", { type: "button", class: "rt-primary" }, "Open in Clockify tracker");
  openButton.addEventListener("click", () => ctx.bridge.navigate("tracker"));
  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));
  nodes.push(el("div", {}, openButton, backButton));

  mount(ctx.root, ...nodes);
}

// --- Failed (docs/10 §6) --------------------------------------------------------------------

function renderFailed(ctx: Ctx, entryId: string, result: Extract<AttemptRecreationResult, { outcome: "FAILED" }>): void {
  const tryAgain = el("button", { type: "button" }, "Try again");
  tryAgain.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId, forceResolve: true }));
  mount(
    ctx.root,
    el("h2", {}, "Clockify did not create the entry."),
    el("p", {}, `Reason: ${result.message}`),
    el("p", {}, "Nothing was created. You can change your selections and try again."),
    tryAgain,
  );
}

// --- Unknown result / AMBIGUOUS (docs/10 §6) ------------------------------------------------

function formatClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderAmbiguous(ctx: Ctx, entryId: string): void {
  void withLoading(
    ctx,
    () => ctx.api.get("/api/entries/detail", { id: entryId }) as Promise<DetailResponse>,
    (data) => renderAmbiguousBody(ctx, entryId, data),
    "Checking the latest status…",
  );
}

function renderAmbiguousBody(ctx: Ctx, entryId: string, data: DetailResponse): void {
  const latestAttempt = data.attempts.find((a) => a.outcome === "AMBIGUOUS" || (a.outcome === null && a.finishedAt === null)) ?? data.attempts[0];
  const reconcile = latestAttempt?.reconcile ?? null;
  const checks = reconcile?.checks ?? 0;
  // docs/00: the UI holds no business rules. The bounded window is the server's decision
  // (docs/07 §8) — deriving it from the browser clock would let a fast clock offer "it was not
  // created" while the server still refuses, and a slow one hide the choice after it is allowed.
  const bounded = data.canMarkNotCreated;

  const nodes: (Node | string)[] = [];

  if (bounded) {
    nodes.push(
      el("h2", {}, `We checked Clockify ${checks} times.`),
      el("p", {}, "The entry does not appear there."),
      el("p", {}, 'If you can see the entry in Clockify, select "It exists". Otherwise select "It was not created".'),
    );
    const existsButton = el("button", { type: "button" }, "It exists — let me pick it");
    const notCreatedButton = el("button", { type: "button" }, "It was not created");
    const idInput = el("input", { type: "text", placeholder: "Clockify time entry id" });
    idInput.hidden = true;
    const confirmIdButton = el("button", { type: "button" }, "Use this entry");
    confirmIdButton.hidden = true;
    existsButton.addEventListener("click", () => {
      idInput.hidden = false;
      confirmIdButton.hidden = false;
    });
    confirmIdButton.addEventListener("click", () => {
      const newEntryId = idInput.value.trim();
      if (!newEntryId) return;
      void runAction(
        ctx,
        () => ctx.api.post("/api/entries/resolve-ambiguous", { entryId, newEntryId }),
        () => ctx.navigate({ kind: "detail", entryId }),
        (err) => renderApiError(ctx.root, err, () => renderAmbiguous(ctx, entryId)),
      );
    });
    notCreatedButton.addEventListener("click", () => {
      void runAction(
        ctx,
        () => ctx.api.post("/api/entries/mark-not-created", { entryId }),
        () => ctx.navigate({ kind: "list" }),
        (err) => renderApiError(ctx.root, err, () => renderAmbiguous(ctx, entryId)),
      );
    });
    nodes.push(el("div", {}, existsButton, notCreatedButton, idInput, confirmIdButton));
  } else {
    nodes.push(
      el("h2", {}, "We do not know whether Clockify created this entry."),
      el("p", {}, "The request was sent, but Clockify's answer did not arrive."),
      el("p", { role: "alert" }, "Do not create the entry by hand yet."),
    );
    const checkNow = el("button", { type: "button" }, "Check now");
    checkNow.addEventListener("click", () => {
      void runAction(
        ctx,
        () => ctx.api.post("/api/entries/reconcile", { entryId }) as Promise<ReconcileResponse>,
        (res) => handleReconcileOutcome(ctx, entryId, res.result),
        (err) => renderApiError(ctx.root, err, () => renderAmbiguous(ctx, entryId)),
      );
    });
    const lastChecked = reconcile ? el("span", {}, ` Last checked: ${formatClock(reconcile.checkedAt)}`) : null;
    nodes.push(el("div", {}, checkNow, ...(lastChecked ? [lastChecked] : [])));

    if (reconcile && reconcile.candidateIds.length > 1) {
      nodes.push(
        el(
          "section",
          {},
          el("h3", {}, "Clockify shows more than one possible match"),
          el(
            "ul",
            {},
            ...reconcile.candidateIds.map((id) => {
              const adopt = el("button", { type: "button" }, `Adopt ${id}`);
              adopt.addEventListener("click", () => {
                void runAction(
                  ctx,
                  () => ctx.api.post("/api/entries/resolve-ambiguous", { entryId, newEntryId: id }),
                  () => ctx.navigate({ kind: "detail", entryId }),
                  (err) => renderApiError(ctx.root, err, () => renderAmbiguous(ctx, entryId)),
                );
              });
              return el("li", {}, id, " ", adopt);
            }),
          ),
        ),
      );
    }
  }

  mount(ctx.root, ...nodes);
}

function handleReconcileOutcome(ctx: Ctx, entryId: string, result: ReconcileResult | null): void {
  if (result && (result.kind === "adopted" || result.kind === "one")) {
    ctx.navigate({ kind: "detail", entryId });
    return;
  }
  renderAmbiguous(ctx, entryId);
}
