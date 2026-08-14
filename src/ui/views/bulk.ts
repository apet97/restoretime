// Bulk flow (docs/10 §7, admin-only — the server enforces this on both endpoints; the UI only
// reaches this view from the admin-only "Review selected" button in list.ts). "Recreate N entries"
// confirms once; each entry is still claimed and executed independently server-side (no
// cross-entry transaction) — this view only renders whatever per-entry outcome comes back.

import { el } from "../dom.js";
import { formatEntryHeader } from "../format.js";
import type { Ctx } from "../state.js";
import { MutationTransportError } from "../api.js";
import { bindBusyAction, mountView, renderApiError, renderStatusPill, runAction } from "./shared.js";
import { fidelityLabel } from "../format.js";
import { renderFactsTable } from "./detail.js";
import type { BulkPreflightRow, BulkRecreateRow } from "../types.js";

function rowReason(row: BulkPreflightRow): string {
  if (row.message) return row.message;
  if (row.status === "blocked") return row.plan?.blockers[0]?.message ?? "Blocked.";
  if (row.status === "needs-input") return row.plan?.actionRequired[0]?.message ?? "Needs your input.";
  if (row.status === "needs-review") return row.message ?? "Open this entry and review its changes.";
  if (row.status === "not-found") return "This entry could not be found.";
  if (row.status === "not-actionable") return "This entry changed after you selected it. Open the entry to see its current status.";
  return "";
}

const STATUS_LABEL: Record<BulkPreflightRow["status"], string> = {
  ready: "Ready",
  "needs-input": "Needs your input",
  "needs-review": "Needs individual review",
  blocked: "Blocked",
  "not-found": "Not found",
  "not-actionable": "State changed",
  error: "Error",
};

export function loadBulkReview(ctx: Ctx, previousRows: readonly BulkPreflightRow[]): void {
  const ids = [...ctx.session.selectedEntryIds];
  const errorRegion = el("div", { class: "rt-inline-error", "aria-label": "Bulk review error" });
  renderBulkReview(ctx, previousRows, false, errorRegion, true);
  errorRegion.append(el("p", { role: "status" }, "Refreshing review…"));
  void runAction(
    ctx,
    () => ctx.api.post("/api/entries/bulk-preflight", { ids }) as Promise<{ results: readonly BulkPreflightRow[] }>,
    (res) => {
      ctx.session.bulkReviewRows = res.results;
      renderBulkReview(ctx, res.results);
    },
    (err) => {
      renderBulkReview(ctx, previousRows, false, errorRegion);
      renderApiError({ region: errorRegion, err, context: "", action: () => loadBulkReview(ctx, previousRows), actionLabel: "Reload review" });
    },
  );
}

export function renderBulkReview(
  ctx: Ctx,
  rows: readonly BulkPreflightRow[],
  refresh = false,
  suppliedErrorRegion?: HTMLElement,
  refreshing = false,
): void {
  if (refresh) {
    loadBulkReview(ctx, rows);
    return;
  }
  ctx.session.bulkReviewRows = rows;
  const selected = ctx.session.selectedEntryIds;
  let busy = false;
  const checkboxes: HTMLInputElement[] = [];
  const errorRegion = suppliedErrorRegion ?? el("div", { class: "rt-inline-error", "aria-label": "Bulk review error" });

  const recreateButton = el("button", { type: "button", class: "rt-primary" }, "");
  const readyPlanIds = () => rows.filter((r) => r.status === "ready" && r.plan && selected.has(r.entryId)).map((r) => r.plan!.id);
  /** The label and the action have to agree: computing the count once left the button saying
   * "Recreate 2 entries" after the admin unchecked one, and clicking with nothing checked
   * silently did nothing. */
  const syncRecreateButton = () => {
    const count = readyPlanIds().length;
    recreateButton.textContent = `Recreate ${count} ${count === 1 ? "entry" : "entries"}`;
    recreateButton.toggleAttribute("disabled", busy || refreshing || count === 0);
    for (const checkbox of checkboxes) checkbox.disabled = busy || refreshing;
  };

  const listItems = rows.map((row) => {
    // A review view has to say what is being reviewed. A "ready" row carries no reason text, so
    // without the entry's own header and description it rendered as a bare "Ready — ": several
    // identical lines the admin was asked to confirm blind.
    const label = row.source ? formatEntryHeader(row.source.start, row.source.end, ctx.locale) : "This entry";
    const description = row.source?.description ?? "";
    const reason = rowReason(row);
    const line = [
      renderStatusPill(bulkStatusPresentation(row.status)),
      ` — ${label}`,
      ...(description ? [el("div", {}, description)] : []),
      ...(reason ? [el("div", {}, reason)] : []),
    ];
    if (row.status === "ready" && row.plan) {
      line.push(el("div", {}, `Owner: ${row.source?.ownerName ?? "Unknown owner"}`));
      line.push(el("div", {}, `Fidelity: ${fidelityLabel(row.plan.fidelity)}`));
      if (row.source) line.push(renderFactsTable(row.source, row.plan, ctx.locale));
      if (row.plan.warnings.length > 0) {
        line.push(el("ul", {}, ...row.plan.warnings.map((warning) => el("li", {}, warning.message))));
      }
      // Named, so a screen reader announces which entry is being toggled rather than "checkbox".
      const identity = `${row.source?.ownerName ?? "Unknown owner"}, ${label}, ${description || "no description"}`;
      const checkbox = el("input", { type: "checkbox", "aria-label": `Recreate ${identity}` });
      checkbox.checked = selected.has(row.entryId);
      checkboxes.push(checkbox);
      checkbox.addEventListener("change", () => {
        if (busy) return;
        if (checkbox.checked) selected.add(row.entryId);
        else selected.delete(row.entryId);
        syncRecreateButton();
      });
      return el("li", {}, checkbox, ...line);
    }
    if (row.status === "not-found") return el("li", {}, ...line);
    const openButton = el("button", { type: "button" }, "Open");
    openButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId: row.entryId, returnTo: "bulk-review" }));
    return el("li", {}, ...line, " ", openButton);
  });

  syncRecreateButton();
  bindBusyAction({
    ctx,
    button: recreateButton,
    busyLabel: "Recreating entries…",
    conflictingControls: () => [backButton, ...checkboxes],
    action: async () => {
    const snapshot = rows.filter((row) => row.status === "ready" && row.plan && selected.has(row.entryId));
    const planIds = snapshot.map((row) => row.plan!.id);
    if (planIds.length === 0) throw new Error("No selected ready entries.");
    busy = true;
    syncRecreateButton();
    const response = await ctx.api.mutate("/api/entries/bulk-recreate", { planIds });
    return { response, snapshot };
    },
    onSuccess: ({ response: res, snapshot }) => {
        if (!hasBulkResults(res)) {
          const unknown = snapshot.map((row) => ({ entryId: row.entryId, planId: row.plan!.id, outcome: "AMBIGUOUS" as const }));
          ctx.navigate({ kind: "bulk-results", rows: unknown, reviewRows: snapshot });
          return;
        }
        ctx.navigate({ kind: "bulk-results", rows: res.results, reviewRows: snapshot });
    },
    onError: (err) => {
      const snapshot = rows.filter((row) => row.status === "ready" && row.plan && selected.has(row.entryId));
        if (err instanceof MutationTransportError) {
          const unknown = snapshot.map((row) => ({ entryId: row.entryId, planId: row.plan!.id, outcome: "AMBIGUOUS" as const }));
          ctx.navigate({ kind: "bulk-results", rows: unknown, reviewRows: snapshot });
          return;
        }
      busy = false;
      renderApiError({ region: errorRegion, err, context: "", action: () => loadBulkReview(ctx, rows), actionLabel: "Reload review" });
    },
  });

  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));

  mountView(
    ctx,
    el("h2", {}, "Review selected entries"),
    el("p", {}, "Entries needing input or individual review are excluded. Open each one to resolve it, then try again."),
    errorRegion,
    el("ul", {}, ...listItems),
    el("div", { class: "rt-action-group" }, recreateButton, backButton),
  );
}

