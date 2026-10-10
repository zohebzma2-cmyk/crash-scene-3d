// The InsurifyAI logo: the official mark (an image file from our own origin, never inline
// SVG) and the wordmark as live text. "Insurify" follows the text color; "AI" and the mark
// are the logo blue in both themes (--color-logo). Proportions: DESIGN.md section 13.
import type { MouseEvent, ReactElement } from "react";

/** The tight-cropped official mark, copied to public/ by scripts/build-brand.mjs. */
export const MARK_SRC = `${import.meta.env.BASE_URL}insurifyai-mark.svg`;

/** The logo as a link. Its accessible name is "InsurifyAI"; the mark image has an empty alt. */
export function Brand({ href, onClick }: { href: string; onClick?: (e: MouseEvent<HTMLAnchorElement>) => void }): ReactElement {
  return (
    <a className="logo" href={href} aria-label="InsurifyAI" onClick={onClick}>
      <img className="logo-mark" src={MARK_SRC} alt="" />
      <span className="logo-word">Insurify<span>AI</span></span>
    </a>
  );
}
