// Tolerant street-name matching: "St" vs "Street", "Ave" vs "Avenue",
// case-insensitive, punctuation-insensitive.

const SUFFIXES: Readonly<Record<string, string>> = {
  st: "street", str: "street", street: "street",
  ave: "avenue", av: "avenue", avenue: "avenue",
  rd: "road", road: "road",
  dr: "drive", drive: "drive",
  ln: "lane", lane: "lane",
  blvd: "boulevard", boulevard: "boulevard",
  ct: "court", court: "court",
  pl: "place", place: "place",
  pkwy: "parkway", pky: "parkway", parkway: "parkway",
  hwy: "highway", highway: "highway",
  tpke: "turnpike", tpk: "turnpike", turnpike: "turnpike",
  cir: "circle", circle: "circle",
  ter: "terrace", terr: "terrace", terrace: "terrace",
  sq: "square", square: "square",
  trl: "trail", trail: "trail",
  expy: "expressway", expressway: "expressway",
  fwy: "freeway", freeway: "freeway",
  way: "way", pike: "pike", loop: "loop", alley: "alley", path: "path", row: "row",
};
const SUFFIX_WORDS = new Set(Object.values(SUFFIXES));
const DIRECTIONS: Readonly<Record<string, string>> = { n: "north", s: "south", e: "east", w: "west", ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest" };
const PREFIXES: Readonly<Record<string, string>> = { mt: "mount", ft: "fort" };

/** True for a street-type word ("St", "Avenue", "Tpke"). Used to find where "near" starts in "A & B Nashua NH". */
export function isStreetSuffix(word: string): boolean {
  return Object.hasOwn(SUFFIXES, word.toLowerCase().replace(/\.$/, ""));
}

/**
 * Lowercase tokens with abbreviations expanded ("N Main St." → ["north","main","street"]).
 * Accents are stripped, apostrophes dropped and hyphens read as spaces, on both sides of every
 * comparison: "O'Brien St" = "O’Brien Street" = "OBrien Street"; "Wilkes-Barre" = "Wilkes Barre".
 */
export function nameTokens(name: string): string[] {
  const raw = name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/['’ʼ`.,]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  return raw.map((t, i) => {
    // "St" first in a multi-word name is "Saint" ("St Charles Ave"); anywhere else it's "Street".
    if (t === "st" && i === 0 && raw.length > 1) return "saint";
    const suffix = SUFFIXES[t];
    if (suffix !== undefined) return suffix;
    if (i === 0 && raw.length > 1) return DIRECTIONS[t] ?? PREFIXES[t] ?? t;
    return t;
  });
}

/** Canonical comparison key for a street name. */
export function normalizeStreetName(name: string): string {
  return nameTokens(name).join(" ");
}

/** True when the name ends in a street-type word ("main street"). */
export function hasSuffix(tokens: readonly string[]): boolean {
  const last = tokens[tokens.length - 1];
  return tokens.length > 1 && last !== undefined && SUFFIX_WORDS.has(last);
}

/** The name without its trailing suffix word ("main street" → "main"). */
function core(tokens: readonly string[]): string {
  return (hasSuffix(tokens) ? tokens.slice(0, -1) : tokens).join(" ");
}

/**
 * How well an OSM way's `name` tag matches the street the user typed: 2 = same words (after
 * abbreviation, accent and punctuation normalisation), 1 = same words but the street type is
 * missing on one side ("Main" vs "Main Street"), 0 = no match. Only `name` is compared; the
 * Overpass crossing query only fetches ways by `name`, so other tags would never be seen.
 */
export function nameMatchScore(wanted: string, tags: Readonly<Record<string, string>> | undefined): 0 | 1 | 2 {
  const name = tags?.name;
  if (name === undefined) return 0;
  const w = nameTokens(wanted);
  if (w.length === 0) return 0;
  const wantedCore = core(w);
  let best: 0 | 1 | 2 = 0;
  for (const part of name.split(";")) {
    const t = nameTokens(part);
    if (t.length === 0) continue;
    if (t.join(" ") === w.join(" ")) return 2;
    if (core(t) === wantedCore && (!hasSuffix(t) || !hasSuffix(w))) best = 1;
  }
  return best;
}

/** True when an OSM way's name matches what the user typed ("Main St" matches "Main Street"). */
export function nameMatches(wanted: string, tags: Readonly<Record<string, string>> | undefined): boolean {
  return nameMatchScore(wanted, tags) > 0;
}
