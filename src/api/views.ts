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

/** The verified component shell (docs/10). `theme`/`language` are the display-safe claim fields
 * (docs/04 §Component verification) — carried as data attributes for `src/ui/app.ts` to read and
 * apply via the SDK's `applyClockifyTheme`/`applyClockifyLanguage`. The auth token is never
 * embedded here: the shell reads it from `?auth_token` client-side (docs/10 §8) and keeps it in
 * memory only — it never touches the DOM or this markup. */
export function componentShellHtml(
  parentOrigin: string,
  staticAppJsPath: string,
  staticAppCssPath: string,
  claims: { readonly theme?: string; readonly language?: string; readonly workspaceRole?: string } = {},
): string {
  const safeOrigin = escapeHtml(parentOrigin);
  const safeScriptPath = escapeHtml(staticAppJsPath);
  const safeStylePath = escapeHtml(staticAppCssPath);
  const safeTheme = escapeHtml(claims.theme ?? "");
  const safeLanguage = escapeHtml(claims.language ?? "");
  const safeRole = escapeHtml(claims.workspaceRole ?? "");
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Time Entry Recovery</title><link rel="stylesheet" href="${safeStylePath}"></head>
<body data-parent-origin="${safeOrigin}" data-theme="${safeTheme}" data-language="${safeLanguage}" data-role="${safeRole}">
<main id="app"><h1>RestoreTime</h1><p>Loading…</p></main>
<script src="${safeScriptPath}"></script>
</body>
</html>`;
}
