// The impact effects as plain three.js objects: debris shards (two instanced meshes), skid-mark ribbons,
// and the impact flash. Everything is a function of the sim time, so `setTime(t)` is all the viewer, the
// scrubber and the export stills need. No per-frame allocation: matrices, quaternions and poses are reused.
// Colors come from tokens only. Dispose with `dispose()`.
import {
  BufferGeometry, DoubleSide, Euler, Float32BufferAttribute, Group, InstancedMesh, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Quaternion, RingGeometry, TetrahedronGeometry, Uint32BufferAttribute, Vector3, Matrix4,
} from "three";
import type { RoadNetwork, SimulationResult, TerrainGrid, Vec2 } from "@csd/core";
import { heightAt, toThree } from "../math";
import { LIFT, ringPlacement } from "../scene-geometry";
import type { SceneColors } from "../tokens";
import { buildShards, settledPositions, shardPoseAt, type ShardPose, type Shards } from "./debris";
import { buildSkids, drawCountAt, type SkidRibbon } from "./skids";

/** The flash on the impact ring lasts this long after the impact, s (sim time), and grows to FLASH_SCALE. */
export const FLASH_S = 0.35;
const FLASH_SCALE = 2.4;
/** Shards lie on top of the road surface and its paint (road 0.04, paint 0.07, marks 0.085). */
const SHARD_LIFT_M = 0.1;
const SKID_OPACITY: Record<SkidRibbon["kind"], number> = { slide: 0.55, brake: 0.28 };

export interface FxInput {
  readonly sim: SimulationResult;
  readonly roads: RoadNetwork | null;
  readonly colors: SceneColors;
  readonly seed: number;
  readonly braking: ReadonlySet<string>;
  readonly strengthMps: number;
}

