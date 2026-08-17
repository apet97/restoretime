// Shared rendering helpers used by more than one view: the loading/error scaffold, the
// session-expired takeover (docs/10 §8), and the warnings/differences block that both the detail
// view and the confirm view show verbatim (docs/10 §3, §5 — "Warnings and differences").

import { ApiError, MutationTransportError, SessionExpiredError } from "../api.js";
import { clear, el, mount } from "../dom.js";
import type { StatusPresentation } from "../format.js";
import type { Ctx } from "../state.js";
import type { DetailResponse, PlanBlocker, PlanWarning, RecreationPlan } from "../types.js";

/** The one CSS-only progress marker (`.rt-busy-spinner` in app.css). `aria-hidden`: the busy label
 * or status text beside it already says what is happening. */
export function renderSpinner(): HTMLElement {
  return el("span", { class: "rt-busy-spinner", "aria-hidden": "true" });
}

export function renderLoading(root: HTMLElement, label = "Loading…"): void {
  mount(root, el("p", { role: "status", class: "rt-loading" }, renderSpinner(), label));
}

/** docs/10 §8: on a refresh timeout, "Reload the component" — the shell cannot recover a session
 * on its own (reloading re-reads `?auth_token` from the iframe URL Clockify controls). */
export function mountView(ctx: Ctx, heading: HTMLHeadingElement, ...children: (Node | string | null)[]): void {
  heading.setAttribute("data-view-heading", "");
  heading.setAttribute("tabindex", "-1");
  mount(ctx.root, heading, ...children);
  try {
    heading.focus({ preventScroll: true });
  } catch {
    heading.focus();
  }
  ctx.announce(heading.textContent ?? "RestoreTime");
}

export function renderSessionExpired(ctx: Ctx): void {
  const heading = el("h2", {}, "Your session expired");
  const reload = el("button", { type: "button", class: "rt-primary" }, "Reload RestoreTime");
  let used = false;
  reload.addEventListener("click", () => {
    if (used) return;
    used = true;
    reload.disabled = true;
    ctx.reload();
  });
  mountView(
    ctx,
    heading,
    el("p", {}, "RestoreTime could not refresh your connection to Clockify. Reload RestoreTime."),
    reload,
  );
}

const requestGenerations = new WeakMap<Ctx, number>();

interface ViewGeneration {
  readonly navigationVersion: number;
  readonly requestGeneration: number;
}

function currentRequestGeneration(ctx: Ctx): number {
  return requestGenerations.get(ctx) ?? 0;
}

function beginRequest(ctx: Ctx): ViewGeneration {
  const generation = {
    navigationVersion: ctx.getNavigationVersion(),
    requestGeneration: currentRequestGeneration(ctx) + 1,
  };
  requestGenerations.set(ctx, generation.requestGeneration);
  return generation;
}

function captureViewGeneration(ctx: Ctx): ViewGeneration {
  return {
    navigationVersion: ctx.getNavigationVersion(),
    requestGeneration: currentRequestGeneration(ctx),
  };
}

function isCurrentView(ctx: Ctx, generation: ViewGeneration): boolean {
  return ctx.getNavigationVersion() === generation.navigationVersion && currentRequestGeneration(ctx) === generation.requestGeneration;
}

/** Runs an API call, mounts a loading placeholder first, and routes a session timeout to the
 * takeover view — every view's data-loading entry point goes through this so that behavior is
 * identical everywhere instead of re-implemented per view. */
export async function withLoading<T>(
  ctx: Ctx,
  load: () => Promise<T>,
  onLoaded: (value: T) => void,
  loadingLabel: string | undefined,
  errorActionLabel: string,
): Promise<void> {
  const generation = beginRequest(ctx);
  renderLoading(ctx.root, loadingLabel);
  try {
    const value = await load();
    if (!isCurrentView(ctx, generation)) return;
    onLoaded(value);
  } catch (err) {
    if (!isCurrentView(ctx, generation)) return;
    if (err instanceof SessionExpiredError) {
      ctx.navigate({ kind: "session-expired" });
      return;
    }
    renderInitialLoadError(ctx, err, () => void withLoading(ctx, load, onLoaded, loadingLabel, errorActionLabel), errorActionLabel);
  }
}

