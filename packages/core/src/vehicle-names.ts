// Matching what people type against NHTSA vPIC's make and model names: "chevy" is Chevrolet, "vw" is
// Volkswagen, "f150" is F-150, "crv" is CR-V, and "silverdo" or "toyta" still find the right one.
// Pure functions, no DOM: the vehicle picker ranks with these, the proxy and the tests share them.

/** Lower case, accents dropped, everything but letters and digits removed: "F-150" and "f 150" are both "f150". */
export function normName(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Common names for makes, normalized (normName) on both sides: alias -> the make's own normalized name.
 * A full alias match counts as an exact match ("chevy" is Chevrolet, not a fuzzy guess).
 */
export const MAKE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // No "chev": that is half of "chevy" or "chevrolet", and a half-typed make is never looked up (it still ranks Chevrolet first).
  chevy: "chevrolet", chevrolette: "chevrolet",
  vw: "volkswagen", volks: "volkswagen", volkswagon: "volkswagen", vdub: "volkswagen",
  merc: "mercedesbenz", mercedes: "mercedesbenz", benz: "mercedesbenz", mb: "mercedesbenz", mercedez: "mercedesbenz", mercedesbens: "mercedesbenz",
  beemer: "bmw", bimmer: "bmw", beamer: "bmw", bmer: "bmw",
  rangerover: "landrover", range: "landrover", rover: "landrover", lr: "landrover",
  harley: "harleydavidson", hd: "harleydavidson", harleydavidsen: "harleydavidson",
  caddy: "cadillac", caddie: "cadillac", olds: "oldsmobile", alfa: "alfaromeo", aston: "astonmartin",
  infinity: "infiniti", mitsu: "mitsubishi", subie: "subaru", subi: "subaru", lambo: "lamborghini",
  rolls: "rollsroyce", jag: "jaguar", minicooper: "mini",
  dodgeram: "ram", ramtrucks: "ram", hyundia: "hyundai", hundai: "hyundai", nissian: "nissan",
  porshe: "porsche", chrystler: "chrysler", lexis: "lexus", acrua: "acura", gm: "gmc",
});

/**
 * Common model names, normalized: alias -> the model's normalized name. Spelling variants ("f150", "crv",
 * "rav 4") already match through normName, and "civic si" or "silverado 1500" match the model they start with;
 * these are the nicknames that don't.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  vette: "corvette", bug: "beetle", tbird: "thunderbird", monte: "montecarlo", forerunner: "4runner", fourrunner: "4runner",
  miata: "mx5", mx5miata: "mx5", jeepwrangler: "wrangler", cruiser: "landcruiser", landcruzer: "landcruiser",
  stang: "mustang", cammy: "camry", gwagon: "gclass", gwagen: "gclass", silverado1500: "silverado", sierra1500: "sierra",
  ram1500: "1500", ram2500: "2500", ram3500: "3500",
});

/**
 * Makes people in the US most often mean, most likely first (normalized). vPIC lists about 2,100 makes for cars,
 * MPVs, trucks and motorcycles, most of them small motorcycle and truck builders, so these go first within each
 * kind of match: "ch" offers Chevrolet and Chrysler before "Champion Bus".
 */
export const POPULAR_MAKES: readonly string[] = Object.freeze([
  "toyota", "ford", "chevrolet", "honda", "nissan", "jeep", "hyundai", "kia", "ram", "subaru", "gmc", "volkswagen",
  "bmw", "mercedesbenz", "mazda", "tesla", "lexus", "audi", "dodge", "buick", "cadillac", "chrysler", "acura", "volvo",
  "mitsubishi", "infiniti", "lincoln", "landrover", "porsche", "mini", "genesis", "jaguar", "alfaromeo", "fiat",
  "harleydavidson", "rivian", "polestar", "lucid", "pontiac", "saturn", "mercury", "scion", "oldsmobile", "plymouth",
  "hummer", "saab", "suzuki", "yamaha", "kawasaki", "ducati", "triumph", "indian", "ktm", "isuzu", "freightliner",
  "peterbilt", "kenworth", "mack", "international", "maserati", "ferrari", "lamborghini", "bentley", "rollsroyce",
  "astonmartin", "smart", "vespa", "bmwmotorcycle",
]);