export class ImpactFx {
  readonly group = new Group();
  readonly shards: Shards;
  readonly skids: readonly SkidRibbon[];
  private readonly glass: InstancedMesh | null;
  private readonly plastic: InstancedMesh | null;
  private readonly flash: Mesh;
  private readonly flashMat: MeshBasicMaterial;
  private readonly skidMeshes: Array<{ mesh: Mesh; ribbon: SkidRibbon }> = [];
  private readonly kindIndex: Int32Array;
  private readonly terrain: TerrainGrid | null;
  private readonly q = { x: 0, y: 0 };
  private readonly sim: SimulationResult;
  private readonly disposables: Array<{ dispose(): void }> = [];
  // scratch, reused every call
  private readonly pose: ShardPose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, visible: false };
  private readonly euler = new Euler();
  private readonly quat = new Quaternion();
  private readonly pos = new Vector3();
  private readonly scale = new Vector3();
  private readonly mat = new Matrix4();

  constructor(input: FxInput) {
    const { sim, roads, colors } = input;
    this.sim = sim;
    this.terrain = roads?.terrain ?? null;
    const headings = sim.vehicles.map((v) => v.impactPose.headingRad);
    this.shards = buildShards({ seed: input.seed, originM: sim.impactPointM, headingsRad: headings, strengthMps: input.strengthMps });
    this.skids = buildSkids({ sim, roads, terrain: this.terrain, braking: input.braking });
    this.group.name = "impact-effects";

    // Debris: one thin tetrahedron, flattened, instanced per kind.
    const shardGeo = new TetrahedronGeometry(0.62);              // edge about 1 unit, so `size` is a shard's length in meters
    shardGeo.scale(1, 0.3, 0.8);
    this.disposables.push(shardGeo);
    this.kindIndex = new Int32Array(this.shards.count);
    let ng = 0, np = 0;
    for (let i = 0; i < this.shards.count; i++) this.kindIndex[i] = this.shards.kind[i] === 0 ? ng++ : np++;
    const make = (n: number, color: MeshStandardMaterial): InstancedMesh | null => {
      if (!n) return null;
      const m = new InstancedMesh(shardGeo, color, n);
      m.frustumCulled = false;
      m.castShadow = false;
      m.name = "debris";
      this.group.add(m);
      return m;
    };
    const glassMat = new MeshStandardMaterial({ color: colors["--color-scene-debris-glass"], roughness: 0.25, metalness: 0.1, flatShading: true });
    const plasticMat = new MeshStandardMaterial({ color: colors["--color-scene-debris-plastic"], roughness: 0.7, flatShading: true });
    this.disposables.push(glassMat, plasticMat);
    this.glass = make(ng, glassMat);
    this.plastic = make(np, plasticMat);

    // Skid marks: one translucent strip mesh per ribbon, grown with a draw range.
    const skidColor = colors["--color-scene-skid"];
    for (const ribbon of this.skids) {
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(ribbon.positions, 3));
      g.setIndex(new Uint32BufferAttribute(ribbon.indices, 1));
      const m = new MeshBasicMaterial({ color: skidColor, transparent: true, opacity: SKID_OPACITY[ribbon.kind], depthWrite: false, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const mesh = new Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      mesh.name = `skid-${ribbon.vehicleId}-${ribbon.kind}`;
      this.group.add(mesh);
      this.skidMeshes.push({ mesh, ribbon });
      this.disposables.push(g, m);
    }

    // The flash: a thin ring at the impact point that swells and fades.
    const ringGeo = new RingGeometry(0.85, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.flashMat = new MeshBasicMaterial({ color: colors["--color-scene-impact"], transparent: true, opacity: 0, depthWrite: false, side: DoubleSide });
    this.flash = new Mesh(ringGeo, this.flashMat);
    this.flash.visible = false;
    this.flash.renderOrder = 3;
    const p = ringPlacement(sim).center;
    this.flash.position.set(...toThree(p, heightAt(this.terrain, p) + LIFT.ring + 0.02));
    this.group.add(this.flash);
    this.disposables.push(ringGeo, this.flashMat);
  }

  /** Where the debris came to rest and the slide marks end, for framing the Aftermath view. */
  extraPoints(): Vec2[] {
    const pts = settledPositions(this.shards);
    for (const s of this.skids) for (const tr of s.tracks) { const e = tr[tr.length - 1]; if (e) pts.push(e); }
    return pts;
  }

  /** Put everything where it is at sim time t. `reduced`: no flash, and the debris is already settled once the impact has happened. */
  setTime(t: number, reduced: boolean): void {
    const since = t < 0 ? -1 : reduced ? Infinity : t;
    this.placeShards(since);
    for (const { mesh, ribbon } of this.skidMeshes) mesh.geometry.setDrawRange(0, drawCountAt(ribbon, t));
    const f = !reduced && t >= 0 && t < FLASH_S ? t / FLASH_S : -1;
    this.flash.visible = f >= 0;
    if (f >= 0) {
      const k = 1 - (1 - f) * (1 - f);
      this.flash.scale.setScalar(1 + (FLASH_SCALE - 1) * k);
      this.flashMat.opacity = 0.9 * (1 - f);
    }
  }

  private placeShards(since: number): void {
    const s = this.shards;
    const { glass, plastic } = this;
    if (glass) glass.visible = since >= 0;
    if (plastic) plastic.visible = since >= 0;
    if (since < 0) return;
    const p0 = this.sim.impactPointM;
    const g0 = heightAt(this.terrain, p0);
    for (let i = 0; i < s.count; i++) {
      const pose = shardPoseAt(s, i, since, this.pose);
      const size = s.size[i]!;
      const q = this.q;
      q.x = pose.x; q.y = pose.y;
      // Follow the ground: the terrain height under the shard, blended from the launch point's.
      const ground = since >= s.flightS[i]! ? heightAt(this.terrain, q) : g0;
      this.pos.set(q.x, ground + SHARD_LIFT_M + pose.z + size * 0.15, -q.y);
      this.euler.set(pose.rx, pose.ry, pose.rz);
      this.quat.setFromEuler(this.euler);
      this.scale.setScalar(size);
      this.mat.compose(this.pos, this.quat, this.scale);
      const mesh = s.kind[i] === 0 ? glass : plastic;
      mesh?.setMatrixAt(this.kindIndex[i]!, this.mat);
    }
    if (glass) glass.instanceMatrix.needsUpdate = true;
    if (plastic) plastic.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.glass?.dispose();
    this.plastic?.dispose();
    for (const d of this.disposables) d.dispose();
    this.group.clear();
  }
}
