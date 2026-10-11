// After a step change the new screen's title takes focus. A step whose code is still loading has no title yet,
// so this waits for it (bounded), and while the previous step's title may still be in the page, hidden (React
// hides suspended content with an inline display: none), only a shown title counts. It never takes focus from
// something the person moved to meanwhile (the About dialog, a header control): focus moves only from the page
// itself, from inside <main>, or from where it was at the step change.

const hidden = (el: HTMLElement | null): boolean => {
  for (let e = el; e; e = e.parentElement) if (e.hidden || e.style.display === "none") return true;
  return false;
};

/** Focuses the step's title now or when it appears. Returns a cancel (the next step change calls it). */
export function focusStepTitle(doc: Document, waitMs: number): () => void {
  const shownTitle = () => [...doc.querySelectorAll<HTMLElement>("main h1")].find((h) => !hidden(h)) ?? null;
  const before = doc.activeElement;
  const focus = (h1: HTMLElement) => {
    const a = doc.activeElement;
    if (a && a !== doc.body && a !== before && !doc.querySelector("main")?.contains(a)) return;
    h1.setAttribute("tabindex", "-1");
    h1.focus({ preventScroll: true });
  };
  const now = shownTitle();
  if (now) { focus(now); return () => undefined; }
  const main = doc.querySelector("main");
  if (!main || typeof MutationObserver !== "function") return () => undefined;
  const mo = new MutationObserver(() => {
    const h1 = shownTitle();
    if (h1) { mo.disconnect(); window.clearTimeout(stop); focus(h1); }
  });
  const stop = window.setTimeout(() => mo.disconnect(), waitMs);
  mo.observe(main, { childList: true, subtree: true });
  return () => { mo.disconnect(); window.clearTimeout(stop); };
}