function hasBulkResults(value: unknown): value is { readonly results: readonly BulkRecreateRow[] } {
  return typeof value === "object" && value !== null && "results" in value && Array.isArray((value as { results?: unknown }).results);
}

const OUTCOME_LABEL: Record<string, string> = {
  RECREATED: "Recreated",
  FAILED: "Failed",
  AMBIGUOUS: "Result uncertain",
  ERROR: "Failed",
};

function rowMessage(row: BulkRecreateRow): string {
  if (row.outcome === "ERROR") return row.message;
  if (row.outcome === "FAILED") return row.message;
  if (row.outcome === "AMBIGUOUS" && row.message) return row.message;
  // The raw Clockify id said nothing to the person reading it — the "Open" button beside this row
  // is what actually reaches the new entry.
  if (row.outcome === "RECREATED") return "The new entry is in Clockify.";
  return "The result did not reach this page. Do not recreate this entry again. Open it and check its status.";
}

export function renderBulkResults(ctx: Ctx, rows: readonly BulkRecreateRow[], reviewRows: readonly BulkPreflightRow[] = []): void {
  const listItems = rows.map((row) => {
    const label = el("strong", {}, OUTCOME_LABEL[row.outcome] ?? row.outcome);
    const reviewed = reviewRows.find((candidate) => candidate.plan?.id === row.planId || candidate.entryId === row.entryId);
    const identity = reviewed?.source
      ? `${reviewed.source.ownerName} — ${formatEntryHeader(reviewed.source.start, reviewed.source.end, ctx.locale)} — ${reviewed.source.description || "(no description)"}`
      : "The selected entry";
    // A row can describe a plan that no longer resolves to an entry (its plan was pruned), in
    // which case there is nothing to open — offering the button would navigate to `id=undefined`.
    if (row.entryId === null || row.entryId === undefined) {
      return el("li", {}, label, ` — ${identity}. ${rowMessage(row)}`);
    }
    const entryId = row.entryId;
    const openButton = el("button", { type: "button" }, "Open");
    openButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId }));
    return el("li", {}, label, ` — ${identity}. ${rowMessage(row)} `, openButton);
  });

  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));

  mountView(ctx, el("h2", {}, "Bulk recreation results"), bulkOutcomeSummary(rows), el("ul", {}, ...listItems), backButton);
}

function bulkOutcomeSummary(rows: readonly BulkRecreateRow[]): HTMLElement {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  const parts = [...counts.entries()].map(([outcome, count]) => `${count} ${OUTCOME_LABEL[outcome] ?? outcome}`);
  return el("p", { role: "status" }, `Summary: ${parts.join(", ") || "No entries were processed"}.`);
}

function bulkStatusPresentation(status: BulkPreflightRow["status"]): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  switch (status) {
    case "ready": return { label: STATUS_LABEL[status], tone: "success" };
    case "blocked":
    case "error": return { label: STATUS_LABEL[status], tone: "danger" };
    case "needs-input":
    case "needs-review": return { label: STATUS_LABEL[status], tone: "warning" };
    case "not-found":
    case "not-actionable": return { label: STATUS_LABEL[status], tone: "neutral" };
  }
}