/** Runs a button-triggered action (no loading placeholder — the current view stays on screen while
 * it runs). Routes a session timeout to the takeover view exactly like `withLoading`; any other
 * error is handed to `onError` so the caller can decide where to show it (inline, or by re-showing
 * the current view with an error banner). */
export async function runAction<T>(ctx: Ctx, action: () => Promise<T>, onSuccess: (value: T) => void, onError: (err: unknown) => void): Promise<void> {
  const generation = beginRequest(ctx);
  try {
    const value = await action();
    if (!isCurrentView(ctx, generation)) return;
    onSuccess(value);
  } catch (err) {
    if (!isCurrentView(ctx, generation)) return;
    if (err instanceof SessionExpiredError) {
      ctx.navigate({ kind: "session-expired" });
      return;
    }
    onError(err);
  }
}

/** Runs a view's optional background read without replacing the current DOM. The read observes the
 * current foreground generation but does not start a new one, so sibling background reads can run
 * together. A later load or navigation invalidates only that consumer, including a consumer of a
 * promise cached by another render. */
export async function runBackgroundRequest<T>(
  ctx: Ctx,
  load: () => Promise<T>,
  onLoaded: (value: T) => void,
  onError: (err: unknown) => void = () => undefined,
): Promise<void> {
  const generation = captureViewGeneration(ctx);
  try {
    const value = await load();
    if (!isCurrentView(ctx, generation)) return;
    onLoaded(value);
  } catch (err) {
    if (!isCurrentView(ctx, generation)) return;
    if (err instanceof SessionExpiredError) {
      ctx.navigate({ kind: "session-expired" });
      return;
    }
    onError(err);
  }
}

export type NoticeTone = "danger" | "warning" | "info" | "success";

export function renderNotice(tone: NoticeTone, message: string, title?: string): HTMLElement {
  return el(
    "section",
    { class: `rt-notice rt-notice--${tone}` },
    ...(title ? [el("h3", {}, title)] : []),
    el("p", {}, message),
  );
}

export function renderStatusPill(presentation: StatusPresentation): HTMLElement {
  return el("span", { class: `rt-status-pill rt-status-pill--${presentation.tone}` }, presentation.label);
}

export interface ApiErrorOptions {
  readonly region: HTMLElement;
  readonly err: unknown;
  readonly context: string;
  readonly action: () => void;
  readonly actionLabel: string;
}

/** Renders an action error inside its named region. The caller keeps the surrounding view mounted. */
export function renderApiError({ region, err, context, action, actionLabel }: ApiErrorOptions): void {
  clear(region);
  const notice = renderNotice("danger", `${context} ${errorMessage(err)}`.trim());
  notice.setAttribute("role", "alert");
  const actionButton = el("button", { type: "button", class: "rt-primary" }, actionLabel);
  actionButton.addEventListener("click", action);
  region.append(notice, actionButton);
}

function errorMessage(err: unknown): string {
  if (err instanceof MutationTransportError) {
    return "RestoreTime did not receive a response. The request might have reached RestoreTime. Check the current status before you act again.";
  }
  if (!(err instanceof ApiError)) return "RestoreTime could not complete this request.";
  const body = err.body;
  if (typeof body === "object" && body !== null && !Array.isArray(body) && "error" in body && typeof (body as { error: unknown }).error === "string") {
    const message = (body as { error: string }).error;
    if (message.length <= 500) return message;
  }
  return "RestoreTime could not complete this request.";
}

