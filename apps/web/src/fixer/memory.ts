// Which kinds of one-tap fix the claimant on this device has picked before, so similar kinds are listed first next time
// (among fixes of the same size; DESIGN.md section 18, docs/decisions/0009-fixer-learning.md).
//
// Only the kind is kept, e.g. "zone:struck" (a hit side changed on a vehicle marked as the one hit) or "direction:striking",
// with how many times it was picked: never the scene, the vehicles, the location or anything typed. It lives in this
// browser's localStorage, is never sent anywhere, and "Clear remembered fixes" removes it. Storage that is blocked or full
// simply means nothing is remembered.
export const FIX_MEMORY_KEY = "csd.fixes.v1";
/** At most this many kinds are kept, and a kind's count stops growing here, so one habit can't swamp the rest. */
const MAX_KINDS = 32;
const MAX_COUNT = 20;
/** What a kind looks like (Fix.kind): fields and roles joined by "+", or "swap", or "pin". Anything else is ignored. */
const KIND = /^[a-z]+(:[a-z]+)?(\+[a-z]+(:[a-z]+)?)*$/;

export interface FixMemory {
  /** Kind -> how strongly it is preferred (the number of times picked). Empty when nothing is remembered. */
  load(): Record<string, number>;
  /** Remember that a fix of this kind was picked. */
  remember(kind: string): void;
  clear(): void;
}

function storage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function read(store: Storage | null): Record<string, number> {
  if (!store) return {};
  try {
    const raw = store.getItem(FIX_MEMORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    const kinds = typeof parsed === "object" && parsed !== null ? (parsed as { kinds?: unknown }).kinds : null;
    if (typeof kinds !== "object" || kinds === null) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(kinds as Record<string, unknown>).slice(0, MAX_KINDS)) {
      if (KIND.test(k) && k.length <= 80 && typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.min(MAX_COUNT, Math.floor(v));
    }
    return out;
  } catch {
    return {};
  }
}

export function createFixMemory(getStore: () => Storage | null = storage): FixMemory {
  return {
    load: () => read(getStore()),
    remember(kind) {
      if (!KIND.test(kind) || kind.length > 80) return;
      const store = getStore();
      if (!store) return;
      const kinds = read(store);
      kinds[kind] = Math.min(MAX_COUNT, (kinds[kind] ?? 0) + 1);
      // Keep the most picked kinds when the list is full.
      const kept = Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_KINDS));
      try { store.setItem(FIX_MEMORY_KEY, JSON.stringify({ v: 1, kinds: kept })); } catch { /* blocked or full: nothing is remembered */ }
    },
    clear() {
      try { getStore()?.removeItem(FIX_MEMORY_KEY); } catch { /* blocked: there is nothing to clear */ }
    },
  };
}
