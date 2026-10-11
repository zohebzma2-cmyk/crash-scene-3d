// The page's side of the one-tap fixer (DESIGN.md section 18). The search runs in a Web Worker so the page never
// freezes; a search for a scene that has since changed is cancelled (the worker is stopped mid-search and a fresh one
// started for the next request). Only when this browser can't run the worker (no Worker, or it fails to start) does the
// search run on the main thread, after the refusal and "Looking for…" have painted.
import type { FixOptions, FixSuggestions, RoadNetwork, Scene } from "@csd/core";
import type { FixRequest, FixResponse } from "./protocol";

/** The part of a Worker the fixer uses (a fake in tests). */
export interface WorkerLike {
  postMessage(message: FixRequest): void;
  terminate(): void;
  onmessage: ((e: { readonly data: FixResponse }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export type FixRunner = (scene: Scene, roads: RoadNetwork | null, opts: FixOptions) => FixSuggestions;

export interface SuggestOptions {
  /** This device's remembered fix kinds (memory.ts). */
  readonly prefer?: Readonly<Record<string, number>>;
  /** Abort when the scene changes: the search stops and the promise rejects with an AbortError. */
  readonly signal?: AbortSignal;
}

export interface FixerService {
  suggest(scene: Scene, roads: RoadNetwork | null, opts?: SuggestOptions): Promise<FixSuggestions>;
  /** Where the latest search ran: "worker", or "main" when this browser can't run the worker. Null before any search. */
  where(): "worker" | "main" | null;
}

export interface FixerDeps {
  /** Starts the worker; null when this browser has no Web Workers. May throw (then the main thread is used). */
  readonly makeWorker: (() => WorkerLike) | null;
  /** The same search on the main thread, for browsers without the worker. */
  readonly run: FixRunner;
  /** Runs `fn` once the page has painted (default: the next frame, then a task after it). */
  readonly defer?: (fn: () => void) => () => void;
  /** A worker that hasn't answered after this long has failed (a safety net only; the search itself is capped by counts). */
  readonly timeoutMs?: number;
}

const abortError = (): Error => (typeof DOMException === "function" ? new DOMException("The fix search was cancelled.", "AbortError") : Object.assign(new Error("The fix search was cancelled."), { name: "AbortError" }));

export const isAbort = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";

/** After the next paint: a frame, then a task (what the main-thread search always waited for). */
function afterPaint(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16) as unknown as number;
  const caf = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (h: number) => clearTimeout(h);
  const frame = raf(() => { timer = setTimeout(fn, 0); });
  return () => { caf(frame); if (timer !== null) clearTimeout(timer); };
}

interface Job {
  readonly id: number;
  readonly scene: Scene;
  readonly roads: RoadNetwork | null;
  readonly prefer: Readonly<Record<string, number>>;
  readonly resolve: (s: FixSuggestions) => void;
  readonly reject: (e: unknown) => void;
  readonly signal: AbortSignal | undefined;
  cancel: (() => void) | null;
  done: boolean;
}

export function createFixer(deps: FixerDeps): FixerService {
  const defer = deps.defer ?? afterPaint;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  let worker: WorkerLike | null = null;
  let broken = deps.makeWorker === null;
  /** The road data the current worker holds. */
  let heldKey: number | null = null;
  let where: "worker" | "main" | null = null;
  let nextId = 1, nextRoadsKey = 1;
  const roadsKeys = new WeakMap<RoadNetwork, number>();
  const keyOf = (net: RoadNetwork): number => {
    let k = roadsKeys.get(net);
    if (k === undefined) { k = nextRoadsKey++; roadsKeys.set(net, k); }
    return k;
  };
  const queue: Job[] = [];
  let current: Job | null = null;

  const stopWorker = (): void => {
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    try { worker.terminate(); } catch { /* already gone */ }
    worker = null;
    heldKey = null;
  };

  const finish = (job: Job): void => {
    job.done = true;
    job.cancel = null;
    if (current === job) current = null;
    pump();
  };

  const runMain = (job: Job): void => {
    current = job;
    where = "main";
    job.cancel = defer(() => {
      if (job.done) return;
      let out: FixSuggestions | null = null, err: unknown = null;
      try { out = deps.run(job.scene, job.roads, { prefer: job.prefer }); } catch (e) { err = e; }
      finish(job);
      if (out) job.resolve(out); else job.reject(err);
    });
  };

  const runWorker = (job: Job): void => {
    if (!worker) {
      try { worker = deps.makeWorker!(); } catch { broken = true; runMain(job); return; }
    }
    const w = worker;
    current = job;
    where = "worker";
    const roadsKey = job.roads ? keyOf(job.roads) : null;
    const send = roadsKey !== null && roadsKey !== heldKey;
    heldKey = roadsKey ?? heldKey;
    const timer = setTimeout(() => { if (job.done) return; stopWorker(); finish(job); job.reject(new Error("The fix search took too long.")); }, timeoutMs);
    w.onmessage = (e) => {
      if (e.data.id !== job.id || job.done) return;
      clearTimeout(timer);
      finish(job);
      if (e.data.ok) job.resolve(e.data.result); else job.reject(new Error(e.data.message));
    };
    w.onerror = () => {
      // The worker couldn't start or crashed: this search, and every later one, runs on the main thread instead.
      clearTimeout(timer);
      if (job.done) return;
      broken = true;
      stopWorker();
      current = null;
      runMain(job);
    };
    job.cancel = () => { clearTimeout(timer); stopWorker(); };
    try {
      w.postMessage({ id: job.id, scene: job.scene, roads: send ? job.roads : null, roadsKey, prefer: job.prefer });
    } catch {
      clearTimeout(timer);
      broken = true;
      stopWorker();
      current = null;
      runMain(job);
    }
  };

  function pump(): void {
    if (current) return;
    const job = queue.shift();
    if (!job) return;
    if (broken) runMain(job); else runWorker(job);
  }

  return {
    where: () => where,
    suggest(scene, roads, opts = {}) {
      return new Promise<FixSuggestions>((resolve, reject) => {
        if (opts.signal?.aborted) { reject(abortError()); return; }
        const job: Job = { id: nextId++, scene, roads, prefer: opts.prefer ?? {}, resolve, reject, signal: opts.signal, cancel: null, done: false };
        opts.signal?.addEventListener("abort", () => {
          if (job.done) return;
          const wasCurrent = current === job;
          job.cancel?.();
          const at = queue.indexOf(job);
          if (at >= 0) queue.splice(at, 1);
          job.done = true;
          if (wasCurrent) current = null;
          reject(abortError());
          pump();
        }, { once: true });
        queue.push(job);
        pump();
      });
    },
  };
}
