// US states: full name -> two-letter code, for "Town, ST" labels and for reading the state out of typed text.
const STATES: Readonly<Record<string, string>> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};

const CODES = new Set(Object.values(STATES));

/** "New Hampshire" -> "NH"; anything unknown comes back as given. */
export function stateAbbreviation(state: string): string {
  return STATES[state.trim().toLowerCase()] ?? state.trim();
}

/** Is this text exactly a US state, by name or two-letter code ("NH", "new hampshire")? */
export function isStateText(text: string): boolean {
  const t = text.trim();
  return CODES.has(t.toUpperCase()) || STATES[t.toLowerCase()] !== undefined;
}

/**
 * The US state at the end of typed place text, as its two-letter code: "Nashua, NH" -> "NH",
 * "Manchester NH 03101" -> "NH", "Concord, New Hampshire" -> "NH". Null when the text doesn't end with one.
 */
export function stateOfText(text: string): string | null {
  const t = text.replace(/\b\d{5}(-\d{4})?\s*$/, "").replace(/[.,\s]+$/, "").trim();
  const code = /(?:^|[\s,])([A-Za-z]{2})$/.exec(t)?.[1]?.toUpperCase();
  if (code && CODES.has(code)) return code;
  const lower = t.toLowerCase();
  for (const [name, abbr] of Object.entries(STATES)) if (lower === name || lower.endsWith(` ${name}`) || lower.endsWith(`,${name}`)) return abbr;
  return null;
}
