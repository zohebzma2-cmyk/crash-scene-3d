// The vehicles in the scene: solid models at the current time, and the dashed rest-pose outlines.
// Geometry comes from vehicle-models (cached); materials are bound to tokens and disposed on unmount.
import { useEffect, useMemo } from "react";
import { Line } from "@react-three/drei";
import { MeshStandardMaterial, type Color, type Group, type Material } from "three";
import { vehicleColor, type Paintable, type Pose, type RoadNetwork, type VehicleResult } from "@csd/core";
import { headingToYaw, heightAt, toThree } from "./math";
import { vehicleToken, type SceneColors, type SceneToken } from "./tokens";
import { applyTint, type TintPlan } from "./glb-model";
import { vehicleModel, type VehicleParts } from "./vehicle-models";
import { LIFT } from "./scene-geometry";

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

  /**
   * The body material of vehicle `v`, in `vehicleColor(v)`: its picked paint, or its token colour for "Not sure".
   * The colour is set only when the paint changes (never per frame); the letter badges and outlines stay in the token.
   */
  bodyFor(v: Paintable): MeshStandardMaterial {
    let m = this.body.get(v.id);
    if (!m) { m = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.15 }); this.body.set(v.id, m); }
    const fill = vehicleColor(v, vehicleToken);       // a token name, or the picked "#rrggbb"
    if (m.userData.fill !== fill) {
      if (fill.startsWith("--")) m.color.copy(this.colors[fill as SceneToken]);
      else m.color.set(fill);                          // sRGB hex to the working colour space
      m.userData.fill = fill;
    }
    return m;
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
}

export function VehicleMesh({ v, paint, catalog, pose, mats, terrain, register, damage }: VehicleMeshProps) {
  const model = vehicleModel(v.type, v.lengthM, v.widthM);
  const parts = useMemo(() => (damage ? damage(model.parts) : model.parts), [damage, model]);
  useEffect(() => () => {
    if (parts === model.parts) return;
    for (const k of ["body", "glass", "headlight", "taillight", "tire"] as const) if (parts[k] !== model.parts[k]) parts[k].dispose();
  }, [parts, model]);
  const ground = heightAt(terrain ?? null, { x: pose.xM, y: pose.yM });
  const body = mats.bodyFor(paint ?? { id: v.id });
  const fill = body.userData.fill as string;
  // The catalog model takes the same colour as our body material (vehicleColor), set when the paint or the model changes.
  useEffect(() => { if (catalog) applyTint(catalog.plan, body.color); }, [catalog, body, fill]);
  return (
    <group ref={(g) => register?.(v.id, g)} position={toThree({ x: pose.xM, y: pose.yM }, ground)} rotation={[0, headingToYaw(pose.headingRad), 0]}>
      {catalog ? <primitive object={catalog.object} /> : (
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
