// Bulk flow (docs/10 §7, admin-only — the server enforces this on both endpoints; the UI only
// reaches this view from the admin-only "Review selected" button in list.ts). "Recreate N entries"
// confirms once; each entry is still claimed and executed independently server-side (no
// cross-entry transaction) — this view only renders whatever per-entry outcome comes back.

import { el, mount } from "../dom.js";
import { formatEntryHeader } from "../format.js";
import type { Ctx } from "../state.js";
import { MutationTransportError } from "../api.js";
import { renderApiError, runAction } from "./shared.js";
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

export function renderBulkReview(ctx: Ctx, rows: readonly BulkPreflightRow[]): void {
  const selected = new Set(rows.filter((r) => r.status === "ready" && r.plan).map((r) => r.entryId));
  let busy = false;
  const checkboxes: HTMLInputElement[] = [];

  const recreateButton = el("button", { type: "button", class: "rt-primary" }, "");
  const readyPlanIds = () => rows.filter((r) => r.status === "ready" && r.plan && selected.has(r.entryId)).map((r) => r.plan!.id);
  /** The label and the action have to agree: computing the count once left the button saying
   * "Recreate 2 entries" after the admin unchecked one, and clicking with nothing checked
   * silently did nothing. */
  const syncRecreateButton = () => {
    const count = readyPlanIds().length;
    recreateButton.textContent = `Recreate ${count} ${count === 1 ? "entry" : "entries"}`;
    recreateButton.toggleAttribute("disabled", busy || count === 0);
    for (const checkbox of checkboxes) checkbox.disabled = busy;
  };

  const listItems = rows.map((row) => {
    // A review view has to say what is being reviewed. A "ready" row carries no reason text, so
    // without the entry's own header and description it rendered as a bare "Ready — ": several
    // identical lines the admin was asked to confirm blind.
    const label = row.source ? formatEntryHeader(row.source.start, row.source.end, ctx.locale) : "This entry";
    const description = row.source?.description ?? "";
    const reason = rowReason(row);
    const line = [
      el("strong", {}, STATUS_LABEL[row.status]),
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
      checkbox.checked = true;
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
    openButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId: row.entryId }));
    return el("li", {}, ...line, " ", openButton);
  });

  syncRecreateButton();
  recreateButton.addEventListener("click", () => {
    const snapshot = rows.filter((row) => row.status === "ready" && row.plan && selected.has(row.entryId));
    const planIds = snapshot.map((row) => row.plan!.id);
    if (planIds.length === 0) return;
    busy = true;
    syncRecreateButton();
    backButton.disabled = true;
    void runAction(
      ctx,
      () => ctx.api.mutate("/api/entries/bulk-recreate", { planIds }),
      (res) => {
        if (!hasBulkResults(res)) {
          const unknown = snapshot.map((row) => ({ entryId: row.entryId, planId: row.plan!.id, outcome: "AMBIGUOUS" as const }));
          ctx.navigate({ kind: "bulk-results", rows: unknown, reviewRows: snapshot });
          return;
        }
        ctx.navigate({ kind: "bulk-results", rows: res.results, reviewRows: snapshot });
      },
      (err) => {
        if (err instanceof MutationTransportError) {
          const unknown = snapshot.map((row) => ({ entryId: row.entryId, planId: row.plan!.id, outcome: "AMBIGUOUS" as const }));
          ctx.navigate({ kind: "bulk-results", rows: unknown, reviewRows: snapshot });
          return;
        }
        busy = false;
        renderApiError(ctx.root, err, () => renderBulkReview(ctx, rows));
      },
    );
  });

  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));

  mount(
    ctx.root,
    el("h2", {}, "Review selected entries"),
    el("p", {}, "Entries needing input or individual review are excluded. Open each one to resolve it, then try again."),
    el("ul", {}, ...listItems),
    el("div", {}, recreateButton, backButton),
  );
}

function hasBulkResults(value: unknown): value is { readonly results: readonly BulkRecreateRow[] } {
  return typeof value === "object" && value !== null && "results" in value && Array.isArray((value as { results?: unknown }).results);
}

const OUTCOME_LABEL: Record<string, string> = {
  RECREATED: "Recreated",
  FAILED: "Failed",
  AMBIGUOUS: "Unknown result",
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

  mount(ctx.root, el("h2", {}, "Bulk recreation results"), el("ul", {}, ...listItems), backButton);
}
