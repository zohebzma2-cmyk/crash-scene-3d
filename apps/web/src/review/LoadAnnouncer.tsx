// One live region for the Review picture's loading, mounted once by the app (it outlives the skeleton, the
// Review body and the 3D view swapping in and out), so a screen reader hears each change of stage once and
// "The scene is ready." at the end. ViewerStatus writes to it; the visible status box is not a live region.
import { useSyncExternalStore } from "react";

let text = "";
const listeners = new Set<() => void>();

/** Sets what the live region says (the same text again is not announced again). */
export function announceLoad(next: string): void {
  if (next === text) return;
  text = next;
  for (const l of listeners) l();
}

/** What the live region says now. */
export const loadAnnouncement = (): string => text;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => text;

/** `active`: Review (or an example opening on it) is on screen; elsewhere the region stays empty. */
export function LoadAnnouncer({ active }: { active: boolean }) {
  const now = useSyncExternalStore(subscribe, snapshot, snapshot);
  return <p className="visually-hidden" role="status" aria-live="polite" data-testid="load-announcer">{active ? now : ""}</p>;
}
