// The claim number: optional, typed on the Location step or handed over in an InsurifyAI link (?claim=<number>).
// Letters, digits and dashes only, at most 32. It is shown as text only and goes on the files (DESIGN.md section 5).
export const CLAIM_NUMBER_MAX = 32;
const CLAIM_RE = /^[A-Za-z0-9-]{1,32}$/;

/** What the field keeps of what was typed or pasted: the allowed characters, cut to the maximum length. */
export function sanitizeClaimNumber(text: string): string {
  return text.replace(/[^A-Za-z0-9-]/g, "").slice(0, CLAIM_NUMBER_MAX);
}

/** A link's ?claim= value, or null when it is missing or not a plain claim number (it is then ignored, never cleaned up). */
export function claimFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get("claim");
  return raw != null && CLAIM_RE.test(raw) ? raw : null;
}
