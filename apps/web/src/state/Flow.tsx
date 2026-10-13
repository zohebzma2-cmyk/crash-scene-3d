// The four steps and the gate in front of Review and Save. Going to either one runs parseScene,
// the road check (a direction that follows no road at the pin) and checkScene. Problems are shown as plain
// warnings with "Fix the details" and "See it anyway"; nothing is skipped silently. Details that can't be
// drawn at all (parseScene errors, no pin yet, a direction off the roads) have no "See it anyway"; an opened
// file or example whose direction is off the roads lands on the Vehicles step with its one-tap fixes.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { canonicalJson, parseScene, type PlainMessage, type Scene, type SceneVehicle, type VehicleId } from "@csd/core";
import { useServices } from "../services/context";
import { focusStepTitle } from "../lib/focusTitle";
import type { AnswerField, Doc } from "./doc";
import { useDoc } from "./DocProvider";
import { useRoads } from "./Roads";
import { useUi, type FieldError } from "./Ui";

export const STEPS = [
  { key: "location", name: "Location" },
  { key: "vehicles", name: "Vehicles" },
  { key: "review", name: "Review" },
  { key: "export", name: "Save" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];
export const stepIndex = (k: StepKey): number => STEPS.findIndex((s) => s.key === k);
const isStep = (s: string): s is StepKey => STEPS.some((x) => x.key === s);
/** How long a step change waits for a lazily loaded step's title to appear, to focus it. */
const TITLE_WAIT_MS = 10_000;

/**
 * What kind of problem it is, so the warning reads right: a detail not given yet ("missing": no pin, a direction not
 * picked, an empty speed), a value that can't be used as typed ("unusable"), or details that don't fit together
 * ("conflict": the plain checks). Only conflicts can be accepted with "See it anyway".
 */
export type GateProblemKind = "missing" | "unusable" | "conflict";

export interface GateProblem {
  readonly kind: GateProblemKind;
  readonly text: string;
  /** The step where it can be fixed. */
  readonly step: "location" | "vehicles";
  /** True when the picture can't be made until it's fixed. */
  readonly blocking: boolean;
  readonly vehicleIds: readonly VehicleId[];
  /** Where to put focus when fixing it: the control on the vehicle's card. */
  readonly focus?: FixFocus;
}

/** The controls on a vehicle card "Fix the details" can put focus on. */
export type FixFocus = AnswerField | "direction";
/** Where each one is on the card: its group's tab stop (with nothing picked, the first choice; the speed: its field). */
const FIX_FOCUS: Record<FixFocus, string> = {
  type: '[data-fix-type] [role="radio"][tabindex="0"]',
  action: '[data-fix-action] [role="radio"][tabindex="0"]',
  direction: '[data-fix-direction] [role="radio"][tabindex="0"]',
  speed: "[data-fix-speed] input",
  zone: '[data-fix-zone] [role="radio"][tabindex="0"]',
};

export const NOT_LOCATED_TEXT = "Tell us where it happened first: search for the place, or tap the map to drop the pin.";
export const CHECK_FAILED_TEXT = "We couldn't check whether the details fit together, so we can't promise they do.";

export function runGate(
  scene: Scene,
  located: boolean,
  directionSet: readonly boolean[],
  check: (scene: Scene) => readonly PlainMessage[],
  /** Typed values that aren't usable yet (the speed field): they block until fixed. */
  fieldErrors: readonly FieldError[] = [],
  /**
   * Directions that don't fit the roads at the pin (core roadFitProblems): the picture would have to leave the roads, so they
   * block like a missing detail, but they are details that don't fit together and get the one-tap fixes.
   */
  roadFit: (scene: Scene) => readonly PlainMessage[] = () => [],
  /** Per vehicle, the details not answered yet (Doc.unanswered; absent = all answered). */
  unanswered: Doc["unanswered"] = undefined,
): GateProblem[] {
  const out: GateProblem[] = [];
  if (!located) out.push({ kind: "missing", text: NOT_LOCATED_TEXT, step: "location", blocking: true, vehicleIds: [] });
  // In the card's order: type, what it was doing, direction, speed (not for a parked vehicle), where it was hit.
  let anyMissing = false;
  scene.vehicles.forEach((v, i) => {
    const open = (unanswered?.[i] ?? []).filter((f) => f !== "speed" || v.action !== "parked");
    const missing = (focus: FixFocus, text: string) => { anyMissing = true; out.push({ kind: "missing", text, step: "vehicles", blocking: true, vehicleIds: [v.id], focus }); };
    for (const f of ["type", "action"] as const) if (open.includes(f)) missing(f, answerText(v, f));
    if (directionSet[i] !== true) missing("direction", pickDirectionText(v));
    for (const f of ["speed", "zone"] as const) if (open.includes(f)) missing(f, answerText(v, f));
  });
  // The only typed field is the speed, so "Fix the details" goes to it.
  for (const e of fieldErrors) out.push({ kind: e.missing ? "missing" : "unusable", text: `Vehicle ${e.vehicleId}: ${e.text}`, step: "vehicles", blocking: true, vehicleIds: [e.vehicleId as VehicleId], focus: "speed" });
  const parsed = parseScene(scene);
  if (!parsed.ok) {
    for (const text of parsed.errors) out.push({ kind: "unusable", text, step: /^Vehicle [A-D]:/.test(text) ? "vehicles" : "location", blocking: true, vehicleIds: [] });
    return out;
  }
  // Checks that compare directions, speeds and hit sides mean nothing until every one is the claimant's own answer.
  if (anyMissing) return out;
  try {
    for (const m of roadFit(parsed.value)) out.push({ kind: "conflict", text: m.text, step: "vehicles", blocking: true, vehicleIds: m.vehicleIds, focus: "direction" });
  } catch {
    // A failed road check is not a reason to block: the Review step's own physics still refuses what it can't draw.
  }
  try {
    for (const m of check(parsed.value)) out.push({ kind: "conflict", text: m.text, step: "vehicles", blocking: false, vehicleIds: m.vehicleIds });
  } catch {
    out.push({ kind: "conflict", text: CHECK_FAILED_TEXT, step: "vehicles", blocking: false, vehicleIds: [] });
  }
  return out;
}

const who = (v: Pick<SceneVehicle, "id">): string => (v.id === "A" ? "your car" : `vehicle ${v.id}`);

/** The missing-detail line for an unanswered type, action, speed or hit side ("vehicle B" for the others). */
export function answerText(v: Pick<SceneVehicle, "id" | "action">, field: AnswerField): string {
  switch (field) {
    case "type": return `Pick the type of ${who(v)}, or enter its year, make and model.`;
    case "action": return `Pick what ${who(v)} was doing.`;
    case "speed": return `Enter ${v.id === "A" ? "your car's" : `vehicle ${v.id}'s`} speed, or choose Not sure.`;
    case "zone": return `Pick where ${who(v)} was hit.`;
  }
}

/** "Pick which way your car was going." / "Pick which way vehicle B was facing." (parked or backing: the way it faced). */
export function pickDirectionText(v: Pick<SceneVehicle, "id" | "action">): string {
  return `Pick which way ${who(v)} was ${v.action === "parked" || v.action === "backing" ? "facing" : "going"}.`;
}

/** What identifies the details the claimant has accepted warnings for. */
/** Road ids and unnamed roads' words are left out: filling them in after the roads load must not undo "See it anyway". */
/** The claim (number, and its vehicle, which mirrors A) is left out too: it never changes what the picture can draw. */
export const docKey = (doc: Pick<Doc, "scene" | "located">): string =>
  `${doc.located ? "1" : "0"}${canonicalJson({ ...doc.scene, claim: null, vehicles: doc.scene.vehicles.map((v) => ({ ...v, travel: { ...v.travel, roadId: null, roadDesc: undefined } })) })}`;

interface FlowValue {
  readonly step: StepKey;
  readonly problems: readonly GateProblem[];
  readonly blocking: boolean;
  /** Warnings are showing (and stay live while the details change). */
  readonly armed: boolean;
  /** Go to a step; Review and Save run the gate first. */
  readonly go: (target: StepKey) => void;
  readonly acceptAnyway: () => void;
  readonly fix: () => void;
  /** Go to a step for a scene we trust as it is (a saved scene file, the bundled examples): skips the gate. */
  readonly goTrusted: (target: StepKey, key: string) => void;
}
const Ctx = createContext<FlowValue | null>(null);

function readHash(): StepKey {
  const h = window.location.hash.slice(1);
  return isStep(h) ? h : "location";
}
function writeHash(step: StepKey, replace = false) {
  const url = `${window.location.pathname}${window.location.search}#${step}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function FlowProvider({ children }: { children: ReactNode }) {
  const { doc } = useDoc();
  const services = useServices();
  const roads = useRoads();
  const { hideToast, fieldErrors } = useUi();
  const [hashStep, setHashStep] = useState<StepKey>(readHash);
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState<StepKey | null>(null);
  const [accepted, setAccepted] = useState<string | null>(null);

  useEffect(() => {
    const on = () => setHashStep(readHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  const roadNet = roads.net;
  const problems = useMemo(
    () => runGate(doc.scene, doc.located, doc.directionSet, (s) => services.physics.checkScene(s, roadNet), Object.values(fieldErrors), (s) => services.physics.roadFitProblems(s, roadNet), doc.unanswered),
    [doc.scene, doc.located, doc.directionSet, doc.unanswered, services, roadNet, fieldErrors],
  );
  const blocking = problems.some((p) => p.blocking);
  const key = docKey(doc);
  const passes = problems.length === 0 || (!blocking && accepted === key);

  // The step shown. Review and Save are only reachable once the gate has passed.
  const guarded = stepIndex(hashStep) >= 2 && !passes;
  const first = problems.find((p) => p.blocking) ?? problems[0];
  const step: StepKey = guarded ? (first?.step ?? "vehicles") : hashStep;

  // The URL is an outside system: when it asks for Review or Save too early, show the warnings and move back.
  useEffect(() => {
    if (!guarded) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setArmed(true);
    setPending(hashStep);
    writeHash(step, true);
  }, [guarded, hashStep, step]);

  // Reaching Review or Save with the details passing (also by the address bar) counts as accepted for the same reason.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stepIndex(hashStep) >= 2 && passes && accepted !== key) setAccepted(key);
  }, [hashStep, passes, accepted, key]);

  // Back never loses work, and the screen's own title takes focus on every move (but not on first load).
  const firstRender = useRef(true);
  useEffect(() => {
    hideToast();
    window.scrollTo?.(0, 0);
    if (firstRender.current) { firstRender.current = false; return; }
    // The new title takes focus, even if the step's code is still loading (see lib/focusTitle).
    return focusStepTitle(document, TITLE_WAIT_MS);
  }, [step, hideToast]);

  const go = useCallback((target: StepKey) => {
    if (stepIndex(target) >= 2 && !passes) {
      setArmed(true);
      setPending(target);
      return;
    }
    // The details passed: remember it, so a warning that turns up later (the roads arriving) never moves the claimant.
    if (stepIndex(target) >= 2) setAccepted(key);
    setArmed(false);
    setPending(null);
    writeHash(target);
  }, [passes, key]);

  const acceptAnyway = useCallback(() => {
    if (blocking) return;
    setAccepted(key);
    setArmed(false);
    const target = pending ?? "review";
    setPending(null);
    writeHash(target);
  }, [blocking, key, pending]);

  const fix = useCallback(() => {
    const p = problems.find((x) => x.blocking) ?? problems[0];
    if (!p) return;
    writeHash(p.step);
    window.setTimeout(() => {
      const id = p.vehicleIds[0];
      const card = id ? document.getElementById(`vehicle-${id}`) : null;
      const target = (p.focus ? card?.querySelector<HTMLElement>(FIX_FOCUS[p.focus]) : null) ?? card?.querySelector<HTMLElement>('[data-fix-target] [role="radio"][aria-checked="true"]') ?? card?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      if (target) { target.scrollIntoView?.({ block: "center" }); target.focus({ preventScroll: true }); }
    }, 0);
  }, [problems]);

  const goTrusted = useCallback((target: StepKey, trustedKey: string) => {
    setAccepted(trustedKey);
    setArmed(false);
    setPending(null);
    writeHash(target);
  }, []);

  const value = useMemo<FlowValue>(
    () => ({ step, problems, blocking, armed, go, acceptAnyway, fix, goTrusted }),
    [step, problems, blocking, armed, go, acceptAnyway, fix, goTrusted],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFlow(): FlowValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("FlowProvider is missing.");
  return v;
}
