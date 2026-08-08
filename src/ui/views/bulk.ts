// Bulk flow (docs/10 §7, admin-only — the server enforces this on both endpoints; the UI only
// reaches this view from the admin-only "Review selected" button in list.ts). "Recreate N entries"
// confirms once; each entry is still claimed and executed independently server-side (no
// cross-entry transaction) — this view only renders whatever per-entry outcome comes back.

import { el, mount } from "../dom.js";
import type { Ctx } from "../state.js";
import { renderApiError, runAction } from "./shared.js";
import type { BulkPreflightRow, BulkRecreateRow } from "../types.js";

function rowReason(row: BulkPreflightRow): string {
  if (row.message) return row.message;
  if (row.status === "blocked") return row.plan?.blockers[0]?.message ?? "Blocked.";
  if (row.status === "needs-input") return row.plan?.actionRequired[0]?.message ?? "Needs your input.";
  if (row.status === "not-found") return "This entry could not be found.";
  return "";
}

const STATUS_LABEL: Record<BulkPreflightRow["status"], string> = {
  ready: "Ready",
  "needs-input": "Needs your input",
  blocked: "Blocked",
  "not-found": "Not found",
  error: "Error",
};

export function renderBulkReview(ctx: Ctx, rows: readonly BulkPreflightRow[]): void {
  const selected = new Set(rows.filter((r) => r.status === "ready" && r.plan).map((r) => r.entryId));

  const listItems = rows.map((row) => {
    const line = [el("strong", {}, STATUS_LABEL[row.status]), ` — ${rowReason(row)}`];
    if (row.status === "ready" && row.plan) {
      const checkbox = el("input", { type: "checkbox" });
      checkbox.checked = true;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(row.entryId);
        else selected.delete(row.entryId);
      });
      return el("li", {}, checkbox, ...line);
    }
    const openButton = el("button", { type: "button" }, "Open");
    openButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId: row.entryId }));
    return el("li", {}, ...line, " ", openButton);
  });

  const recreateButton = el("button", { type: "button" }, `Recreate ${selected.size} entries`);
  recreateButton.addEventListener("click", () => {
    const planIds = rows.filter((r) => r.status === "ready" && r.plan && selected.has(r.entryId)).map((r) => r.plan!.id);
    if (planIds.length === 0) return;
    void runAction(
      ctx,
      () => ctx.api.post("/api/entries/bulk-recreate", { planIds }) as Promise<{ results: readonly BulkRecreateRow[] }>,
      (res) => ctx.navigate({ kind: "bulk-results", rows: res.results }),
      (err) => renderApiError(ctx.root, err, () => renderBulkReview(ctx, rows)),
    );
  });

  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));

  mount(
    ctx.root,
    el("h2", {}, "Review selected entries"),
    el("p", {}, "Entries needing input are excluded. Open each one to resolve it, then try again."),
    el("ul", {}, ...listItems),
    el("div", {}, recreateButton, backButton),
  );
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
  if (row.outcome === "RECREATED") return `New entry ${row.newEntryId}.`;
  return "Clockify's answer did not arrive. Open this entry to check.";
}

export function renderBulkResults(ctx: Ctx, rows: readonly BulkRecreateRow[]): void {
  const listItems = rows.map((row) => {
    const openButton = el("button", { type: "button" }, "Open");
    openButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId: row.entryId }));
    return el("li", {}, el("strong", {}, OUTCOME_LABEL[row.outcome] ?? row.outcome), ` — ${rowMessage(row)} `, openButton);
  });

  const backButton = el("button", { type: "button" }, "Back to deleted entries");
  backButton.addEventListener("click", () => ctx.navigate({ kind: "list" }));

  mount(ctx.root, el("h2", {}, "Bulk recreation results"), el("ul", {}, ...listItems), backButton);
}
