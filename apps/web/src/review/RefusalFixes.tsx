// "We can't draw this yet" is never a dead end (DESIGN.md section 18): one plain sentence on why, up to three one-tap
// fixes the physics has checked will draw (smallest change first), and "Edit the details myself", which goes to the
// detail to change. The search runs in a Web Worker (services.fixer), so the page never freezes; it is cancelled when the
// scene changes. Kinds of fix picked before on this device come first among equally small fixes (fixer/memory.ts,
// local only, with "Clear remembered fixes"). Text only, never HTML.
//
// The Vehicles step's warnings offer the same fixes (GateFixes): the same search, buttons and remembered fixes, with
// only fixes that also leave the plain checks with nothing to say (FixOptions.gate), so tapping one clears the warning.
import { useEffect, useState } from "react";
import { whySentence, type Fix, type FixSuggestions, type PlainMessage, type RoadNetwork, type Scene } from "@csd/core";
import { isAbort } from "../fixer/client";
import { Icon } from "../icons/Icon";
import { useServices } from "../services/context";
import { useDoc } from "../state/DocProvider";
import { isAnswered, type Doc } from "../state/doc";
import { Tip } from "../tips/Tips";
import { docKey, useFlow } from "../state/Flow";
import { useUi } from "../state/Ui";

export const SEARCHING_TEXT = "Looking for the closest details that would draw…";
export const NONE_TEXT = "We couldn't find a small change that draws. Edit the details to match what happened.";
export const REMEMBERED_TEXT = "Kinds of fix you picked before on this device are listed first.";
export const CLEARED_TEXT = "Remembered fixes cleared. Nothing about them is kept on this device.";
/** The Vehicles step's words for the same search. */
export const GATE_SEARCHING_TEXT = "Looking for the closest details that fit together…";
export const GATE_NONE_TEXT = "We couldn't find a small change that makes them fit. Fix the details to match what happened.";
export const GATE_APPLIED_TEXT = "Done. The details fit together now.";
export const gateFoundText = (n: number): string => `${n === 1 ? "One small change" : `${n} small changes`} would make them fit. Pick one only if it matches what happened:`;

/** The control to focus for each detail on the Vehicles step, inside the vehicle's card. */
const FIELD_SELECTOR: Readonly<Record<string, string>> = {
  direction: '[data-fix-direction] [role="radio"][aria-checked="true"], [data-fix-direction] [role="radio"][tabindex="0"]',
  zone: '.zones [role="radio"][aria-checked="true"]',
  action: '[aria-label^="What vehicle"] [role="radio"][aria-checked="true"]',
  speed: ".stepper-input input",
};

const NO_FIXES = (): FixSuggestions => ({ why: "", fixes: [], focus: { step: "vehicles", vehicleId: null, field: null }, trials: 0 });

/**
 * The one-tap fixer's search for this scene, off the main thread, with this device's remembered kinds. A newer scene (or
 * `enabled` turning off) cancels it. `current` is null while searching (or disabled); `where` says where it ran.
 */
function useFixSearch(scene: Scene, roads: RoadNetwork | null, opts: { gate?: boolean; enabled?: boolean } = {}) {
  const { fixer, fixMemory } = useServices();
  const { doc } = useDoc();
  const gate = opts.gate === true;
  const enabled = opts.enabled !== false;
  const [found, setFound] = useState<{ scene: Scene; s: FixSuggestions; where: string } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    fixer.suggest(scene, roads, { prefer: fixMemory.load(), signal: ctl.signal, ...(gate ? { gate } : {}) }).then(
      (s) => { if (!ctl.signal.aborted) setFound({ scene, s, where: fixer.where() ?? "" }); },
      (e: unknown) => {
        if (ctl.signal.aborted || isAbort(e)) return;
        setFound({ scene, s: NO_FIXES(), where: fixer.where() ?? "" });
      },
    );
    return () => ctl.abort();
  }, [fixer, fixMemory, scene, roads, gate, enabled]);
  const s = enabled && found && found.scene === scene ? found.s : null;
  return { current: s ? { ...s, fixes: s.fixes.filter((f) => !movesAtUnaskedSpeed(f, doc)) } : null, where: found?.where || undefined };
}

/**
 * A fix that starts a vehicle moving (a parked one, whose speed was never given) without setting its speed would move it
 * at the placeholder stored with it, which the claimant never gave: not offered. They pick what it was doing and its
 * speed themselves.
 */
export function movesAtUnaskedSpeed(fix: Fix, doc: Pick<Doc, "scene" | "unanswered">): boolean {
  return fix.changes.some((c) => {
    const at = c.vehicleId ? doc.scene.vehicles.findIndex((v) => v.id === c.vehicleId) : -1;
    return at >= 0 && c.patch.action !== undefined && c.patch.action !== "parked" && c.patch.speed === undefined && !isAnswered(doc, at, "speed");
  });
}

