// UT-X01 (docs/13): HTML escaping of descriptions/names with entities and markup-looking text.
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../../src/api/views.js";

describe("UT-X01 escapeHtml", () => {
  it("escapes literal < and > (W3: descriptions never contain these, but names/CF values can)", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersand, quotes, and apostrophes", () => {
    expect(escapeHtml(`A & B "quoted" 'ticked'`)).toBe("A &amp; B &quot;quoted&quot; &#39;ticked&#39;");
  });

  it("does not double-escape an already-encoded HTML entity — treats it as literal text", () => {
    // The source can legitimately contain the literal text "&lt;b&gt;" (e.g. copied from an
    // HTML editor). escapeHtml only escapes raw &<>"'; it must not try to detect entities.
    expect(escapeHtml("&lt;b&gt;bold&lt;/b&gt;")).toBe("&amp;lt;b&amp;gt;bold&amp;lt;/b&amp;gt;");
  });

  it("leaves plain text, unicode, and emoji untouched", () => {
    expect(escapeHtml("hello 🚀 日本語 ДСВХ")).toBe("hello 🚀 日本語 ДСВХ");
  });

  it("markup-looking text with a mix of tags and entities round-trips safely", () => {
    const input = 'x < y && y > z; <img src=x onerror="alert(1)">';
    const out = escapeHtml(input);
    expect(out).not.toContain("<img");
    expect(out).not.toContain('onerror="alert');
    expect(out).toBe("x &lt; y &amp;&amp; y &gt; z; &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("empty string escapes to empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});
