// Node-building helpers (docs/10 §8, AGENTS.md rule 12): every view builds elements with
// `document.createElement` + `textContent`/`setAttribute`. There is no `innerHTML` anywhere in
// `src/ui/` — a value that came from Clockify (a description, a project name, a tag) can only ever
// land in a text node or an attribute value, both of which the DOM itself escapes. This is the
// "one esc() helper" the pass calls for: `el()`'s text-node children are that helper.

export type Child = Node | string | null | undefined | false;

/** Creates an element, sets attributes, and appends children. Every string child becomes a text
 * node (never parsed as markup) — this is the whole escaping story for the UI. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  append(node, children);
  return node;
}

/** Appends children to an existing node, same rules as `el()`. */
export function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

/** Removes every child of `node`. */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replaces the contents of `root` with `children` — the one place a view swaps itself in. */
export function mount(root: Element, ...children: Child[]): void {
  clear(root);
  append(root, children);
}