/** The fix buttons: each one's label says the whole change. */
function FixButtons({ fixes, onApply, label = "Small changes that would draw" }: { fixes: readonly Fix[]; onApply: (fix: Fix) => void; label?: string }) {
  return (
    <ul className="refusal-fixes" aria-label={label}>
      {fixes.map((f) => (
        <li key={f.id}>
          <button type="button" className="btn btn-secondary refusal-fix" onClick={() => onApply(f)} data-fix={f.id}>{f.label}</button>
        </li>
      ))}
    </ul>
  );
}

/** "Kinds of fix you picked before…" and "Clear remembered fixes" (decision 0009), shown once something is remembered. */
function RememberedFixes({ remembered, onClear }: { remembered: boolean; onClear: () => void }) {
  const [cleared, setCleared] = useState(false);
  if (!remembered && !cleared) return null;
  return (
    <div className="refusal-memory">
      <p className="refusal-memory-note" role="status">{cleared ? CLEARED_TEXT : REMEMBERED_TEXT}</p>
      {remembered ? (
        <button type="button" className="btn btn-quiet" onClick={() => { onClear(); setCleared(true); }}>Clear remembered fixes</button>
      ) : null}
    </div>
  );
}

/** The remembered kinds, read once, and the clear action. */
function useRemembered() {
  const { fixMemory } = useServices();
  const [remembered, setRemembered] = useState(() => Object.keys(fixMemory.load()).length > 0);
  return { remembered, clear: () => { fixMemory.clear(); setRemembered(false); }, remember: (kind: string) => fixMemory.remember(kind) };
}

export function RefusalFixes({ scene, roads, errors }: { scene: Scene; roads: RoadNetwork | null; errors: readonly PlainMessage[] }) {
  const { doc, dispatch } = useDoc();
  const flow = useFlow();
  const { current, where } = useFixSearch(scene, roads);
  const memory = useRemembered();

  // The same sentence before and after the search, so it never swaps under the reader.
  const why = current?.why || whySentence(errors);

  const apply = (fix: Fix) => {
    const next = fix.scene;
    // Only the kind of change is remembered (never the scene), so similar fixes come first next time.
    memory.remember(fix.kind);
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
    <div className="review-fail warnings" data-testid="refusal" data-fixer={where}>
      <div role="alert">
        <h2 className="warnings-title"><Icon name="warning" />We can't draw this yet</h2>
        <p className="refusal-why" data-testid="refusal-why">{why}</p>
      </div>
      <p className="refusal-status" role="status">{current == null ? SEARCHING_TEXT : current.fixes.length === 0 ? NONE_TEXT : `${current.fixes.length === 1 ? "One small change" : `${current.fixes.length} small changes`} would draw. Pick one only if it matches what happened:`}</p>
      {current && current.fixes.length > 0 ? <FixButtons fixes={current.fixes} onApply={apply} /> : null}
      <div className="warnings-actions">
        <button type="button" className={current && current.fixes.length === 0 ? "btn btn-primary" : "btn btn-quiet"} onClick={editMyself}>Edit the details myself</button>
      </div>
      <RememberedFixes remembered={memory.remembered} onClear={memory.clear} />
    </div>
    </>
  );
}

/**
 * The Vehicles step's one-tap fixes, inside its warnings (DESIGN.md section 18): the same search and buttons as the
 * refusal, offering only fixes that clear the warning. Tapping one changes those details and stays on the step; the
 * warning goes away and focus moves to "See the recreation". `roads` is null while the road data is still loading
 * (`ready` false), and nothing is searched until it has arrived.
 */
export function GateFixes({ scene, roads, ready }: { scene: Scene; roads: RoadNetwork | null; ready: boolean }) {
  const { dispatch } = useDoc();
  const { showToast } = useUi();
  const { current, where } = useFixSearch(scene, roads, { gate: true, enabled: ready });
  const memory = useRemembered();

  const apply = (fix: Fix) => {
    memory.remember(fix.kind);
    dispatch({ type: "apply-fix", scene: fix.scene });
    showToast(GATE_APPLIED_TEXT);
    window.setTimeout(() => document.getElementById("to-review")?.focus({ preventScroll: true }), 0);
  };

  return (
    <div className="gate-fixes" data-testid="gate-fixes" data-fixer={where}>
      <p className="refusal-status" role="status">{current == null ? GATE_SEARCHING_TEXT : current.fixes.length === 0 ? GATE_NONE_TEXT : gateFoundText(current.fixes.length)}</p>
      {current && current.fixes.length > 0 ? <FixButtons fixes={current.fixes} onApply={apply} label="Small changes that would make them fit" /> : null}
      <RememberedFixes remembered={memory.remembered} onClear={memory.clear} />
    </div>
  );
}
