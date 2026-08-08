// HTML shell + escaping helpers (docs/05). AGENTS.md rule 12: escape all Clockify- or
// operator-controlled content before rendering; no innerHTML with interpolated values.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes Clockify-controlled strings (descriptions, names) before any HTML rendering
 * (AGENTS.md rule 12, UT-X01). Exported for direct unit testing; also used by the component
 * shell above. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** The verified component shell. The real UI is PASS-03; this proves the component boundary. */
export function componentShellHtml(parentOrigin: string, staticAppJsPath: string): string {
  const safeOrigin = escapeHtml(parentOrigin);
  const safeScriptPath = escapeHtml(staticAppJsPath);
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Time Entry Recovery</title></head>
<body data-parent-origin="${safeOrigin}">
<main><h1>RestoreTime</h1><p id="status">Loading…</p></main>
<script src="${safeScriptPath}"></script>
</body>
</html>`;
}
