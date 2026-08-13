import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface LayoutMetrics {
  readonly viewportWidth: number;
  readonly documentWidth: number;
  readonly wrapperRight: number;
  readonly wrapperClientWidth: number;
  readonly wrapperScrollWidth: number;
  readonly overflowX: string;
}

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

function pageHtml(css: string, width: number): string {
  const component = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><main id="app"><h2>Confirm recreation</h2><div class="rt-table-scroll" tabindex="0" aria-label="Deleted and planned entry values"><table><caption>Deleted entry compared with the new entry RestoreTime plans to create</caption><thead><tr><th>Field</th><th>Deleted entry</th><th>New entry (planned)</th></tr></thead><tbody><tr><th>Custom field: A very long current workspace field name</th><td>unbroken-source-value-012345678901234567890123456789</td><td>unbroken-planned-value-012345678901234567890123456789</td></tr></tbody></table></div></main></body></html>`;
  return `<!doctype html><html><body><iframe id="component" style="border:0;width:${width}px;height:650px"></iframe><output id="metrics"></output><script>const frame=document.getElementById("component");const doc=frame.contentDocument;doc.open();doc.write(${JSON.stringify(component)});doc.close();const wrapper=doc.querySelector(".rt-table-scroll");const rect=wrapper.getBoundingClientRect();document.getElementById("metrics").textContent=JSON.stringify({viewportWidth:doc.documentElement.clientWidth,documentWidth:doc.documentElement.scrollWidth,wrapperRight:rect.right,wrapperClientWidth:wrapper.clientWidth,wrapperScrollWidth:wrapper.scrollWidth,overflowX:frame.contentWindow.getComputedStyle(wrapper).overflowX});</script></body></html>`;
}

function measure(chrome: string, htmlPath: string, profilePath: string): Promise<LayoutMetrics> {
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
      "--window-size=800,700",
      "--dump-dom",
      pathToFileURL(htmlPath).href,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let metrics: LayoutMetrics | undefined;
    let timeoutError: Error | undefined;
    let terminateTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timeoutError = new Error(`Chrome layout probe timed out: ${stderr.slice(-1_000)}`);
      child.kill("SIGKILL");
    }, 15_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const rawMetrics = /<output id="metrics">([^<]+)<\/output>/.exec(stdout)?.[1];
      if (!rawMetrics || metrics !== undefined) return;
      metrics = JSON.parse(rawMetrics) as LayoutMetrics;
      // Some Chrome builds keep background services alive after --dump-dom has printed the page.
      // Stop only this isolated test process after the complete DOM is captured.
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

describe("narrow component layout in Chrome", () => {
  it("contains the real long facts table at 280 px and 320 px", { timeout: 35_000 }, async () => {
    const css = readFileSync(join(process.cwd(), "dist", "static", "app.css"), "utf8");
    const chrome = findChrome();
    const dir = mkdtempSync(join(tmpdir(), "restoretime-layout-"));
    const htmlPath = join(dir, "layout.html");
    try {
      for (const width of [280, 320]) {
        writeFileSync(htmlPath, pageHtml(css, width));
        const metrics = await measure(chrome, htmlPath, join(dir, `profile-${width}`));
        expect(metrics.viewportWidth).toBe(width);
        expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth);
        expect(metrics.wrapperRight).toBeLessThanOrEqual(metrics.viewportWidth);
        expect(metrics.wrapperScrollWidth).toBeGreaterThan(metrics.wrapperClientWidth);
        expect(metrics.overflowX).toBe("auto");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
