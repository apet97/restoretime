import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`Expected a six-digit color, got ${hex}.`);
  return [0, 2, 4].map((index) => Number.parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

function luminance(hex: string): number {
  const channels = hexToRgb(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return (lighter! + 0.05) / (darker! + 0.05);
}

function declaration(css: string, name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i").exec(css);
  if (!match?.[1]) throw new Error(`Missing ${name} in the shipped stylesheet.`);
  return match[1];
}

function themeBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match?.[1]) throw new Error(`Missing ${selector} in the shipped stylesheet.`);
  return match[1];
}

function themedDeclaration(css: string, selector: string, name: string): string {
  return declaration(themeBlock(css, selector), name);
}

describe("shipped component CSS", () => {
  const css = readFileSync(join(process.cwd(), "dist", "static", "app.css"), "utf8");

  it("keeps light and dark primary text contrast at 4.5:1 or higher", () => {
    for (const selector of [":root", ':root[data-clockify-theme="dark"]']) {
      expect(contrast(themedDeclaration(css, selector, "--rt-accent"), themedDeclaration(css, selector, "--rt-accent-text"))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps every status-pill label readable against its semantic background", () => {
    const statusPairs: readonly (readonly [string, string])[] = [
      ["--rt-ok", "--rt-pill-success-bg"],
      ["--rt-warn", "--rt-pill-warning-bg"],
      ["--rt-danger", "--rt-pill-danger-bg"],
      ["--rt-progress", "--rt-pill-progress-bg"],
      ["--rt-muted", "--rt-pill-neutral-bg"],
    ];
    for (const selector of [":root", ':root[data-clockify-theme="dark"]']) {
      for (const [text, background] of statusPairs) {
        expect(contrast(themedDeclaration(css, selector, text), themedDeclaration(css, selector, background))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps a visible focus indicator and avoids positional selectors", () => {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).toMatch(/:focus-visible\s*\{[^}]*outline\s*:\s*2px\s+solid\s+var\(--rt-focus\)/);
    expect(source).not.toMatch(/:(?:first|last|nth)-child/);
  });

  it("stops busy animation when the user requests reduced motion", () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.rt-busy-spinner\s*\{[^}]*animation\s*:\s*none/);
  });

  it("defines the spinner animation that the reduced-motion rule switches off", () => {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).toMatch(/@keyframes\s+rt-spin/);
    expect(source).toMatch(/\.rt-busy-spinner\s*\{[^}]*animation\s*:\s*rt-spin/);
  });

  it("contains long tables inside a narrow component instead of widening the page", () => {
    const wrapper = /\.rt-table-scroll\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const cells = /th,\s*\n?td\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(wrapper).toMatch(/width\s*:\s*100%/);
    expect(wrapper).toMatch(/max-width\s*:\s*100%/);
    expect(wrapper).toMatch(/overflow-x\s*:\s*auto/);
    expect(cells).toMatch(/overflow-wrap\s*:\s*anywhere/);
  });
});
