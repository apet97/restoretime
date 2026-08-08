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

  // PASS-03 extension: entity-shaped and markup-shaped payloads matching the actual Clockify-
  // controlled fields the shell embeds server-side (docs/10 §8) — theme/language/workspaceRole
  // claims and the parent-origin config all pass through this same function before landing in the
  // component shell's HTML attributes (src/api/views.ts componentShellHtml).
  it("a hostile theme/language/role claim value cannot break out of a data attribute", () => {
    const hostileTheme = '"><script>alert(1)</script>';
    const out = escapeHtml(hostileTheme);
    expect(out).not.toContain('"><script>');
    expect(out).toBe("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("entity-shaped payload mixing numeric and named entities round-trips as literal text", () => {
    const input = "AT&amp;T &#39;quoted&#39; &lt;tag&gt;";
    const out = escapeHtml(input);
    // Every literal &, <, >, ' in the source is escaped — including inside what looks like an
    // existing entity — so the browser can only ever render this back as the original text.
    expect(out).toBe("AT&amp;amp;T &amp;#39;quoted&amp;#39; &amp;lt;tag&amp;gt;");
  });

  it("markup-shaped payload with a closing tag and an event handler attribute never contains an open tag", () => {
    const input = '</main><svg onload=alert(document.cookie)>';
    const out = escapeHtml(input);
    expect(out).not.toMatch(/<\/?[a-z]/i);
    expect(out).toBe("&lt;/main&gt;&lt;svg onload=alert(document.cookie)&gt;");
  });
});
