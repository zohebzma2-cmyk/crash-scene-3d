// The 3D viewer's code (three.js, react-three-fiber) is one lazy chunk. This module starts it, tracks it,
// and can start it again after a failure. It is in the main chunk and imports nothing heavy.
//
// It replaces React.lazy because lazy() keeps a rejected import forever. A retry needs a new import(), and
// Chromium also caches a failed module fetch by URL, so a retry imports the same file under a fresh query
// (the URL is in Chromium's error message, or on the preload link Vite adds for the chunk).
import { useSyncExternalStore } from "react";

type ViewerModule = typeof import("./Viewer");
export type ViewerChunkStatus = "idle" | "loading" | "ready" | "failed";

let status: ViewerChunkStatus = "idle";
let mod: ViewerModule | null = null;
let promise: Promise<ViewerModule> | null = null;
let failedUrl: string | null = null;
let attempts = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Only our own built 3D chunk is ever imported again: same origin, /assets/Viewer-<hash>.js. */
export function isViewerChunkUrl(url: string, origin: string): boolean {
  try {
    const u = new URL(url, origin);
    return u.origin === origin && /^\/assets\/Viewer-[\w-]+\.js$/.test(u.pathname);
  } catch {
    return false;
  }
}

/** The URL of the module that failed, from the browser's error message (Chromium names it). */
export function failedModuleUrl(e: unknown): string | null {
  const text = e instanceof Error ? e.message : String(e);
  const m = /(https?:\/\/[^\s'"]+\.js)\b/.exec(text);
  return m ? m[1]! : null;
}

function start(load: () => Promise<ViewerModule>): Promise<ViewerModule> {
  status = "loading";
  emit();
  const p = load().then(
    (m) => { if (promise === p) { mod = m; status = "ready"; failedUrl = null; emit(); } return m; },
    (e: unknown) => { if (promise === p) { status = "failed"; failedUrl = failedModuleUrl(e) ?? failedUrl; emit(); } throw e; },
  );
  promise = p;
  return p;
}

/** Starts loading the 3D code (once); safe to call early and often. After a failure only Retry starts it again. */
export function loadViewer(): Promise<ViewerModule> {
  return promise ?? start(() => import("./Viewer"));
}

/** The built chunk's URL from the preload link Vite added for it (WebKit's import error doesn't name the file). */
function preloadedChunkUrl(): string | null {
  if (typeof document === "undefined") return null;
  for (const l of document.querySelectorAll<HTMLLinkElement>('link[href*="/Viewer-"]')) {
    if (/\/Viewer-[^/?]+\.js$/.test(new URL(l.href, location.href).pathname)) return l.href;
  }
  return null;
}

/** How the page reloads when an in-place retry can't help (replaced in tests). */
let reload: () => void = () => window.location.reload();
export const setReloadForTests = (fn: () => void): void => { reload = fn; };

/**
 * After a failure: load it again, past the browser's cached failure (a fresh query on the same file). If the file
 * can't be named as our own chunk, or a retry already failed, the page reloads instead (the scene is kept in
 * session storage).
 */
export function retryViewer(): Promise<ViewerModule> {
  if (status !== "failed") return loadViewer();
  const url = failedUrl ?? preloadedChunkUrl();
  const origin = typeof location === "undefined" ? "" : location.origin;
  if (attempts >= 1 || !url || !isViewerChunkUrl(url, origin)) {
    reload();
    return new Promise<ViewerModule>(() => undefined);
  }
  attempts += 1;
  return start(() => import(/* @vite-ignore */ `${url}${url.includes("?") ? "&" : "?"}retry=${attempts}`) as Promise<ViewerModule>);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => status;

/** The chunk's status, and the module once it is in. */
export function useViewerModule(): { status: ViewerChunkStatus; module: ViewerModule | null } {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  return { status: s, module: s === "ready" ? mod : null };
}

let webgl: boolean | null = null;
/** Can this browser make a WebGL context at all? Checked once (each check makes a context). */
export function hasWebGL(): boolean {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") ?? c.getContext("webgl");
    webgl = !!gl;
    // Give the probe's context back straight away: browsers cap live contexts.
    (gl as WebGLRenderingContext | null)?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webgl = false;
  }
  return webgl;
}

/** Tests only: forget everything. */
export function resetViewerLoader(): void {
  status = "idle"; mod = null; promise = null; failedUrl = null; attempts = 0; webgl = null;
  emit();
}
