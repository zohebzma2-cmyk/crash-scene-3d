// Icons from design/icons/icons.json (the single source of truth). The markup in that file is
// parsed once into plain element descriptions and rendered as React elements, never as HTML.
import { createElement, type ReactElement } from "react";
import iconsJson from "../../../../design/icons/icons.json";

interface IconNode {
  readonly tag: "path" | "circle" | "rect";
  readonly attrs: Readonly<Record<string, string>>;
}

const TAGS = new Set(["path", "circle", "rect"]);
const camel = (s: string) => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Parse the inner markup of one icon (self-closing path, circle and rect elements only). */
export function parseIconMarkup(markup: string): IconNode[] {
  const nodes: IconNode[] = [];
  for (const m of markup.matchAll(/<(\w+)\s([^>]*?)\/>/g)) {
    const tag = m[1] ?? "";
    if (!TAGS.has(tag)) continue;
    const attrs: Record<string, string> = {};
    for (const a of (m[2] ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[camel(a[1] ?? "")] = a[2] ?? "";
    nodes.push({ tag: tag as IconNode["tag"], attrs });
  }
  return nodes;
}

const ICONS: ReadonlyMap<string, IconNode[]> = (() => {
  const map = new Map<string, IconNode[]>();
  const groups = (iconsJson as unknown as { groups: Record<string, Record<string, string>> }).groups;
  for (const group of Object.values(groups)) for (const [name, markup] of Object.entries(group)) map.set(name, parseIconMarkup(markup));
  return map;
})();

export const ICON_NAMES: readonly string[] = [...ICONS.keys()];

export interface IconProps {
  readonly name: string;
  /** Extra classes: "icon-xs", "icon-sm", "icon-lg". */
  readonly className?: string;
  readonly title?: string;
}

export function Icon({ name, className = "", title }: IconProps): ReactElement | null {
  const nodes = ICONS.get(name);
  if (!nodes) return null;
  return (
    <svg className={`icon ${className}`.trim()} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : "true"} role={title ? "img" : undefined} focusable="false">
      {title ? <title>{title}</title> : null}
      {nodes.map((n, i) => createElement(n.tag, { key: i, ...n.attrs }))}
    </svg>
  );
}
