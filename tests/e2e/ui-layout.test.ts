// @vitest-environment happy-dom

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createUiSessionState, type Ctx } from "../../src/ui/state.js";
import type { BulkPreflightRow, DeletedTimeEntry, ListResponse } from "../../src/ui/types.js";
import { renderBulkReview } from "../../src/ui/views/bulk.js";
import { renderList } from "../../src/ui/views/list.js";

interface LayoutMetrics {
  readonly fixture: string;
  readonly frameWidth: number;
  readonly viewportWidth: number;
  readonly documentWidth: number;
  readonly wrapperRight: number | null;
  readonly wrapperClientWidth: number | null;
  readonly wrapperScrollWidth: number | null;
  readonly overflowX: string | null;
  readonly controlRight: number | null;
  readonly controlWidth: number | null;
  readonly selectedStylesDiffer: boolean | null;
}

interface Fixture {
  readonly name: string;
  readonly widths: readonly number[];
  readonly theme?: "dark";
  readonly content?: string;
  readonly render?: () => string | Promise<string>;
}

const unbroken = "x".repeat(300);

function source(overrides: Partial<DeletedTimeEntry> = {}): DeletedTimeEntry {
  return {
    workspaceId: "ws-1",
    entryId: "entry-1",
    ownerId: "user-1",
    ownerName: "Ana Markovic",
    description: "API investigation",
    billable: false,
    start: "2026-08-07T09:00:00Z",
    end: "2026-08-07T10:00:00Z",
    wasRunning: false,
    type: "REGULAR",
    timeZone: "UTC",
    projectId: null,
    projectName: null,
    clientName: null,
    taskId: null,
    taskName: null,
    tags: [],
    customFieldValues: [],
    ...overrides,
  };
}

function markupCtx(isAdminRole = false): Ctx {
  const root = document.createElement("main");
  document.body.append(root);
  return {
    root,
    api: { get: vi.fn(), post: vi.fn(), mutate: vi.fn() } as unknown as Ctx["api"],
    bridge: { subscribe: vi.fn(), refreshAddonToken: vi.fn(), navigate: vi.fn(), showToast: vi.fn() } as unknown as Ctx["bridge"],
    locale: "en-GB",
    isAdminRole,
    session: createUiSessionState(),
    getNavigationVersion: () => 0,
    navigate: vi.fn(),
    announce: vi.fn(),
    reload: vi.fn(),
  };
}

async function productionListMarkup(): Promise<string> {
  const ctx = markupCtx();
  const response: ListResponse = {
    entries: [{
      id: "re-1",
      lifecycleState: "IDLE",
      detectedAt: "2026-08-07T12:00:00Z",
      source: source({ description: unbroken, projectName: unbroken, taskName: unbroken }),
      preflightSummary: { fidelity: "FULL", blockerCount: 0, actionRequiredCount: 0 },
    } as unknown as ListResponse["entries"][number]],
    clockifyUnavailable: false,
    disabled: false,
    broken: false,
      nextCursor: null,
  };
  (ctx.api.get as ReturnType<typeof vi.fn>).mockResolvedValue(response);
  renderList(ctx);
  await vi.waitFor(() => expect(ctx.root.querySelector(".rt-entry-value")).not.toBeNull());
  const markup = ctx.root.innerHTML;
  ctx.root.remove();
  return markup;
}

function productionBulkMarkup(): string {
  const ctx = markupCtx(true);
  const readySource = source({ description: unbroken, ownerName: unbroken });
  const rows: BulkPreflightRow[] = [
    {
      entryId: "re-ready",
      status: "ready",
      source: readySource,
      plan: {
        id: "plan-ready",
        plannedRequest: { workspaceId: "ws-1", userId: "user-1", start: readySource.start, end: readySource.end },
        presentation: { project: null, task: null, tags: [], customFields: [], editable: [] },
        warnings: [],
        blockers: [],
        actionRequired: [],
        fidelity: "FULL",
      } as unknown as NonNullable<BulkPreflightRow["plan"]>,
    },
    { entryId: "re-error", status: "error", source: source({ description: unbroken }), message: unbroken },
  ];
  renderBulkReview(ctx, rows);
  const markup = ctx.root.innerHTML;
  ctx.root.remove();
  return markup;
}

