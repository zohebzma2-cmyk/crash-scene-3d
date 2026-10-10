// Which tips this device has hidden. Every read and write is wrapped: with storage blocked
// (private mode, policy) the tips still work for the page's lifetime and simply aren't remembered.
export const TIPS_STORAGE_KEY = "csd.tips.v1";

export interface TipsState {
  /** Tip ids hidden one by one. */
  readonly hidden: readonly string[];
  /** "Hide all tips" was used: also covers tips added later. */
  readonly all: boolean;
}
export const SHOWING: TipsState = { hidden: [], all: false };

export function readTipsState(): TipsState {
  try {
    const raw = window.localStorage.getItem(TIPS_STORAGE_KEY);
    if (!raw) return SHOWING;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null) return SHOWING;
    const o = v as { hidden?: unknown; all?: unknown };
    const hidden = Array.isArray(o.hidden) ? o.hidden.filter((x): x is string => typeof x === "string") : [];
    return { hidden, all: o.all === true };
  } catch {
    return SHOWING;
  }
}

export function writeTipsState(s: TipsState): void {
  try {
    window.localStorage.setItem(TIPS_STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage is blocked or full: the choice lasts until the page closes */
  }
}

export const isHidden = (s: TipsState, id: string): boolean => s.all || s.hidden.includes(id);