/** How the text matched, best first. */
export type MatchKind = "exact" | "prefix" | "word" | "alias" | "contains" | "fuzzy";
const KIND_ORDER: Readonly<Record<MatchKind, number>> = { exact: 0, prefix: 1, word: 2, alias: 3, contains: 4, fuzzy: 5 };

export interface RankedName {
  readonly name: string;
  readonly kind: MatchKind;
}

export interface RankOptions {
  /** Normalized alias -> normalized name. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** Normalized names that go first within a kind of match, in this order. */
  readonly popular?: readonly string[];
  /**
   * Also try the text with this prefix removed ("ram 1500" for make Ram is "1500"); several are allowed (a make and
   * its everyday names: "chevy silverado" for Chevrolet is "silverado"). See makeAndAliases.
   */
  readonly stripPrefix?: string | readonly string[];
  /** At most this many results (default all). */
  readonly limit?: number;
}

/**
 * Optimal-string-alignment distance (Damerau-Levenshtein with adjacent swaps, each substring edited once).
 * Stops early and returns max + 1 once the distance must be larger than `max`.
 */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (prev2[j - 2] as number) + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n] as number;
}

/** Typos allowed for a normalized text of this length: none under 4 characters, 1 up to 5, 2 from 6. */
export const maxTypos = (len: number): number => (len < 4 ? 0 : len < 6 ? 1 : 2);

const wordsOf = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

interface Scored { name: string; kind: MatchKind; dist: number; pop: number; len: number }

/** A names list prepared once: each name's normalized key and words, and key -> first name. */
interface NamesIndex { readonly keys: readonly string[]; readonly words: readonly (readonly string[])[]; readonly byKey: ReadonlyMap<string, string> }
const INDEXES = new WeakMap<readonly string[], NamesIndex>();
/** The same array (the makes list, one model list) is normalized once, not on every keystroke or render. */
function indexOf(names: readonly string[]): NamesIndex {
  let idx = INDEXES.get(names);
  if (!idx) {
    const keys = names.map(normName);
    const byKey = new Map<string, string>();
    keys.forEach((k, i) => { if (!byKey.has(k)) byKey.set(k, names[i] as string); });
    idx = { keys, words: names.map(wordsOf), byKey };
    INDEXES.set(names, idx);
  }
  return idx;
}

/** The text with any of these prefixes (normalized) taken off the front: the rest, and its words. */
function stripped(text: string, q: string, prefixes: readonly string[]): Array<{ q: string; words: string[] }> {
  const out: Array<{ q: string; words: string[] }> = [];
  for (const strip of prefixes) {
    if (!strip || q.length <= strip.length || !q.startsWith(strip)) continue;
    // The words left once the prefix's own words are taken off the front.
    const all = wordsOf(text);
    let taken = "";
    let i = 0;
    while (i < all.length && taken.length < strip.length) taken += all[i++];
    out.push({ q: q.slice(strip.length), words: taken === strip ? all.slice(i) : [] });
  }
  return out;
}
const prefixesOf = (p: RankOptions["stripPrefix"]): string[] => (p === undefined ? [] : typeof p === "string" ? [p] : [...p]).map(normName).filter(Boolean);

/** A make and the everyday names that stand for it ("Chevrolet" -> Chevrolet, chevy, chevrolette), to strip from a model. */
export function makeAndAliases(make: string): string[] {
  const key = normName(make);
  return [make, ...Object.keys(MAKE_ALIASES).filter((a) => MAKE_ALIASES[a] === key)];
}

