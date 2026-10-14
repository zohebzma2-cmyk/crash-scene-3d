// The vehicles in the scene: solid models at the current time, and the dashed rest-pose outlines.
// Geometry comes from vehicle-models (cached); materials are bound to tokens and disposed on unmount.
import { useEffect, useLayoutEffect, useMemo } from "react";
import { Line } from "@react-three/drei";
import { MeshStandardMaterial, type Color, type Group, type Material } from "three";
import { vehicleColor, type Paintable, type Pose, type RoadNetwork, type VehicleResult } from "@csd/core";
import { headingToYaw, heightAt, toThree } from "./math";
import { vehicleToken, type SceneColors, type SceneToken } from "./tokens";
import { applyTint, type TintPlan } from "./glb-model";
import { vehicleModel, type VehicleParts } from "./vehicle-models";
import { LIFT } from "./scene-geometry";
import type { Crumpled } from "./effects/crumple";

/** The materials every vehicle shares, plus one body and one ghost material per vehicle color. */
export class VehicleMaterials {
  readonly glass: MeshStandardMaterial;
  readonly tire: MeshStandardMaterial;
  readonly headlight: MeshStandardMaterial;
  readonly taillight: MeshStandardMaterial;
  private readonly body = new Map<string, MeshStandardMaterial>();

  constructor(private readonly colors: SceneColors) {
    this.glass = new MeshStandardMaterial({ color: colors["--color-scene-glass"], roughness: 0.2, metalness: 0.3 });
    this.tire = new MeshStandardMaterial({ color: colors["--color-scene-tire"], roughness: 0.9 });
    this.headlight = new MeshStandardMaterial({ color: colors["--color-scene-headlight"], emissive: colors["--color-scene-headlight"], emissiveIntensity: 0.5, roughness: 0.3 });
    this.taillight = new MeshStandardMaterial({ color: colors["--color-scene-taillight"], emissive: colors["--color-scene-taillight"], emissiveIntensity: 0.5, roughness: 0.3 });
  }

  /** The body material of vehicle `id` (created once; its colour is set by `paintBody`, after the commit). */
  bodyFor(id: string): MeshStandardMaterial {
    let m = this.body.get(id);
    if (!m) { m = new MeshStandardMaterial({ color: this.colors[vehicleToken(id)], roughness: 0.45, metalness: 0.15 }); this.body.set(id, m); }
    return m;
  }

  /** The colour key `vehicleColor(v)` gives: a token name for "Not sure", or the picked "#rrggbb". */
  static fillOf(v: Paintable): string {
    return vehicleColor(v, vehicleToken);
  }

  /** Set a body material to `fill` (a token name or a hex): only when it changes, never per frame. */
  paintBody(m: MeshStandardMaterial, fill: string): void {
    if (m.userData.fill === fill) return;
    if (fill.startsWith("--")) m.color.copy(this.colors[fill as SceneToken]);
    else m.color.set(fill);                          // sRGB hex to the working colour space
    m.userData.fill = fill;
  }

  dispose(): void {
    const all: Material[] = [this.glass, this.tire, this.headlight, this.taillight, ...this.body.values()];
    all.forEach((m) => m.dispose());
    this.body.clear();
  }
}

/** Materials bound to the current token colors; disposed when the colors change or the viewer unmounts. */
export function useVehicleMaterials(colors: SceneColors): VehicleMaterials {
  const mats = useMemo(() => new VehicleMaterials(colors), [colors]);
  useEffect(() => () => mats.dispose(), [mats]);
  return mats;
}

/** A catalog model fitted to this vehicle's footprint (glb-model.ts), with how to tint it. */
export interface CatalogModel {
  readonly object: Group;
  readonly plan: TintPlan;
  readonly watermarked: boolean;
}

