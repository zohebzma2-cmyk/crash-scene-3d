// Tiny DOM test helpers (no testing-library dependency): mount, click, type, key, find by role and name.
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import type { Services } from "../src/services/types";
import { App } from "../src/App";
import { STORAGE_KEY } from "../src/state/doc";
import { TIPS_STORAGE_KEY } from "../src/tips/storage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (typeof window !== "undefined") window.scrollTo = (() => undefined) as typeof window.scrollTo;

export function mount(ui: ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  return { host, unmount: () => { act(() => root.unmount()); host.remove(); } };
}

export async function flush(ms = 0): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

export function click(el: Element | null): void {
  if (!el) throw new Error("click: element not found");
  act(() => { (el as HTMLElement).click(); });
}

export function setValue(input: Element | null, value: string): void {
  if (!input) throw new Error("setValue: element not found");
  const el = input as HTMLInputElement;
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export function key(el: Element | null, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  if (!el) throw new Error("key: element not found");
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
  act(() => { el.dispatchEvent(ev); });
  return ev;
}

const nameOf = (el: Element): string => (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
const ROLE_SELECTORS: Record<string, string> = { button: "button, [role=button]", radio: '[role="radio"]', tab: '[role="tab"]', radiogroup: '[role="radiogroup"]', heading: "h1,h2,h3", textbox: "input:not([type]),input[type=text],input[type=search],textarea", alert: '[role="alert"]', listbox: '[role="listbox"]', option: '[role="option"]' };

export function all(role: string, name?: string | RegExp, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ROLE_SELECTORS[role] ?? role)).filter((el) => {
    if (name === undefined) return true;
    const n = nameOf(el);
    return typeof name === "string" ? n === name : name.test(n);
  });
}
export function get(role: string, name?: string | RegExp, root: ParentNode = document): HTMLElement {
  const found = all(role, name, root);
  if (found.length !== 1) throw new Error(`get(${role}, ${String(name)}): found ${found.length}`);
  return found[0] as HTMLElement;
}
export const maybe = (role: string, name?: string | RegExp, root: ParentNode = document): HTMLElement | null => all(role, name, root)[0] ?? null;
export const text = (root: ParentNode = document.body): string => (root as HTMLElement).textContent?.replace(/\s+/g, " ") ?? "";

/** Render the whole app on a given step with injected services and a clean session. */
export async function renderApp(services: Services, opts: { hash?: string; search?: string; storage?: unknown; tips?: "shown" | "hidden" | "keep" } = {}) {
  window.sessionStorage.clear();
  // Tips are hidden unless a test asks for them, so other tests see the screens without them.
  if (opts.tips === "shown") window.localStorage.removeItem(TIPS_STORAGE_KEY);
  else if (opts.tips !== "keep") window.localStorage.setItem(TIPS_STORAGE_KEY, JSON.stringify({ hidden: [], all: true }));
  if (opts.storage !== undefined) window.sessionStorage.setItem(STORAGE_KEY, typeof opts.storage === "string" ? opts.storage : JSON.stringify(opts.storage));
  window.history.replaceState(null, "", `/${opts.search ?? ""}${opts.hash ?? "#location"}`);
  const m = mount(<App services={services} />);
  await flush();
  return m;
}

export function mockMatchMedia(matches: (q: string) => boolean): void {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: matches(q), media: q, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, onchange: null, dispatchEvent: () => false }));
}

/** jsdom has no layout; give Leaflet's containers a size so the map loads tiles. Undone by vi.restoreAllMocks(). */
export function sizeMapContainers(width = 800, height = 500): void {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
}