function matchOne(q: string, qWords: readonly string[], nameWords: readonly string[], key: string, aliasesTo: ReadonlyMap<string, readonly string[]>): { kind: MatchKind; dist: number } | null {
  if (!key) return null;
  if (key === q) return { kind: "exact", dist: 0 };
  const aliasKeys = aliasesTo.get(key) ?? [];
  if (aliasKeys.includes(q)) return { kind: "exact", dist: 0 };
  if (key.startsWith(q)) return { kind: "prefix", dist: 0 };
  // "rover" finds "Land Rover"; "glide" finds "Street Glide".
  if (qWords.length > 0 && nameWords.length > 1) {
    const joined = qWords.join("");
    for (let i = 1; i < nameWords.length; i++) if (nameWords.slice(i).join("").startsWith(joined)) return { kind: "word", dist: 0 };
  }
  if (q.length >= 2 && aliasKeys.some((a) => a.startsWith(q))) return { kind: "alias", dist: 0 };
  // "civic si", "silverado 1500": the text starts with the whole name.
  if (key.length >= 3 && q.startsWith(key)) return { kind: "contains", dist: 0 };
  const allowed = maxTypos(q.length);
  if (allowed > 0) {
    let best = allowed + 1;
    for (const target of [key, ...aliasKeys]) {
      best = Math.min(best, editDistance(q, target, allowed));
      // Still typing: compare with the start of the name, one character either way.
      for (const len of [q.length - 1, q.length, q.length + 1]) if (len >= 3 && len < target.length) best = Math.min(best, editDistance(q, target.slice(0, len), allowed));
    }
    if (best <= allowed) return { kind: "fuzzy", dist: best };
  }
  return null;
}

/** Does an alias send this name (normalized) to another, popular name in the list? The same rule as resolveName. */
function redirected(key: string, aliases: Readonly<Record<string, string>>, popular: ReadonlyMap<string, number>, byKey: ReadonlyMap<string, string>): boolean {
  const target = aliases[key];
  return target !== undefined && target !== key && popular.has(target) && byKey.has(target);
}

/**
 * Names that match the typed text, best first: exact (including a full alias such as "chevy"), then names that
 * start with it, then a later word that starts with it, then alias prefixes, then names the text starts with,
 * then typos (fewest first). Within each, popular names first, then shorter, then A to Z. Empty text lists every
 * name, popular first.
 */
export function rankNames(text: string, names: readonly string[], opts: RankOptions = {}): RankedName[] {
  const aliases = opts.aliases ?? {};
  const popular = new Map((opts.popular ?? []).map((k, i) => [k, i] as const));
  const aliasesTo = new Map<string, string[]>();
  for (const [alias, target] of Object.entries(aliases)) {
    const list = aliasesTo.get(target);
    if (list) list.push(alias); else aliasesTo.set(target, [alias]);
  }
  const q = normName(text);
  const queries: Array<{ q: string; words: string[] }> = [{ q, words: wordsOf(text) }, ...stripped(text, q, prefixesOf(opts.stripPrefix))];
  const idx = indexOf(names);
  const out: Scored[] = [];
  const seen = new Set<string>();
  names.forEach((name, i) => {
    const key = idx.keys[i] as string;
    if (seen.has(name)) return;
    seen.add(name);
    // A name that is itself an alias of a popular name in the list can't be picked (resolveName sends it there, as
    // leaving the field does): vPIC's rare "HARLEY" row is Harley-Davidson. It isn't offered.
    if (redirected(key, aliases, popular, idx.byKey)) return;
    const pop = popular.get(key) ?? Number.POSITIVE_INFINITY;
    if (!q) { out.push({ name, kind: "prefix", dist: 0, pop, len: name.length }); return; }
    let best: { kind: MatchKind; dist: number } | null = null;
    for (const { q: qq, words } of queries) {
      const m = matchOne(qq, words, idx.words[i] ?? [], key, aliasesTo);
      if (m && (!best || KIND_ORDER[m.kind] < KIND_ORDER[best.kind] || (m.kind === best.kind && m.dist < best.dist))) best = m;
    }
    if (best) out.push({ name, kind: best.kind, dist: best.dist, pop, len: name.length });
  });
  // Plain code-unit order for the last tie: stable across locales and much cheaper than localeCompare.
  out.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.dist - b.dist || a.pop - b.pop || a.len - b.len || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const limited = opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  return limited.map(({ name, kind }) => ({ name, kind }));
}

