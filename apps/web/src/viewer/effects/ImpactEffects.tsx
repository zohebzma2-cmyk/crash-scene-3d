// The React side of the impact effects: mounts the debris/skid/flash group, drives it from the timeline
// time, shakes the camera for ~150 ms when playback crosses the impact, and hands the viewer's export
// capture a `prepare(t, view)` that puts everything where it is at the still's time.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { BufferGeometry, Group } from "three";
import { canonicalJson, type RoadNetwork, type Scene, type SimulationResult, type Vec2 } from "@csd/core";
import type { CameraView } from "../types";
import type { SceneColors } from "../tokens";
import { ImpactFx } from "./controller";
import { hashString } from "./debris";
import { getImpactInfo } from "./impact-info";
import { applyDentProgress, dentProgress, morphParts, planDents, type DentSpec } from "./damage";
import { SHAKE_MS, shakeOffset } from "./shake";

export interface EffectsApi {
  /** Place the effects at sim time t for an offscreen draw; the returned function puts them back. */
  prepare(t: number, view: CameraView): () => void;
  /** Debris and slide-mark end points, for framing the Aftermath view. */
  extraPoints(): Vec2[];
}

export interface ImpactEffectsProps {
  readonly scene: Scene;
  readonly sim: SimulationResult;
  readonly roads: RoadNetwork | null;
  readonly colors: SceneColors;
  readonly timeS: number;
  readonly reducedMotion: boolean;
  /** Filled with the effects' API while mounted. */
  readonly apiRef: MutableRefObject<EffectsApi | null>;
  /** The viewer's vehicle groups by id (the ones VehicleMesh registers): the dent is animated on them. */
  readonly groups: RefObject<ReadonlyMap<string, Group>>;
  /** The viewer's measurement group: made visible for the Aftermath still even when measurements are off. */
  readonly measureRef?: RefObject<Group | null>;
}

/** The scene's seed: a hash of its canonical JSON, so the same scene always throws the same debris. */
export function sceneSeed(scene: Scene): number { return hashString(canonicalJson(scene)); }

export function ImpactEffects({ scene, sim, roads, colors, timeS, reducedMotion, apiRef, measureRef, groups }: ImpactEffectsProps) {
  const seed = useMemo(() => sceneSeed(scene), [scene]);
  const fx = useMemo(() => {
    const braking = new Set(scene.vehicles.filter((v) => v.braking && v.action !== "parked").map((v) => v.id));
    const strengthMps = sim.vehicles.reduce((n, v) => n + getImpactInfo(sim, v, scene).deltaVMps, 0);
    return new ImpactFx({ sim, roads, colors, seed, braking, strengthMps });
  }, [sim, roads, colors, scene, seed]);
  useEffect(() => () => fx.dispose(), [fx]);

  const live = useRef({ t: timeS, reduced: reducedMotion });
  const dentIds = useMemo(() => [...planDents(sim, scene).keys()], [sim, scene]);
  const setDents = useCallback((t: number, reduced: boolean) => {
    const k = dentProgress(t, reduced);
    for (const id of dentIds) { const g = groups.current.get(id); if (g) applyDentProgress(g, k); }
  }, [dentIds, groups]);
  useLayoutEffect(() => {
    live.current = { t: timeS, reduced: reducedMotion };
    fx.setTime(timeS, reducedMotion);
    setDents(timeS, reducedMotion);
  }, [fx, timeS, reducedMotion, setDents]);
  // New meshes can appear after a render (a model swap); the dent follows them on the next frame.
  useFrame(() => setDents(live.current.t, live.current.reduced));

  useEffect(() => {
    apiRef.current = {
      extraPoints: () => fx.extraPoints(),
      prepare: (t, view) => {
        fx.setTime(t, false);
        setDents(t, false);
        const mg = measureRef?.current;
        const was = mg?.visible;
        if (mg && view === "aftermath") mg.visible = true;
        return () => {
          fx.setTime(live.current.t, live.current.reduced);
          setDents(live.current.t, live.current.reduced);
          if (mg && was !== undefined) mg.visible = was;
        };
      },
    };
    return () => { apiRef.current = null; };
  }, [fx, apiRef, measureRef, setDents]);

  return (
    <>
      <primitive object={fx.group} />
      <ImpactShake timeS={timeS} reducedMotion={reducedMotion} seed={seed} />
    </>
  );
}

/** A short, small, damped camera shake when playback crosses the impact. Uses the camera's view offset, so it never fights the orbit controls. */
function ImpactShake({ timeS, reducedMotion, seed }: { timeS: number; reducedMotion: boolean; seed: number }) {
  const { camera, size } = useThree();
  const prev = useRef(timeS);
  const startMs = useRef(-1);
  const off = useMemo(() => ({ x: 0, y: 0 }), []);
  const active = useRef(false);
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = timeS;
    // Playback reaching the impact (small steps), not a jump of the scrubber.
    if (!reducedMotion && was < 0 && timeS >= 0 && timeS - was < 0.06) startMs.current = performance.now();
  }, [timeS, reducedMotion]);
  useFrame(() => {
    const cam = camera as typeof camera & { setViewOffset?: (...a: number[]) => void; clearViewOffset?: () => void };
    if (!cam.setViewOffset || !cam.clearViewOffset) return;
    const e = startMs.current < 0 || reducedMotion ? -1 : performance.now() - startMs.current;
    if (e >= 0 && e < SHAKE_MS) {
      shakeOffset(e, seed, off);
      cam.setViewOffset(size.width, size.height, off.x, off.y, size.width, size.height);
      active.current = true;
    } else if (active.current) {
      cam.clearViewOffset();
      active.current = false;
      startMs.current = -1;
    }
  });
  return null;
}

/** What VehicleMesh calls with a model's parts to get the dented ones. */
export type DamageFn = <P extends { readonly [K in keyof P]: BufferGeometry }>(parts: P) => P;

/**
 * The per-vehicle `damage` callbacks for VehicleMesh: one STABLE callback per dented vehicle (none for a
 * vehicle that took no hit). It returns CLONES of the model's parts carrying the dent as a morph target;
 * ImpactEffects drives the morph from the timeline time, so the vehicle is intact before the impact and
 * dented from t = 0, at any time, without the geometry changing.
 */
export function useDamage(scene: Scene, sim: SimulationResult): ReadonlyMap<string, DamageFn> {
  return useMemo(() => {
    const m = new Map<string, DamageFn>();
    for (const [id, specs] of planDents(sim, scene)) {
      const frozen: readonly DentSpec[] = specs;
      m.set(id, (parts) => morphParts(parts, frozen));
    }
    return m;
  }, [scene, sim]);
}
