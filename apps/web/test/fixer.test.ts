// The one-tap fixer off the main thread (fixer/client.ts, fixer/fixer.worker.ts) and its local memory (fixer/memory.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixSuggestions, Scene } from "@csd/core";
import { createFixer, isAbort, type FixRunner, type WorkerLike } from "../src/fixer/client";
import { FIX_MEMORY_KEY, createFixMemory } from "../src/fixer/memory";
import type { FixRequest, FixResponse } from "../src/fixer/protocol";
import { initialDoc, reducer, type Doc } from "../src/state/doc";
import { tbone, tboneNet } from "./fakes";

const result = (why: string): FixSuggestions => ({ why, fixes: [], focus: { step: "vehicles", vehicleId: null, field: null }, trials: 1 });
const now = (fn: () => void) => { fn(); return () => undefined; };

/** A worker that answers when told to, and records what it was sent. */
class FakeWorker implements WorkerLike {
  static made: FakeWorker[] = [];
  sent: FixRequest[] = [];
  terminated = false;
  onmessage: ((e: { readonly data: FixResponse }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor() { FakeWorker.made.push(this); }
  postMessage(m: FixRequest): void { this.sent.push(m); }
  terminate(): void { this.terminated = true; }
  answer(why: string, i = this.sent.length - 1): void { this.onmessage?.({ data: { id: this.sent[i]!.id, ok: true, result: result(why) } }); }
}

afterEach(() => { FakeWorker.made = []; });

describe("the fixer client", () => {
  it("runs the search in the worker, sending each road network once, with this device's preferences", async () => {
    const run = vi.fn<FixRunner>(() => result("main"));
    const fixer = createFixer({ makeWorker: () => new FakeWorker(), run, defer: now });
    const roads = tboneNet();
    const p1 = fixer.suggest(tbone, roads, { prefer: { "zone:struck": 2 } });
    const w = FakeWorker.made[0]!;
    expect(w.sent[0]).toMatchObject({ scene: tbone, roads, roadsKey: 1, prefer: { "zone:struck": 2 } });
    w.answer("from the worker");
    await expect(p1).resolves.toMatchObject({ why: "from the worker" });
    expect(fixer.where()).toBe("worker");
    // The same roads again: only their key is sent.
    const p2 = fixer.suggest(tbone, roads);
    expect(w.sent[1]).toMatchObject({ roads: null, roadsKey: 1 });
    w.answer("again");
    await p2;
    // Other roads are sent with a new key; no roads at all is key null.
    const p3 = fixer.suggest(tbone, { ...roads });
    expect(w.sent[2]!.roads).not.toBeNull();
    expect(w.sent[2]!.roadsKey).toBe(2);
    w.answer("other roads");
    await p3;
    const p4 = fixer.suggest(tbone, null);
    expect(w.sent[3]).toMatchObject({ roads: null, roadsKey: null });
    w.answer("none");
    await p4;
    expect(run).not.toHaveBeenCalled();
    expect(FakeWorker.made).toHaveLength(1);
  });

  it("cancels a search for a scene that has changed: the worker is stopped and a fresh one takes the next", async () => {
    const fixer = createFixer({ makeWorker: () => new FakeWorker(), run: () => result("main"), defer: now });
    const ctl = new AbortController();
    const stale = fixer.suggest(tbone, null, { signal: ctl.signal });
    const first = FakeWorker.made[0]!;
    ctl.abort();
    const err = await stale.catch((e: unknown) => e);
    expect(isAbort(err)).toBe(true);
    expect(first.terminated).toBe(true);
    // A late answer from the stopped worker is ignored.
    first.answer("too late", 0);
    const fresh = fixer.suggest(tbone, tboneNet());
    const second = FakeWorker.made[1]!;
    expect(second).toBeDefined();
    // The new worker holds no roads yet, so they are sent again.
    expect(second.sent[0]!.roads).not.toBeNull();
    second.answer("fresh");
    await expect(fresh).resolves.toMatchObject({ why: "fresh" });
  });

  it("drops a queued request that is cancelled before it starts, and runs the rest in order", async () => {
    const fixer = createFixer({ makeWorker: () => new FakeWorker(), run: () => result("main"), defer: now });
    const a = fixer.suggest(tbone, null);
    const ctl = new AbortController();
    const b = fixer.suggest(tbone, null, { signal: ctl.signal });
    const c = fixer.suggest(tbone, null);
    ctl.abort();
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    const w = FakeWorker.made[0]!;
    expect(w.sent).toHaveLength(1);
    w.answer("a");
    await expect(a).resolves.toMatchObject({ why: "a" });
    expect(w.sent).toHaveLength(2);
    w.answer("c");
    await expect(c).resolves.toMatchObject({ why: "c" });
    expect(w.terminated).toBe(false);
  });

  it("falls back to the main thread, after the page has painted, when the worker can't start or fails", async () => {
    const run = vi.fn<FixRunner>(() => result("main"));
    let painted: (() => void) | null = null;
    const defer = (fn: () => void) => { painted = fn; return () => { painted = null; }; };
    const fixer = createFixer({ makeWorker: () => new FakeWorker(), run, defer });
    const p = fixer.suggest(tbone, null);
    FakeWorker.made[0]!.onerror?.(new Event("error"));
    expect(FakeWorker.made[0]!.terminated).toBe(true);
    expect(run).not.toHaveBeenCalled();
    (painted as (() => void) | null)?.();
    await expect(p).resolves.toMatchObject({ why: "main" });
    expect(fixer.where()).toBe("main");
    // And it stays on the main thread from then on.
    const q = fixer.suggest(tbone, null);
    (painted as (() => void) | null)?.();
    await q;
    expect(FakeWorker.made).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("uses the main thread when the browser has no Web Worker, or constructing one throws", async () => {
    const run = vi.fn<FixRunner>(() => result("main"));
    await expect(createFixer({ makeWorker: null, run, defer: now }).suggest(tbone, null)).resolves.toMatchObject({ why: "main" });
    const throwing = createFixer({ makeWorker: () => { throw new Error("blocked"); }, run, defer: now });
    await expect(throwing.suggest(tbone, null)).resolves.toMatchObject({ why: "main" });
    expect(throwing.where()).toBe("main");
  });

  it("gives up on a worker that never answers (a safety net; the search itself is capped by counts)", async () => {
    vi.useFakeTimers();
    try {
      const fixer = createFixer({ makeWorker: () => new FakeWorker(), run: () => result("main"), defer: now, timeoutMs: 1000 });
      const p = fixer.suggest(tbone, null);
      const caught = p.catch((e: unknown) => e);
      vi.advanceTimersByTime(1001);
      expect(await caught).toBeInstanceOf(Error);
      expect(FakeWorker.made[0]!.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the fixer worker", () => {
  it("answers each request with the physics' own suggestions, keeping the roads it was sent", async () => {
    const posted: FixResponse[] = [];
    const scope: { onmessage: ((e: { data: FixRequest }) => void) | null; postMessage: (m: FixResponse) => void } = { onmessage: null, postMessage: (m) => posted.push(m) };
    vi.stubGlobal("self", scope);
    vi.resetModules();
    await import("../src/fixer/fixer.worker");
    const roads = tboneNet();
    const refused: Scene = { ...tbone, vehicles: tbone.vehicles.map((v) => ({ ...v, zone: "rear" as const })) };
    scope.onmessage!({ data: { id: 7, scene: refused, roads, roadsKey: 3, prefer: {} } });
    scope.onmessage!({ data: { id: 8, scene: tbone, roads: null, roadsKey: 3, prefer: {} } });
    scope.onmessage!({ data: { id: 9, scene: tbone, roads: null, roadsKey: 4, prefer: {} } });
    expect(posted.map((p) => [p.id, p.ok])).toEqual([[7, true], [8, true], [9, false]]);
    const first = posted[0]!;
    if (first.ok) expect(first.result.fixes.length).toBeLessThanOrEqual(3);
    vi.unstubAllGlobals();
  });
});

describe("remembered fixes (local only)", () => {
  const memoryStore = (): Storage => {
    const data = new Map<string, string>();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: (k) => { data.delete(k); }, clear: () => data.clear(), key: () => null, get length() { return data.size; } };
  };

  it("keeps only the kind of fix picked and how often, and clears it", () => {
    const store = memoryStore();
    const m = createFixMemory(() => store);
    expect(m.load()).toEqual({});
    m.remember("zone:struck");
    m.remember("zone:struck");
    m.remember("direction:striking+zone:struck");
    expect(m.load()).toEqual({ "zone:struck": 2, "direction:striking+zone:struck": 1 });
    const raw = store.getItem(FIX_MEMORY_KEY)!;
    // Nothing about the scene: no letters, places, speeds or labels.
    expect(raw).not.toMatch(/Main Street|mph|lat|lon|"A"|Change/);
    m.clear();
    expect(m.load()).toEqual({});
    expect(store.getItem(FIX_MEMORY_KEY)).toBeNull();
  });

  it("ignores anything that isn't a kind, and caps each count", () => {
    const store = memoryStore();
    const m = createFixMemory(() => store);
    m.remember("Change A's hit side to Front");
    m.remember("<img src=x>");
    for (let i = 0; i < 50; i++) m.remember("swap");
    expect(m.load()).toEqual({ swap: 20 });
    store.setItem(FIX_MEMORY_KEY, JSON.stringify({ v: 1, kinds: { pin: 3, "bad kind": 2, zone: "x", lane: -1 } }));
    expect(m.load()).toEqual({ pin: 3 });
    store.setItem(FIX_MEMORY_KEY, "{not json");
    expect(m.load()).toEqual({});
  });

  it("works with storage blocked, full or missing: nothing is remembered and nothing throws", () => {
    const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("SecurityError"); }, removeItem: () => { throw new Error("SecurityError"); } } as unknown as Storage;
    const m = createFixMemory(() => blocked);
    expect(() => m.remember("zone:struck")).not.toThrow();
    expect(m.load()).toEqual({});
    expect(() => m.clear()).not.toThrow();
    const full = { ...memoryStore(), getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } } as Storage;
    expect(() => createFixMemory(() => full).remember("pin")).not.toThrow();
    const none = createFixMemory(() => null);
    expect(() => none.remember("pin")).not.toThrow();
    expect(none.load()).toEqual({});
  });
});

describe("applying a fix that moves the pin", () => {
  it("moves the pin like a drag and keeps the fixed scene exactly as checked (no road ids tidied after it)", () => {
    let d: Doc = reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" });
    d = { ...d, scene: { ...d.scene, location: { ...d.scene.location, label: "Main Street & Park Street" } } };
    const moved: Scene = { ...d.scene, location: { ...d.scene.location, lat: d.scene.location.lat + 0.0002, label: "", nearLabel: "Main Street & Park Street", source: "pin" } };
    const after = reducer(d, { type: "apply-fix", scene: moved });
    expect(after.scene.location).toEqual(moved.location);
    expect(after.reconcile).toBe(false);
    expect(reducer(after, { type: "reconcile-travel", choices: [] })).toBe(after);
    // A fix that keeps the pin leaves the location and the tidying as they were.
    const same = reducer(d, { type: "apply-fix", scene: { ...d.scene, vehicles: d.scene.vehicles.map((v, i) => (i === 1 ? { ...v, zone: "rear" as const } : v)) } });
    expect(same.scene.location).toBe(d.scene.location);
    expect(same.reconcile).toBe(d.reconcile);
  });
});
