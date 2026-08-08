// List view (docs/10 §1-§2). Regular users see only their own entries (the server enforces this —
// docs/09 — the UI never filters by owner itself). Admins additionally get filters, a dismissed
// toggle, and bulk selection. Nothing else: no dashboards, no charts (docs/10 §2).

import { el, mount } from "../dom.js";
import { formatDetected, formatEntryHeader, statusLabel } from "../format.js";
import type { Ctx } from "../state.js";
import { renderApiError, runAction, withLoading } from "./shared.js";
import type { BulkPreflightRow, ListResponse, ListRow } from "../types.js";

interface ListFilterState {
  userId: string;
  projectId: string;
  from: string;
  to: string;
  status: string;
  search: string;
  dismissed: boolean;
  bulkMode: boolean;
  selected: Set<string>;
}

function freshFilters(): ListFilterState {
  return {
    userId: "",
    projectId: "",
    from: "",
    to: "",
    status: "",
    search: "",
    dismissed: false,
    bulkMode: false,
    selected: new Set(),
  };
}

async function fetchList(ctx: Ctx, filters: ListFilterState): Promise<ListResponse> {
  const query: Record<string, string> = {};
  if (ctx.isAdminRole && filters.userId) query.userId = filters.userId;
  if (filters.projectId) query.projectId = filters.projectId;
  if (filters.from) query.from = `${filters.from}T00:00:00.000Z`;
  if (filters.to) query.to = `${filters.to}T23:59:59.999Z`;
  if (ctx.isAdminRole && filters.status) query.status = filters.status;
  if (filters.search) query.search = filters.search;
  if (filters.dismissed) query.dismissed = "true";
  return (await ctx.api.get("/api/entries", query)) as ListResponse;
}

export function renderList(ctx: Ctx): void {
  const filters = freshFilters();
  load(ctx, filters);
}

function load(ctx: Ctx, filters: ListFilterState): void {
  void withLoading(
    ctx,
    () => fetchList(ctx, filters),
    (data) => renderLoaded(ctx, filters, data),
    "Loading deleted time entries…",
  );
}

function renderLoaded(ctx: Ctx, filters: ListFilterState, data: ListResponse): void {
  const nodes: (Node | string)[] = [el("h2", {}, "Deleted time entries")];

  if (data.disabled) {
    nodes.push(
      el("p", { role: "alert" }, "RestoreTime is disabled for this workspace."),
    );
  }
  if (data.clockifyUnavailable) {
    nodes.push(el("p", { role: "status" }, "Clockify could not be reached; status and actions may be out of date."));
  }

  if (ctx.isAdminRole) nodes.push(renderAdminControls(ctx, filters));

  // Built before the rows and updated in place by each row's checkbox handler (never a full
  // reflow — the selection count is local UI state, not something that needs a fresh server read).
  let reviewButton: HTMLButtonElement | undefined;
  let reviewNote: HTMLElement | undefined;
  function syncReviewButton(): void {
    if (!reviewButton) return;
    const count = filters.selected.size;
    reviewButton.textContent = `Review selected (${count})`;
    reviewButton.toggleAttribute("disabled", count === 0 || count > 50);
    if (reviewNote) reviewNote.hidden = count <= 50;
  }

  const rows = data.entries;
  if (rows.length === 0) {
    nodes.push(el("p", {}, "No deleted time entries. When you delete a time entry in Clockify, it appears here."));
  } else {
    nodes.push(el("ul", {}, ...rows.map((row) => renderRow(ctx, filters, row, data.disabled, syncReviewButton))));
    // Say so when the server withheld older rows, rather than letting a full page read as "all".
    if (data.truncated) {
      nodes.push(
        el("p", {}, `Showing the ${data.limit} most recently detected entries. Use the filters above to find older ones.`),
      );
    }
  }

  if (ctx.isAdminRole && filters.bulkMode) {
    reviewButton = el("button", { type: "button" }, "Review selected (0)");
    reviewButton.addEventListener("click", () => {
      void runAction(
        ctx,
        () => ctx.api.post("/api/entries/bulk-preflight", { ids: [...filters.selected] }) as Promise<{ results: readonly BulkPreflightRow[] }>,
        (res) => ctx.navigate({ kind: "bulk-review", rows: res.results }),
        (err) => renderApiError(ctx.root, err, () => load(ctx, filters)),
      );
    });
    reviewNote = el("p", { role: "alert" }, "Select at most 50 entries.");
    reviewNote.hidden = true;
    nodes.push(el("div", {}, reviewButton, reviewNote));
    syncReviewButton();
  }

  mount(ctx.root, ...nodes);
}

