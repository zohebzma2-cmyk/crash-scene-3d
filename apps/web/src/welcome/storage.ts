// The first-visit welcome (DESIGN.md section 19, "Welcome on a first visit"): whether this browser has seen it,
// and when it must not show at all. Every read and write is wrapped: with storage blocked (private mode, policy)
// the welcome still works, and closing it lasts until the page closes.
export const WELCOME_STORAGE_KEY = "csd.welcome.v1";

/** Seen in this page's lifetime, for browsers whose storage throws. */
let seenThisPage = false;

/** Has this browser seen (and closed) the welcome? A missing, damaged or unreadable value counts as not seen. */
export function readWelcomeSeen(): boolean {
  if (seenThisPage) return true;
  try {
    const raw = window.localStorage.getItem(WELCOME_STORAGE_KEY);
    if (!raw) return false;
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && (v as { seen?: unknown }).seen === true;
  } catch {
    return false;
  }
}

/** Remembers that the welcome was seen, on this browser for good when storage allows, else for this page. */
export function writeWelcomeSeen(): void {
  seenThisPage = true;
  try {
    window.localStorage.setItem(WELCOME_STORAGE_KEY, JSON.stringify({ seen: true }));
  } catch {
    /* storage is blocked or full: the choice lasts until the page closes */
  }
}

/** Test hook: forget the in-page memory (a new page load). */
export function resetWelcomeMemory(): void {
  seenThisPage = false;
}

export interface WelcomeContext {
  /** The page's query string (`?example=…`). */
  readonly search: string;
  /** The page's hash (`#review`). */
  readonly hash: string;
  /** The app is running on fixtures (the e2e build, ?fixtures=1). */
  readonly fixtureMode: boolean;
  /** This build may honour test switches (a dev server or a VITE_FIXTURES=1 build). */
  readonly fixturesAllowed: boolean;
}

/**
 * Never over a link that opens something specific: an example (`?example=`) or a step other than the first (`#vehicles`,
 * `#review`, `#export`; `#location` is the first step, the same as no hash). Never in fixtures mode either, so tests see
 * the screens as before, unless the test asks for it with `?welcome=1` (honoured only where fixtures are allowed).
 */
export function welcomeSuppressed(ctx: WelcomeContext): boolean {
  const p = new URLSearchParams(ctx.search);
  if (p.has("example")) return true;
  const h = ctx.hash.replace(/^#/, "");
  if (h !== "" && h !== "location") return true;
  if (ctx.fixtureMode && !(ctx.fixturesAllowed && p.get("welcome") === "1")) return true;
  return false;
}

/** Show the welcome as the page opens? */
export const shouldShowWelcome = (ctx: WelcomeContext): boolean => !welcomeSuppressed(ctx) && !readWelcomeSeen();