const fixtures: readonly Fixture[] = [
  {
    name: "production-list-row",
    widths: [360, 480],
    render: productionListMarkup,
  },
  {
    name: "long-select",
    widths: [360, 480],
    content: `<fieldset><legend>Project</legend><label>Replacement project<select class="rt-field-control" data-layout-control><option>${unbroken}</option></select></label></fieldset>`,
  },
  {
    name: "long-checkbox-label",
    widths: [360, 480],
    content: `<fieldset><legend>Add current tags</legend><div class="rt-checkbox-list"><label><input type="checkbox" data-layout-control> ${unbroken}</label></div></fieldset>`,
  },
  {
    name: "comparison-table",
    widths: [280, 320, 360, 480],
    content: `<div class="rt-table-scroll" data-layout-table tabindex="0" aria-label="Deleted and planned entry values"><table><caption>Deleted entry compared with the new entry RestoreTime plans to create</caption><thead><tr><th>Field</th><th>Deleted entry</th><th>New entry (planned)</th></tr></thead><tbody><tr><th>Custom field: ${unbroken}</th><td>${unbroken}</td><td>${unbroken}</td></tr></tbody></table></div>`,
  },
  {
    name: "ambiguous-card",
    widths: [360, 480],
    content: `<ul><li class="rt-card"><h3>Possible match 1</h3><p>${unbroken}</p><details><summary>Show full technical reference</summary><p>${unbroken}</p></details><button>Use this match</button></li></ul>`,
  },
  {
    name: "production-bulk-rows",
    widths: [360, 480, 860],
    render: productionBulkMarkup,
  },
  {
    name: "action-group",
    widths: [360, 480, 860],
    content: `<div class="rt-action-group"><button class="rt-primary" data-layout-control>Recreate entry</button><button>Back to entry</button><button>Open in Clockify tracker</button></div>`,
  },
  {
    name: "selected-styles-default",
    widths: [480],
    content: `<ul><li class="rt-entry rt-entry--selected" data-selected-row="entry">Selected entry</li><li class="rt-entry" data-normal-row="entry">Normal entry</li><li class="rt-review-row rt-review-row--selected" data-selected-row="review">Selected review</li><li class="rt-review-row" data-normal-row="review">Normal review</li></ul>`,
  },
  {
    name: "selected-styles-dark",
    widths: [480],
    theme: "dark",
    content: `<ul><li class="rt-entry rt-entry--selected" data-selected-row="entry">Selected entry</li><li class="rt-entry" data-normal-row="entry">Normal entry</li><li class="rt-review-row rt-review-row--selected" data-selected-row="review">Selected review</li><li class="rt-review-row" data-normal-row="review">Normal review</li></ul>`,
  },
];

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  const found = candidates.find((candidate): candidate is string => candidate !== undefined && existsSync(candidate));
  if (!found) throw new Error("Chrome is required for the narrow-layout browser test. Set CHROME_PATH to its executable.");
  return found;
}

function componentHtml(css: string, content: string, theme?: "dark"): string {
  const themeAttribute = theme === undefined ? "" : ` data-clockify-theme="${theme}"`;
  return `<!doctype html><html${themeAttribute}><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main id="app"><h2>Layout fixture</h2>${content}</main></body></html>`;
}

async function pageHtml(css: string): Promise<string> {
  const cases = [] as { fixture: string; width: number; html: string }[];
  for (const fixture of fixtures) {
    const content = fixture.render ? await fixture.render() : fixture.content;
    if (content === undefined) throw new Error(`Fixture ${fixture.name} has no content.`);
    for (const width of fixture.widths) cases.push({ fixture: fixture.name, width, html: componentHtml(css, content, fixture.theme) });
  }
  return `<!doctype html><html><body><output id="metrics"></output><script>
const cases=${JSON.stringify(cases)};
const metrics=[];
for (const item of cases) {
  const frame=document.createElement("iframe");
  frame.style.cssText="border:0;display:block;width:"+item.width+"px;height:700px";
  document.body.append(frame);
  const doc=frame.contentDocument;
  doc.open();doc.write(item.html);doc.close();
  const wrapper=doc.querySelector("[data-layout-table]");
  const control=doc.querySelector("[data-layout-control]");
  const wrapperRect=wrapper?.getBoundingClientRect();
  const controlRect=control?.getBoundingClientRect();
  const selectionKinds=["entry","review"];
  const hasSelectedStylePairs=selectionKinds.every((kind)=>doc.querySelector('[data-selected-row="'+kind+'"]')&&doc.querySelector('[data-normal-row="'+kind+'"]'));
  const selectedStylesDiffer=hasSelectedStylePairs&&selectionKinds.every((kind)=>{
    const selected=doc.querySelector('[data-selected-row="'+kind+'"]');
    const normal=doc.querySelector('[data-normal-row="'+kind+'"]');
    const selectedStyle=frame.contentWindow.getComputedStyle(selected);
    const normalStyle=frame.contentWindow.getComputedStyle(normal);
    return selectedStyle.backgroundColor!==normalStyle.backgroundColor&&selectedStyle.borderTopColor!==normalStyle.borderTopColor;
  });
  metrics.push({
    fixture:item.fixture,
    frameWidth:frame.getBoundingClientRect().width,
    viewportWidth:doc.documentElement.clientWidth,
    documentWidth:doc.documentElement.scrollWidth,
    wrapperRight:wrapperRect?.right ?? null,
    wrapperClientWidth:wrapper?.clientWidth ?? null,
    wrapperScrollWidth:wrapper?.scrollWidth ?? null,
    overflowX:wrapper ? frame.contentWindow.getComputedStyle(wrapper).overflowX : null,
    controlRight:controlRect?.right ?? null,
    controlWidth:controlRect?.width ?? null,
    selectedStylesDiffer:hasSelectedStylePairs ? selectedStylesDiffer : null,
  });
}
document.getElementById("metrics").textContent=JSON.stringify(metrics);
</script></body></html>`;
}