function renderInitialLoadError(ctx: Ctx, err: unknown, action: () => void, actionLabel: string): void {
  const heading = el("h2", {}, "RestoreTime could not load this view");
  const errorRegion = el("div", { class: "rt-inline-error" });
  renderApiError({ region: errorRegion, err, context: "", action, actionLabel });
  mountView(ctx, heading, errorRegion);
}

export interface BusyActionOptions<T> {
  readonly ctx: Ctx;
  readonly button: HTMLButtonElement;
  readonly busyLabel: string;
  readonly conflictingControls?: readonly (HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] | (() => readonly (HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[]);
  readonly action: () => Promise<T>;
  readonly onSuccess: (value: T) => void;
  readonly onError: (err: unknown) => void;
}

/** Adds one single-flight button action while preserving the existing runAction transport rules. */
export function bindBusyAction<T>(options: BusyActionOptions<T>): void {
  const { ctx, button, busyLabel, action, onSuccess, onError } = options;
  const originalLabel = button.textContent ?? "";
  let busy = false;
  button.addEventListener("click", () => {
    if (busy || button.disabled) return;
    busy = true;
    const conflicts = typeof options.conflictingControls === "function" ? options.conflictingControls() : (options.conflictingControls ?? []);
    const controls = [...new Set([button, ...conflicts])];
    const previous = controls.map((control) => ({ control, disabled: control.disabled }));
    for (const { control } of previous) control.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", originalLabel);
    button.textContent = busyLabel;
    button.prepend(renderSpinner());
    void runAction(
      ctx,
      action,
      onSuccess,
      (err) => {
        const canRestore = !(err instanceof MutationTransportError);
        if (canRestore) {
          busy = false;
          button.removeAttribute("aria-busy");
          button.removeAttribute("aria-label");
          button.textContent = originalLabel;
          for (const item of previous) item.control.disabled = item.disabled;
        }
        onError(err);
      },
    );
  });
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
  return el("section", { "aria-label": "Differences" }, el("h3", {}, "Differences"), systemDiffs, ...(warningsList ? [warningsList] : []));
}

export function renderBlockers(blockers: readonly PlanBlocker[]): HTMLElement | null {
  if (blockers.length === 0) return null;
  return el(
    "section",
    // rt-notice, not a bare <section>: the stylesheet marks what the user must not miss, and
    // "Differences" is routine information that must not borrow the same alarm.
    { class: "rt-notice rt-notice--danger" },
    el("h3", {}, "This entry cannot be recreated yet"),
    el("ul", {}, ...blockers.map((b) => el("li", {}, b.message))),
  );
}

export function renderWarningMessages(warnings: readonly PlanWarning[]): HTMLElement | null {
  const shown = warnings.filter((w) => w.ruleId !== "P-SYS");
  if (shown.length === 0) return null;
  return el("section", { class: "rt-notice rt-notice--warning" }, el("ul", {}, ...shown.map((w) => el("li", {}, w.message))));
}

/** The server removes lineage that the viewer cannot read. This helper only renders the related
 * deleted entries that remain and gives each one the same detail navigation used by the list. */
export function renderLineage(
  ctx: Ctx,
  lineage: DetailResponse["lineage"] | undefined,
): HTMLElement | null {
  if (!lineage?.parent && !lineage?.child) return null;

  const buttons: HTMLButtonElement[] = [];
  const { parent, child } = lineage;
  if (parent) {
    const previous = el("button", { type: "button" }, "Open previous deleted entry");
    previous.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId: parent.id }));
    buttons.push(previous);
  }
  if (child) {
    const next = el("button", { type: "button" }, "Open next deleted entry");
    next.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId: child.id }));
    buttons.push(next);
  }

  return el(
    "section",
    { "aria-label": "Recreation chain" },
    el("h3", {}, "Recreation chain"),
    el("p", {}, "This deleted entry is part of a recreation chain."),
    el("div", {}, ...buttons),
  );
}
