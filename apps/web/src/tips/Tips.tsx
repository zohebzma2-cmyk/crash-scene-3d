// The tip card and the "Show tips" button. Tips sit in the page flow (never over the map, the
// timeline, the form or the action bar), are a labelled note (not a dialog, no live region), and
// never take focus by themselves. Focus moves only after the person's own Hide or Show press.
// "Show tips" lives in the header (it takes no room in the page) and appears only when this step's tip is hidden.
import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons/Icon";
import { tipById, tipsForStep, type TipDef } from "./content";
import { useTips } from "./TipsProvider";
import { useFlow, type StepKey } from "../state/Flow";

export const SHOW_TIPS_LABEL = "Show tips";
export const HIDE_ALL_LABEL = "Hide all tips";
export const hideTipLabel = (tip: TipDef): string => `Hide tip: ${tip.title}`;

/** The header's "Show tips": there only while this step has a hidden tip, so a screen never carries a dead button. */
export function ShowTipsButton() {
  const { step } = useFlow();
  const { isVisible, showAll, slots, focusCardRef } = useTips();
  // Only where a tip slot is on screen, so it is never a button that does nothing.
  if (!slots.has(step) || tipsForStep(step).every((t) => isVisible(t.id))) return null;
  return (
    <button type="button" className="btn btn-quiet btn-sm tips-btn" id={SHOW_TIPS_ID} onClick={() => { focusCardRef.current = true; showAll(); }}>
      <Icon name="info" className="icon-sm" /><span className="tips-btn-text">{SHOW_TIPS_LABEL}</span>
    </button>
  );
}
export const SHOW_TIPS_ID = "show-tips";

function TipSlot({ tips, step }: { tips: readonly TipDef[]; step?: StepKey }) {
  const { isVisible, hide, hideAll, registerSlot, focusCardRef } = useTips();
  const shown = tips.filter((t) => isVisible(t.id));
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => (step ? registerSlot(step) : undefined), [step, registerSlot]);
  const [hid, setHid] = useState(false);
  useEffect(() => {
    // Focus moves only after the person's own press: to Show tips after Hide (the pressed button is gone), to the tip after Show tips.
    if (hid) { document.getElementById(SHOW_TIPS_ID)?.focus({ preventScroll: true }); setHid(false); } // eslint-disable-line react-hooks/set-state-in-effect
    else if (focusCardRef.current && shown.length > 0) { cardRef.current?.focus({ preventScroll: true }); focusCardRef.current = false; }
  }, [hid, shown.length, focusCardRef]);
  if (tips.length === 0) return null;
  return (
    <div className={`tips-slot${shown.length === 0 ? " is-empty" : ""}`} data-testid="tips" data-step={step}>
      {shown.map((t, i) => (
        <div key={t.id} className="tip" role="note" aria-label={`Tip: ${t.title}`} tabIndex={-1} ref={i === 0 ? cardRef : undefined}>
          <p className="tip-title"><Icon name="info" className="icon-sm" /><span>{t.title}</span></p>
          <p className="tip-text">{t.text}</p>
          <div className="tip-actions">
            <button type="button" className="link-btn" onClick={() => { setHid(true); hideAll(); }}>{HIDE_ALL_LABEL}</button>
            <button type="button" className="icon-btn" aria-label={hideTipLabel(t)} onClick={() => { setHid(true); hide(t.id); }}><Icon name="close" className="icon-sm" /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The tips of one step (the ones not marked onDemand). */
export function Tips({ step }: { step: StepKey }) {
  return <TipSlot tips={tipsForStep(step)} step={step} />;
}

/** One named tip, for a screen that decides itself when to show it (see content.ts). */
export function Tip({ id }: { id: string }) {
  const tip = tipById(id);
  return tip ? <TipSlot tips={[tip]} /> : null;
}
