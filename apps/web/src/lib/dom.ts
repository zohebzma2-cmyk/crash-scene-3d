// Small browser helpers.
import { useEffect, useState } from "react";

/** Resolve a CSS color token (light-dark() and all) to the rgb() string the browser computes. */
export function resolveColor(token: string, scheme?: "light" | "dark"): string {
  const probe = document.createElement("span");
  probe.style.color = token.startsWith("--") ? `var(${token})` : token;
  if (scheme) probe.style.colorScheme = scheme;
  probe.style.display = "none";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

export function useMediaQuery(query: string): boolean {
  const get = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

export const PHONE_QUERY = "(max-width: 767px)";
export const usePhone = (): boolean => useMediaQuery(PHONE_QUERY);

export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** Element size, updated on resize. Falls back to the given size where nothing can be measured (tests). */
export function useElementSize<T extends HTMLElement>(fallback: { w: number; h: number }): [(el: T | null) => void, { w: number; h: number }] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: r.width, h: r.height }));
    };
    read();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size];
}

/** A token size in pixels (a length token such as --size-pin), read through the browser. Falls back where it can't be measured. */
export function tokenPx(name: string, fallback: number): number {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.width = `var(${name})`;
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return Number.isFinite(w) && w > 0 ? w : fallback;
}
