// "We can't draw this yet" is never a dead end (DESIGN.md section 18): one plain sentence on why, up to three one-tap
// fixes the physics has checked will draw (smallest change first), and "Edit the details myself", which goes to the
// detail to change. The search runs in a Web Worker (services.fixer), so the page never freezes; it is cancelled when the
// scene changes. Kinds of fix picked before on this device come first among equally small fixes (fixer/memory.ts,
// local only, with "Clear remembered fixes"). Text only, never HTML.
import { useEffect, useState } from "react";
import { whySentence, type Fix, type FixSuggestions, type PlainMessage, type RoadNetwork, type Scene } from "@csd/core";
import { isAbort } from "../fixer/client";
import { Icon } from "../icons/Icon";
import { useServices } from "../services/context";
import { useDoc } from "../state/DocProvider";
import { Tip } from "../tips/Tips";
import { docKey, useFlow } from "../state/Flow";

export const SEARCHING_TEXT = "Looking for the closest details that would draw…";
export const NONE_TEXT = "We couldn't find a small change that draws. Edit the details to match what happened.";
export const REMEMBERED_TEXT = "Kinds of fix you picked before on this device are listed first.";
export const CLEARED_TEXT = "Remembered fixes cleared. Nothing about them is kept on this device.";

/** The control to focus for each detail on the Vehicles step, inside the vehicle's card. */
const FIELD_SELECTOR: Readonly<Record<string, string>> = {
  direction: '[data-fix-direction] [role="radio"][aria-checked="true"], [data-fix-direction] [role="radio"][tabindex="0"]',
  zone: '.zones [role="radio"][aria-checked="true"]',
  action: '[aria-label^="What vehicle"] [role="radio"][aria-checked="true"]',
  speed: ".stepper-input input",
};

export function RefusalFixes({ scene, roads, errors }: { scene: Scene; roads: RoadNetwork | null; errors: readonly PlainMessage[] }) {
  const { fixer, fixMemory } = useServices();
  const { doc, dispatch } = useDoc();
  const flow = useFlow();
  const [found, setFound] = useState<{ scene: Scene; s: FixSuggestions; where: string } | null>(null);
  const [remembered, setRemembered] = useState(() => Object.keys(fixMemory.load()).length > 0);
  const [cleared, setCleared] = useState(false);

  // The search runs off the main thread; a newer scene cancels it.
  useEffect(() => {
    const ctl = new AbortController();
    fixer.suggest(scene, roads, { prefer: fixMemory.load(), signal: ctl.signal }).then(
      (s) => { if (!ctl.signal.aborted) setFound({ scene, s, where: fixer.where() ?? "" }); },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        setFound({ scene, s: { why: "", fixes: [], focus: { step: "vehicles", vehicleId: null, field: null }, trials: 0 }, where: fixer.where() ?? "" });
      },
    );
    return () => ctl.abort();
  }, [fixer, fixMemory, scene, roads]);

  const current = found && found.scene === scene ? found.s : null;
  // The same sentence before and after the search, so it never swaps under the reader.
  const why = current?.why || whySentence(errors);

  const apply = (fix: Fix) => {
    const next = fix.scene;
    // Only the kind of change is remembered (never the scene), so similar fixes come first next time.
    fixMemory.remember(fix.kind);
    dispatch({ type: "apply-fix", scene: next });
    // Tapping a fix is the claimant accepting it: the review redraws with it, and any plain notes still show there.
    flow.goTrusted("review", docKey({ scene: next, located: doc.located }));
    window.setTimeout(() => document.getElementById("h-review")?.focus({ preventScroll: false }), 0);
  };

  const editMyself = () => {
    const focus = current?.focus ?? { step: "vehicles" as const, vehicleId: errors[0]?.vehicleIds[0] ?? null, field: null };
    flow.go(focus.step);
    if (focus.step !== "vehicles") return;
    window.setTimeout(() => {
      const card = focus.vehicleId ? document.getElementById(`vehicle-${focus.vehicleId}`) : null;
      const sel = focus.field ? FIELD_SELECTOR[focus.field] : undefined;
      const target = (sel ? card?.querySelector<HTMLElement>(sel) : null) ?? card?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      if (target) { target.scrollIntoView?.({ block: "center" }); target.focus({ preventScroll: true }); }
    }, 0);
  };

  return (
    <>
    <Tip id="review-refusal" />
    <div className="review-fail warnings" data-testid="refusal" data-fixer={found?.where || undefined}>
      <div role="alert">
        <h2 className="warnings-title"><Icon name="warning" />We can't draw this yet</h2>
        <p className="refusal-why" data-testid="refusal-why">{why}</p>
      </div>
      <p className="refusal-status" role="status">{current == null ? SEARCHING_TEXT : current.fixes.length === 0 ? NONE_TEXT : `${current.fixes.length === 1 ? "One small change" : `${current.fixes.length} small changes`} would draw. Pick one only if it matches what happened:`}</p>
      {current && current.fixes.length > 0 ? (
        <>
          <ul className="refusal-fixes" aria-label="Small changes that would draw">
            {current.fixes.map((f) => (
              <li key={f.id}>
                <button type="button" className="btn btn-secondary refusal-fix" onClick={() => apply(f)} data-fix={f.id}>{f.label}</button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="warnings-actions">
        <button type="button" className={current && current.fixes.length === 0 ? "btn btn-primary" : "btn btn-quiet"} onClick={editMyself}>Edit the details myself</button>
      </div>
      {remembered || cleared ? (
        <div className="refusal-memory">
          <p className="refusal-memory-note" role="status">{cleared ? CLEARED_TEXT : REMEMBERED_TEXT}</p>
          {remembered ? (
            <button type="button" className="btn btn-quiet" onClick={() => { fixMemory.clear(); setRemembered(false); setCleared(true); }}>Clear remembered fixes</button>
          ) : null}
        </div>
      ) : null}
    </div>
    </>
  );
}
