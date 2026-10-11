// A car maker's logo, fetched by our server and served from our own origin (/api/logos/make), or our car
// icon and the make's name when there is none. Asked only for a make the makes list knows (picked, not
// half-typed) and after typing settles, so never once per keystroke. Never shows an error.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "../icons/Icon";
import { useServices } from "../services/context";

/**
 * logo.dev's free plan requires this visible link on a commercial site wherever its logos show
 * (logo.dev/docs/platform/attribution). The same text is ProviderConfig.media.logodev.attribution.
 */
export const LOGO_DEV_CREDIT = Object.freeze({ text: "Logos provided by Logo.dev", url: "https://logo.dev" });

/** The logo.dev credit, shown once one of its logos is on the page. */
export function LogoCredit() {
  const { media } = useServices();
  const shown = useSyncExternalStore(media.logoCredit.subscribe, media.logoCredit.get, media.logoCredit.get);
  if (!shown) return null;
  return <p className="logo-credit"><a href={LOGO_DEV_CREDIT.url} target="_blank" rel="noopener noreferrer">{LOGO_DEV_CREDIT.text}</a></p>;
}

/** Wait this long after the make (or model) last changed before asking for a logo or a photo. */
export const MEDIA_SETTLE_MS = 600;

export interface MakeLogoProps {
  readonly make: string;
  /** Show the name next to the fallback icon (off where the name is already printed beside it). */
  readonly showName?: boolean;
  /** Next to the make's name already (a picker row): the logo is decoration, with an empty alt, so the name isn't read twice. */
  readonly decorative?: boolean;
}

export function MakeLogo({ make, showName = true, decorative = false }: MakeLogoProps) {
  const { media, vehicles } = useServices();
  const name = make.replace(/\s+/g, " ").trim();
  const key = name.toLowerCase();
  const [shown, setShown] = useState<{ key: string; src: string | null } | null>(null);

  useEffect(() => {
    if (!key) return;
    let off = false;
    const timer = window.setTimeout(() => {
      // Only a make the vPIC list knows, under the list's spelling ("chevy" asks for Chevrolet's logo); the list
      // is the one the picker already loaded, so this asks for nothing else.
      const known = vehicles.canonicalMake(name);
      const url = known ? media.makeLogoUrl(known) : null;
      if (!url) { setShown({ key, src: null }); return; }
      void media.objectUrl(url).then((r) => { if (!off) setShown({ key, src: r?.src ?? null }); });
    }, MEDIA_SETTLE_MS);
    return () => { off = true; window.clearTimeout(timer); };
  }, [key, name, media, vehicles]);

  if (!name) return null;
  const src = shown && shown.key === key ? shown.src : null;
  return (
    <span className="make-logo" data-make-logo={src ? "logo" : "icon"} {...(decorative ? { "aria-hidden": true } : {})}>
      {src ? <img className="make-logo-img" src={src} alt={decorative ? "" : name} /> : <Icon name="veh-car" className="icon-sm" />}
      {showName && !src ? <span className="make-logo-name">{name}</span> : null}
    </span>
  );
}