/**
 * The one name the text stands for exactly: the same letters and digits ("f150" = "F-150"), or a full alias
 * ("chevy" = "Chevrolet", "ram 1500" = "1500" with stripPrefix "Ram"). Null when there is none.
 * When the text is both a name and an alias of a popular name, the popular one wins: vPIC lists a make "HARLEY",
 * but "harley" means Harley-Davidson (the same tie rankNames breaks by popularity).
 */
export function resolveName(text: string, names: readonly string[], opts: Pick<RankOptions, "aliases" | "stripPrefix" | "popular"> = {}): string | null {
  const q = normName(text);
  if (!q) return null;
  const { byKey } = indexOf(names);
  const tries = [q, ...stripped(text, q, prefixesOf(opts.stripPrefix)).map((s) => s.q)];
  const popular = new Set(opts.popular ?? []);
  const viaAlias = (t: string) => {
    const target = opts.aliases?.[t];
    return target ? byKey.get(target) ?? null : null;
  };
  for (const t of tries) {
    const alias = viaAlias(t);
    if (alias && popular.has(normName(alias))) return alias;
  }
  for (const t of tries) {
    const exact = byKey.get(t);
    if (exact) return exact;
  }
  for (const t of tries) {
    const alias = viaAlias(t);
    if (alias) return alias;
  }
  return null;
}

/** Letters that NFKD doesn't take apart into a plain letter and an accent. */
const PLAIN_LETTERS: Readonly<Record<string, string>> = { ø: "o", Ø: "O", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ß: "ss", ł: "l", Ł: "L", đ: "d", Đ: "D", þ: "th", Þ: "Th" };

/**
 * A typed make (or model) with its accents taken off, for the /api vehicle lookups, whose patterns are plain ASCII:
 * "Citroën" is "Citroen", "Škoda" is "Skoda". Everything else is kept as typed. The picker still shows what was typed.
 */
export function asciiName(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[øØæÆœŒßłŁđĐþÞ]/g, (c) => PLAIN_LETTERS[c] ?? c);
}

/**
 * A make the proxy's vehicle routes take (packages/proxy params): as vPIC spells them, letters and digits first, then
 * also spaces and . & ' / - ( ) , ! ("TH!NK", "Hunter Design Group, LLC"); up to 60 characters. Plain ASCII only, so
 * a typed make goes through asciiName first.
 */
export const VPIC_MAKE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 .&'/(),!-]{0,59}$/;

/** The first model year vPIC has models for. */
export const FIRST_VPIC_YEAR = 1981;

/** Model years the picker offers, newest first: next year's models down to 1981. */
export function modelYears(now: Date = new Date()): number[] {
  const last = now.getFullYear() + 1;
  return Array.from({ length: last - FIRST_VPIC_YEAR + 1 }, (_, i) => last - i);
}

/**
 * Years that match typed digits, best first: "2019" is 2019; "19" is 2019 first, then 1981 to 1999;
 * "201" is 2010 to 2019. Empty text lists them all, newest first.
 */
export function rankYears(text: string, years: readonly number[]): number[] {
  const q = text.replace(/\D/g, "");
  if (!q) return [...years];
  const exact = q.length === 2 ? years.filter((y) => String(y).slice(2) === q && String(y).startsWith("20")) : [];
  const prefix = years.filter((y) => String(y).startsWith(q) && !exact.includes(y));
  return [...exact, ...prefix];
}