function measure(chrome: string, htmlPath: string, profilePath: string): Promise<LayoutMetrics[]> {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--no-default-browser-check",
      "--no-first-run",
      `--user-data-dir=${profilePath}`,
      "--window-size=1000,700",
      "--dump-dom",
      pathToFileURL(htmlPath).href,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let metrics: LayoutMetrics[] | undefined;
    let timeoutError: Error | undefined;
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timeoutError = new Error(`Chrome layout probe timed out: ${stderr.slice(-1_000)}`);
      child.kill("SIGKILL");
    // A cold CI runner can need more than 20 seconds to start Chrome. This still bounds a hung probe.
    }, 45_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const rawMetrics = /<output id="metrics">([^<]+)<\/output>/.exec(stdout)?.[1];
      if (!rawMetrics || metrics !== undefined) return;
      metrics = JSON.parse(rawMetrics) as LayoutMetrics[];
      child.kill("SIGTERM");
      terminateTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (terminateTimer) clearTimeout(terminateTimer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timeout);
      if (terminateTimer) clearTimeout(terminateTimer);
      if (metrics) {
        resolve(metrics);
        return;
      }
      reject(timeoutError ?? new Error(`Chrome layout probe failed (${status ?? "no status"}): ${stderr || stdout.slice(-1_000)}`));
    });
  });
}

describe("component layout in Chrome", () => {
  it("contains supported long-content fixtures without document overflow", { timeout: 55_000 }, async () => {
    const css = readFileSync(join(process.cwd(), "dist", "static", "app.css"), "utf8");
    const chrome = findChrome();
    const directory = mkdtempSync(join(tmpdir(), "restoretime-layout-"));
    const htmlPath = join(directory, "layout.html");
    try {
      writeFileSync(htmlPath, await pageHtml(css));
      const metrics = await measure(chrome, htmlPath, join(directory, "profile"));
      expect(metrics).toHaveLength(fixtures.reduce((count, fixture) => count + fixture.widths.length, 0));

      for (const metric of metrics) {
        expect(metric.viewportWidth, `${metric.fixture} at ${metric.frameWidth}px`).toBeLessThanOrEqual(metric.frameWidth);
        expect(metric.documentWidth, `${metric.fixture} at ${metric.frameWidth}px`).toBeLessThanOrEqual(metric.viewportWidth);
        if (metric.controlRight !== null && metric.controlWidth !== null) {
          expect(metric.controlWidth, `${metric.fixture} control width`).toBeGreaterThan(0);
          expect(metric.controlRight, `${metric.fixture} control right edge`).toBeLessThanOrEqual(metric.viewportWidth);
        }
      }

      for (const metric of metrics.filter((item) => item.fixture === "comparison-table")) {
        expect(metric.wrapperRight).not.toBeNull();
        expect(metric.wrapperRight!).toBeLessThanOrEqual(metric.viewportWidth);
        expect(metric.wrapperClientWidth).not.toBeNull();
        expect(metric.wrapperScrollWidth).not.toBeNull();
        expect(metric.wrapperScrollWidth!).toBeGreaterThan(metric.wrapperClientWidth!);
        expect(metric.overflowX).toBe("auto");
      }

      for (const metric of metrics.filter((item) => item.fixture === "selected-styles-default" || item.fixture === "selected-styles-dark")) {
        expect(metric.selectedStylesDiffer, `${metric.fixture} selected styles`).toBe(true);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