export interface VehicleMeshProps {
  readonly v: VehicleResult;
  /** The scene's vehicle (its paint); absent = the token colour. */
  readonly paint?: Paintable;
  /** The catalog model, once loaded: drawn instead of the low-poly parts, in the same posed group (no flash, same pose). */
  readonly catalog?: CatalogModel | null;
  readonly pose: Pose;
  readonly mats: VehicleMaterials;
  readonly terrain: RoadNetwork["terrain"] | null;
  /** Lets the viewer find the group (to place it at another time for a still). */
  readonly register?: (id: string, group: Group | null) => void;
  /**
   * Optional damage (dents): called once per model, returns the parts to draw. It must return CLONED
   * geometry for any part it changes; the clones are disposed here when they are replaced or unmounted.
   */
  readonly damage?: (parts: VehicleParts) => VehicleParts;
  /**
   * Optional crumple for the catalog model (effects/crumple.ts): called once per catalog model, returns a copy of it to
   * draw (sharing its materials; its geometry copies are freed here) or null to draw the model as it is.
   */
  readonly crumple?: (model: Group) => Crumpled | null;
}

export function VehicleMesh({ v, paint, catalog, pose, mats, terrain, register, damage, crumple }: VehicleMeshProps) {
  const model = vehicleModel(v.type, v.lengthM, v.widthM);
  const parts = useMemo(() => (damage ? damage(model.parts) : model.parts), [damage, model]);
  useEffect(() => () => {
    if (parts === model.parts) return;
    for (const k of ["body", "glass", "headlight", "taillight", "tire"] as const) if (parts[k] !== model.parts[k]) parts[k].dispose();
  }, [parts, model]);
  // The catalog model crumples on a per-vehicle copy: the loaded model itself is never changed. A model that can't be
  // crumpled is drawn as it is (the picture never waits on, or breaks over, the crumple).
  const crumpled = useMemo(() => {
    if (!catalog || !crumple) return null;
    try { return crumple(catalog.object); } catch { return null; }
  }, [catalog, crumple]);
  useEffect(() => () => crumpled?.dispose(), [crumpled]);
  const ground = heightAt(terrain ?? null, { x: pose.xM, y: pose.yM });
  const body = mats.bodyFor(v.id);
  const fill = VehicleMaterials.fillOf(paint ?? { id: v.id });
  // Our body and the catalog model take vehicleColor(v) after the commit and before the next frame (a layout effect):
  // render stays pure, and no frame shows a catalog model in its own paint.
  useLayoutEffect(() => {
    mats.paintBody(body, fill);
    if (catalog) applyTint(catalog.plan, body.color);
  }, [mats, body, fill, catalog]);
  return (
    <group ref={(g) => register?.(v.id, g)} position={toThree({ x: pose.xM, y: pose.yM }, ground)} rotation={[0, headingToYaw(pose.headingRad), 0]}>
      {catalog ? <primitive object={crumpled?.object ?? catalog.object} /> : (
        <>
          <mesh geometry={parts.body} material={body} castShadow />
          <mesh geometry={parts.glass} material={mats.glass} />
          <mesh geometry={parts.tire} material={mats.tire} castShadow />
          <mesh geometry={parts.headlight} material={mats.headlight} />
          <mesh geometry={parts.taillight} material={mats.taillight} />
        </>
      )}
    </group>
  );
}

/** Where a vehicle ends up: its footprint as a dashed outline in the vehicle's color. */
export function RestOutline({ v, terrain, strokePx, color }: { v: VehicleResult; terrain: RoadNetwork["terrain"] | null; strokePx: number; color: Color }) {
  const pose = v.restPose;
  const ground = heightAt(terrain ?? null, { x: pose.xM, y: pose.yM });
  const hw = v.widthM / 2, hl = v.lengthM / 2, y = LIFT.ring;
  const ring = useMemo<Array<[number, number, number]>>(() => [[-hw, y, -hl], [hw, y, -hl], [hw, y, hl], [-hw, y, hl], [-hw, y, -hl]], [hw, hl, y]);
  return (
    <group position={toThree({ x: pose.xM, y: pose.yM }, ground)} rotation={[0, headingToYaw(pose.headingRad), 0]}>
      <Line points={ring} color={color} lineWidth={strokePx} dashed dashSize={0.5} gapSize={0.35} />
    </group>
  );
}
