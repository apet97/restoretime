// Shared rendering helpers used by more than one view: the loading/error scaffold, the
// session-expired takeover (docs/10 §8), and the warnings/differences block that both the detail
// view and the confirm view show verbatim (docs/10 §3, §5 — "Warnings and differences").

import { ApiError, SessionExpiredError } from "../api.js";
import { el, mount } from "../dom.js";
import type { Ctx } from "../state.js";
import type { PlanBlocker, PlanWarning, RecreationPlan } from "../types.js";

export function renderLoading(root: HTMLElement, label = "Loading…"): void {
  mount(root, el("p", { role: "status" }, label));
}

/** docs/10 §8: on a refresh timeout, "Reload the component" — the shell cannot recover a session
 * on its own (reloading re-reads `?auth_token` from the iframe URL Clockify controls). */
export function renderSessionExpired(root: HTMLElement): void {
  mount(
    root,
    el(
      "section",
      {},
      el("h2", {}, "Your session expired"),
      el("p", {}, "RestoreTime could not refresh your connection to Clockify. Reload the component."),
    ),
  );
}

/** Runs an API call, mounts a loading placeholder first, and routes a session timeout to the
 * takeover view — every view's data-loading entry point goes through this so that behavior is
 * identical everywhere instead of re-implemented per view. */
export async function withLoading<T>(ctx: Ctx, load: () => Promise<T>, onLoaded: (value: T) => void, loadingLabel?: string): Promise<void> {
  renderLoading(ctx.root, loadingLabel);
  try {
    const value = await load();
    onLoaded(value);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      renderSessionExpired(ctx.root);
      return;
    }
    renderApiError(ctx.root, err, () => void withLoading(ctx, load, onLoaded, loadingLabel));
  }
}

/** Runs a button-triggered action (no loading placeholder — the current view stays on screen while
 * it runs). Routes a session timeout to the takeover view exactly like `withLoading`; any other
 * error is handed to `onError` so the caller can decide where to show it (inline, or by re-showing
 * the current view with an error banner). */
export async function runAction<T>(ctx: Ctx, action: () => Promise<T>, onSuccess: (value: T) => void, onError: (err: unknown) => void): Promise<void> {
  try {
    const value = await action();
    onSuccess(value);
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      renderSessionExpired(ctx.root);
      return;
    }
    onError(err);
  }
}

/** A failed API call outside the initial load (a button action). docs/10 §8: every failure view
 * answers what happened, whether anything was created, and what to do next — a bare network/read
 * failure answers the first and third; the second is "nothing, this call never reached a mutation"
 * for every case this helper is used on (reads, and preflight, which never mutates Clockify). */
export function renderApiError(root: HTMLElement, err: unknown, retry: () => void): void {
  const message = err instanceof ApiError ? apiErrorMessage(err) : "RestoreTime could not complete that request.";
  const retryButton = el("button", { type: "button" }, "Try again");
  retryButton.addEventListener("click", retry);
  mount(root, el("section", {}, el("p", {}, message), retryButton));
}

function apiErrorMessage(err: ApiError): string {
  const body = err.body;
  if (typeof body === "object" && body !== null && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return `RestoreTime could not complete that request (status ${err.status}).`;
}

/** docs/10 §3 "Differences" section: the fixed system-differences sentence, always shown, plus
 * plan-specific warnings each in "what changed — why — what the new entry will contain" form. Both
 * come straight from `plan.warnings` (server-computed); this only lays them out. */
export function renderDifferences(plan: RecreationPlan): HTMLElement {
  const systemDiffs = el(
    "div",
    {},
    el("p", {}, "The new entry always differs from the deleted entry:"),
    el(
      "ul",
      {},
      el("li", {}, "It has a new ID and a new creation time."),
      el("li", {}, "It is not part of any approval request."),
      el("li", {}, "It is not linked to any invoice."),
      el("li", {}, "Clockify applies the rates that are current today."),
    ),
  );
  // P-SYS is the same fixed sentence rendered above; every other warning is plan-specific.
  const planWarnings = plan.warnings.filter((w) => w.ruleId !== "P-SYS");
  const warningsList =
    planWarnings.length > 0
      ? el(
          "ul",
          {},
          ...planWarnings.map((w) => el("li", {}, w.message)),
        )
      : null;
  return el("section", {}, el("h3", {}, "Differences"), systemDiffs, ...(warningsList ? [warningsList] : []));
}

export function renderBlockers(blockers: readonly PlanBlocker[]): HTMLElement | null {
  if (blockers.length === 0) return null;
  return el(
    "section",
    {},
    el("h3", {}, "This entry cannot be recreated yet"),
    el("ul", {}, ...blockers.map((b) => el("li", {}, b.message))),
  );
}

export function renderWarningMessages(warnings: readonly PlanWarning[]): HTMLElement | null {
  const shown = warnings.filter((w) => w.ruleId !== "P-SYS");
  if (shown.length === 0) return null;
  return el("ul", {}, ...shown.map((w) => el("li", {}, w.message)));
}
