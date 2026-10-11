// The four steps and the gate in front of Review and Save. Going to either one runs parseScene and
// checkScene. Problems are shown as plain warnings with "Fix the details" and "See it anyway";
// nothing is skipped silently. Details that can't be drawn at all (parseScene errors, no pin yet)
// have no "See it anyway".
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { canonicalJson, parseScene, type PlainMessage, type Scene, type VehicleId } from "@csd/core";
import { useServices } from "../services/context";
import type { Doc } from "./doc";
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

export interface GateProblem {
  readonly text: string;
  /** The step where it can be fixed. */
  readonly step: "location" | "vehicles";
  /** True when the picture can't be made until it's fixed. */
  readonly blocking: boolean;
  readonly vehicleIds: readonly VehicleId[];
  /** Where to put focus when fixing it. */
  readonly focus?: "direction";
}

export const NOT_LOCATED_TEXT = "Tell us where it happened first: search for the place, or tap the map to drop the pin.";
export const CHECK_FAILED_TEXT = "We couldn't check whether the details fit together, so we can't promise they do.";

export function runGate(
  scene: Scene,
  located: boolean,
  directionSet: readonly boolean[],
  check: (scene: Scene) => readonly PlainMessage[],
  /** Typed values that aren't usable yet (the speed field): they block until fixed. */
  fieldErrors: readonly FieldError[] = [],
): GateProblem[] {
  const out: GateProblem[] = [];
  if (!located) out.push({ text: NOT_LOCATED_TEXT, step: "location", blocking: true, vehicleIds: [] });
  scene.vehicles.forEach((v, i) => {
    if (directionSet[i] !== true) out.push({ text: `Pick which way ${v.id === "A" ? "your car (A)" : `vehicle ${v.id}`} was ${v.action === "parked" || v.action === "backing" ? "facing" : "going"}.`, step: "vehicles", blocking: true, vehicleIds: [v.id], focus: "direction" });
  });
  for (const e of fieldErrors) out.push({ text: `Vehicle ${e.vehicleId}: ${e.text}`, step: "vehicles", blocking: true, vehicleIds: [e.vehicleId as VehicleId] });
  const parsed = parseScene(scene);
  if (!parsed.ok) {
    for (const text of parsed.errors) out.push({ text, step: /^Vehicle [A-D]:/.test(text) ? "vehicles" : "location", blocking: true, vehicleIds: [] });
    return out;
  }
  // Checks that compare directions mean nothing until every direction is the claimant's own pick.
  if (directionSet.some((x) => x !== true)) return out;
  try {
    for (const m of check(parsed.value)) out.push({ text: m.text, step: "vehicles", blocking: false, vehicleIds: m.vehicleIds });
  } catch {
    out.push({ text: CHECK_FAILED_TEXT, step: "vehicles", blocking: false, vehicleIds: [] });
  }
  return out;
}

/** What identifies the details the claimant has accepted warnings for. */
/** Road ids are left out: filling one in after the roads load must not undo "See it anyway". */
export const docKey = (doc: Pick<Doc, "scene" | "located">): string =>
  `${doc.located ? "1" : "0"}${canonicalJson({ ...doc.scene, vehicles: doc.scene.vehicles.map((v) => ({ ...v, travel: { ...v.travel, roadId: null } })) })}`;

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
    () => runGate(doc.scene, doc.located, doc.directionSet, (s) => services.physics.checkScene(s, roadNet), Object.values(fieldErrors)),
    [doc.scene, doc.located, doc.directionSet, services, roadNet, fieldErrors],
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
    // The shown title only: while a step's code loads, the last step's title may still be in the page, hidden.
    // (React hides suspended content with an inline display: none.)
    const hidden = (el: HTMLElement | null): boolean => { for (let e = el; e; e = e.parentElement) if (e.hidden || e.style.display === "none") return true; return false; };
    const shownTitle = () => [...document.querySelectorAll<HTMLElement>("main h1")].find((h) => !hidden(h)) ?? null;
    const focusTitle = (h1: HTMLElement) => { h1.setAttribute("tabindex", "-1"); h1.focus({ preventScroll: true }); };
    const now = shownTitle();
    if (now) { focusTitle(now); return; }
    // A step whose code is still loading has no title yet: focus it as soon as it appears (bounded).
    const main = document.querySelector("main");
    if (!main || typeof MutationObserver !== "function") return;
    const mo = new MutationObserver(() => {
      const h1 = shownTitle();
      if (h1) { mo.disconnect(); window.clearTimeout(stop); focusTitle(h1); }
    });
    const stop = window.setTimeout(() => mo.disconnect(), TITLE_WAIT_MS);
    mo.observe(main, { childList: true, subtree: true });
    return () => { mo.disconnect(); window.clearTimeout(stop); };
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
      const target = (p.focus === "direction" ? card?.querySelector<HTMLElement>('[data-fix-direction] [role="radio"][tabindex="0"]') : null) ?? card?.querySelector<HTMLElement>('[data-fix-target] [role="radio"][aria-checked="true"]') ?? card?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
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
