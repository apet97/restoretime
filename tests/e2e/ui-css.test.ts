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

describe("shipped component CSS", () => {
  const css = readFileSync(join(process.cwd(), "dist", "static", "app.css"), "utf8");

  it("keeps light-theme primary text contrast at 4.5:1 or higher", () => {
    expect(contrast(declaration(css, "--rt-accent"), declaration(css, "--rt-accent-text"))).toBeGreaterThanOrEqual(4.5);
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