function renderAdminControls(ctx: Ctx, filters: ListFilterState): HTMLElement {
  const projectInput = el("input", { type: "text", placeholder: "Project id", value: filters.projectId });
  const userInput = el("input", { type: "text", placeholder: "User id", value: filters.userId });
  const fromInput = el("input", { type: "date", value: filters.from });
  const toInput = el("input", { type: "date", value: filters.to });
  const searchInput = el("input", { type: "text", placeholder: "Search description", value: filters.search });
  const statusSelect = el(
    "select",
    {},
    el("option", { value: "" }, "Any status"),
    el("option", { value: "IDLE" }, "Ready / needs input / blocked"),
    el("option", { value: "RECREATING" }, "Recreating"),
    el("option", { value: "RECREATED" }, "Recreated"),
    el("option", { value: "FAILED" }, "Failed"),
    el("option", { value: "AMBIGUOUS" }, "Unknown result"),
  );
  statusSelect.value = filters.status;

  const applyButton = el("button", { type: "button" }, "Apply filters");
  applyButton.addEventListener("click", () => {
    filters.userId = userInput.value.trim();
    filters.projectId = projectInput.value.trim();
    filters.from = fromInput.value;
    filters.to = toInput.value;
    filters.status = statusSelect.value;
    filters.search = searchInput.value.trim();
    load(ctx, filters);
  });

  const dismissedToggle = el("input", { type: "checkbox" });
  dismissedToggle.checked = filters.dismissed;
  dismissedToggle.addEventListener("change", () => {
    filters.dismissed = dismissedToggle.checked;
    load(ctx, filters);
  });
  const dismissedLabel = el("label", {}, dismissedToggle, " Show dismissed");

  const bulkToggle = el("input", { type: "checkbox" });
  bulkToggle.checked = filters.bulkMode;
  bulkToggle.addEventListener("change", () => {
    filters.bulkMode = bulkToggle.checked;
    filters.selected.clear();
    load(ctx, filters);
  });
  const bulkLabel = el("label", {}, bulkToggle, " Bulk mode");

  return el(
    "section",
    { "aria-label": "Filters" },
    el("label", {}, "User", userInput),
    el("label", {}, "Project", projectInput),
    el("label", {}, "From", fromInput),
    el("label", {}, "To", toInput),
    el("label", {}, "Status", statusSelect),
    el("label", {}, "Search", searchInput),
    applyButton,
    dismissedLabel,
    bulkLabel,
  );
}

function renderRow(
  ctx: Ctx,
  filters: ListFilterState,
  row: ListRow,
  disabledInstallation: boolean,
  onSelectionChange: () => void,
): HTMLElement {
  const source = row.source;
  const header = formatEntryHeader(source.start, source.end, ctx.locale);
  // docs/10 §1's row shows the description on its own line. Replacing it with "Project — Task"
  // when a project exists made two entries in the same project indistinguishable, and hid the
  // very text the admin free-text filter searches.
  const projectLine = [source.projectName, source.taskName].filter((v): v is string => Boolean(v)).join(" — ");
  const tagNames = source.tags.map((t) => t.name).join(", ");
  const detected = formatDetected(row.detectedAt, ctx.locale);
  const status = statusLabel(row);
  const actionable = row.lifecycleState === "IDLE" || row.lifecycleState === "FAILED";

  const openButton = el("button", { type: "button", class: "rt-title" }, header);
  openButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId: row.id }));

  const lines = [
    el("div", {}, openButton),
    el("div", {}, source.description || "(no description)"),
    ...(projectLine ? [el("div", {}, projectLine)] : []),
    el("div", {}, `Tags: ${tagNames || "none"}`, "  ", `Detected: ${detected}`),
    el("div", {}, `Status: ${status}`),
  ];

  if (actionable && !disabledInstallation) {
    const recreateButton = el("button", { type: "button", class: "rt-primary" }, "Recreate");
    recreateButton.addEventListener("click", () => ctx.navigate({ kind: "detail", entryId: row.id }));
    lines.push(el("div", {}, recreateButton));
  }

  if (ctx.isAdminRole && filters.bulkMode) {
    const checkbox = el("input", { type: "checkbox" });
    checkbox.checked = filters.selected.has(row.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) filters.selected.add(row.id);
      else filters.selected.delete(row.id);
      onSelectionChange();
    });
    lines.unshift(el("div", {}, checkbox));
  }

  return el("li", {}, ...lines);
}
