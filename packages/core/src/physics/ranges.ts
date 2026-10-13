// "Not sure" speeds: which of the scanned speeds the numbers shown cover, and the sentences that explain the cuts.
// The scan has one entry per step between the low and high speed; `good` lists the steps where the crash works.

export interface RangeChoice {
  /** The step the picture uses: the middle one if it works, else the nearest that does (the lower on a tie). */
  readonly picK: number;
  /** The ends of the shown range: the contiguous run of working steps that contains the picture. */
  readonly lowK: number;
  readonly highK: number;
  /** Working steps outside that run (separated from it by steps that don't work); they are left out. */
  readonly excluded: readonly number[];
}

/**
 * Choose what to show from the working steps. A set with holes is never reported as one low-to-high range:
 * only the contiguous run containing the picture speed is, and the rest are returned in `excluded`.
 */
export function selectRange(good: readonly number[], midK: number): RangeChoice {
  if (good.length === 0) throw new Error("selectRange needs at least one working step");
  const picK = good.includes(midK) ? midK : good.reduce((best, k) => (Math.abs(k - midK) < Math.abs(best - midK) ? k : best), good[0]!);
  const set = new Set(good);
  let lowK = picK, highK = picK;
  while (set.has(lowK - 1)) lowK--;
  while (set.has(highK + 1)) highK++;
  return { picK, lowK, highK, excluded: good.filter((k) => k < lowK || k > highK) };
}

/** Why the speed next to the shown range doesn't work. */
export type CutKind = "closing" | "pass" | "building" | "start";

/** Runs of consecutive step numbers, as [first, last] pairs: [2, 3, 4, 18, 19] gives [[2, 4], [18, 19]]. */
export function excludedRuns(steps: readonly number[]): Array<[number, number]> {
  const sorted = [...steps].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last && k === last[1] + 1) last[1] = k; else out.push([k, k]);
  }
  return out;
}

/**
 * The sentence for a cut at one end of the shown range, used ONLY when every scanned step beyond that end fails, so it
 * is literally true. `fail` is the failing speed next to the shown range and `shown` the first speed that is shown, both
 * formatted exactly as scanned.
 *   start: "At 22 mph and below, vehicle B wouldn't have reached vehicle A, so the numbers shown start at 22.5 mph."
 *   end:   "At 27 mph and above, vehicle A and vehicle B wouldn't have been closing in on each other, so the numbers shown end at 26.5 mph."
 */
export function cutSentence(side: "start" | "end", kind: CutKind, cause: string, other: string, fail: string, shown: string): string {
  const when = side === "start" ? `At ${fail} and below` : `At ${fail} and above`;
  const tail = side === "start" ? `so the numbers shown start at ${shown}.` : `so the numbers shown end at ${shown}.`;
  const V = `vehicle ${cause}`, O = `vehicle ${other}`;
  if (kind === "building") return `${when}, ${V} would have driven through a building before the crash, ${tail}`;
  if (kind === "pass") return `${when}, ${V} would have passed through ${O} before the crash, ${tail}`;
  if (kind === "start") return `${when}, ${V} couldn't have reached that speed from a stop in the room it had, ${tail}`;
  return side === "start"
    ? `${when}, ${V} wouldn't have reached ${O}, ${tail}`
    : `${when}, ${V} and ${O} wouldn't have been closing in on each other, ${tail}`;
}

/** "a", "a and b", "a, b and c". */
const listOf = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The sentence for working speeds that are left out because speeds that don't work lie between them and the ones shown.
 * One entry per separate run, e.g. ["21 to 22 mph", "28 to 29 mph"]: never one span that takes in failing or shown speeds.
 */
export function gapSentence(vehicle: string, runs: readonly string[]): string {
  return `Speeds of ${listOf(runs)} for vehicle ${vehicle} would also work, but speeds that don't work lie between them and the ones shown, so they are left out.`;
}
