// List view (docs/10 §1-§2). Regular users see only their own entries (the server enforces this —
// docs/09 — the UI never filters by owner itself). Admins additionally get filters, a dismissed
// toggle, and bulk selection. Nothing else: no dashboards, no charts (docs/10 §2).

import { el, mount } from "../dom.js";
import { formatDetected, formatEntryHeader, statusLabel } from "../format.js";
import type { Ctx } from "../state.js";
import { renderApiError, runAction, withLoading } from "./shared.js";
import type { BulkPreflightRow, ListResponse, ListRow } from "../types.js";

interface ListFilterState {
  userName: string;
  projectName: string;
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
    userName: "",
    projectName: "",
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
  if (ctx.isAdminRole && filters.userName) query.userName = filters.userName;
  if (filters.projectName) query.projectName = filters.projectName;
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
  // docs/03 §6 / docs/11 / docs/14: a rejected token (401 code 4017) needs a reinstall, not a
  // retry — the generic "Clockify could not be reached" would send the user in circles.
  if (data.broken) {
    nodes.push(
      el("p", { role: "alert" }, "RestoreTime's Clockify connection was rejected. Reinstall the addon from the Clockify Marketplace."),
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

type SuggestionItems = readonly { readonly name?: string | null }[];

/** One `/api/options` fetch per kind per component session, keyed on the session's own API client
 * so nothing leaks between boots. This matters: `renderAdminControls` runs on *every* list render
 * — the initial load, Apply filters, and both toggles — and each `kind` is a `collectPaged` walk,
 * so without this a checkbox click would issue a full pagination sweep of `users.list` and
 * `projects.list`. That is the per-interaction Clockify fan-out `LIST_PAGE_SIZE` exists to avoid.
 * A failed fetch is not cached, so the next render tries again. */
const suggestionCaches = new WeakMap<Ctx["api"], Map<string, Promise<SuggestionItems>>>();

function loadSuggestions(ctx: Ctx, kind: "users" | "projects"): Promise<SuggestionItems> {
  let byKind = suggestionCaches.get(ctx.api);
  if (byKind === undefined) {
    byKind = new Map();
    suggestionCaches.set(ctx.api, byKind);
  }
  const cached = byKind.get(kind);
  if (cached !== undefined) return cached;
  const pending = ctx.api.get("/api/options", { kind }).then((res) => (res as { items: SuggestionItems }).items);
  byKind.set(kind, pending);
  return pending;
}

/** Fills a `<datalist>` with the current workspace's names, in the background. Suggestions are a
 * convenience only: the filter matches the names stored on each row, so free text must keep
 * working for a project or member that no longer exists — which is exactly the case this list is
 * for. A failed fetch therefore leaves an empty list and says nothing (docs/10 §2), and never
 * blocks the rows from rendering. */
function fillSuggestions(ctx: Ctx, list: HTMLDataListElement, kind: "users" | "projects"): void {
  void loadSuggestions(ctx, kind)
    .then((items) => {
      for (const item of items) if (item.name) list.appendChild(el("option", { value: item.name }));
    })
    .catch(() => suggestionCaches.get(ctx.api)?.delete(kind));
}

function renderAdminControls(ctx: Ctx, filters: ListFilterState): HTMLElement {
  // Filtering by name, not by id: nobody knows a 24-character Clockify id by heart, and the names
  // shown on each row are the ones stored at deletion time, so what you type matches what you see
  // (docs/10 §2).
  const projectList = el("datalist", { id: "rt-project-names" });
  const userList = el("datalist", { id: "rt-user-names" });
  const projectInput = el("input", { type: "text", placeholder: "Project name", list: "rt-project-names", value: filters.projectName });
  const userInput = el("input", { type: "text", placeholder: "User name", list: "rt-user-names", value: filters.userName });
  fillSuggestions(ctx, userList, "users");
  fillSuggestions(ctx, projectList, "projects");
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
  // "Show dismissed" selects the DISMISSED lifecycle state, and this dropdown selects any other
  // one, so the two controls answer the same question. Disabling the dropdown while the toggle is
  // on says that outright, instead of accepting a pair the server has to reconcile behind the
  // user's back (docs/10 §2).
  statusSelect.disabled = filters.dismissed;

  const applyButton = el("button", { type: "button" }, "Apply filters");
  applyButton.addEventListener("click", () => {
    filters.userName = userInput.value.trim();
    filters.projectName = projectInput.value.trim();
    filters.from = fromInput.value;
    filters.to = toInput.value;
    // Not read while disabled: the toggle owns the state selection then, and taking the
    // dropdown's stale value here would resurrect the contradiction this pair used to send.
    filters.status = statusSelect.disabled ? "" : statusSelect.value;
    filters.search = searchInput.value.trim();
    load(ctx, filters);
  });

  const dismissedToggle = el("input", { type: "checkbox" });
  dismissedToggle.checked = filters.dismissed;
  dismissedToggle.addEventListener("change", () => {
    filters.dismissed = dismissedToggle.checked;
    // Turning the toggle on drops any chosen status, so the next Apply cannot send both.
    if (filters.dismissed) filters.status = "";
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
    userList,
    el("label", {}, "Project", projectInput),
    projectList,
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
