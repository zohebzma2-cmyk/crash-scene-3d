// The scene file: canonical JSON of the scene plus the save time, the long
// disclaimer and the values the physics used (DESIGN.md section 8). Its SHA-256
// is the fingerprint printed on every export of the same save.
import { DISCLAIMER_LONG, MPH_TO_MPS, PRESETS, canonicalJson, sha256Hex, shortFingerprint } from "@csd/core";
import type { ExportStamp, Scene, SimulationResult } from "@csd/core";
import { speedInputs, vehicleResult } from "./model";

/** Store speeds in mph to a thousandth: stable bytes, no 25.000000000000004. */
const mph = (mps: number) => Math.round((mps / MPH_TO_MPS) * 1000) / 1000;

export async function sceneFile(scene: Scene, sim: SimulationResult, createdAt: string): Promise<{ text: string; stamp: ExportStamp }> {
  const vehicles = scene.vehicles.map((v) => {
    const s = speedInputs(v);
    const shown = vehicleResult(sim, v.id).speedAtImpactMps;
    return {
      ...v,
      speedSource: s.source,
      postedLimitMph: s.postedLimitMph,
      postedLimitSource: s.postedLimitSource,
      // what the claimant entered, and what the physics drew (it may narrow a "not sure" range)
      speedRangeMph: s.rangeMph,
      speedUsedMph: mph(shown.mid),
      speedShownRangeMph: { lo: mph(shown.lo), mid: mph(shown.mid), hi: mph(shown.hi) },
    };
  });
  const derivedVehicles = scene.vehicles.map((v) => {
    const rv = vehicleResult(sim, v.id);
    const preset = PRESETS[v.type];
    return {
      id: v.id,
      massKg: rv.massKg,
      massSource: rv.massKg === preset.mass.value ? `Typical weight for a ${preset.label.toLowerCase()}: ${preset.mass.source}` : `Weight used for the ${preset.label.toLowerCase()} in this scene`,
    };
  });
  const text = canonicalJson({
    ...scene,
    physicsVersion: sim.physicsVersion,
    road: { ...scene.road, friction: sim.frictionCoefficient },
    vehicles,
    createdAt,
    disclaimer: DISCLAIMER_LONG,
    derived: {
      physicsVersion: sim.physicsVersion,
      frictionCoefficient: sim.frictionCoefficient,
      restitution: sim.restitution,
      assumptions: sim.assumptions,
      warnings: sim.warnings.map((w) => ({ code: w.code, text: w.text })),
      vehicles: derivedVehicles,
    },
  });
  const fingerprintHex = await sha256Hex(text);
  return { text, stamp: { createdAt, fingerprintHex, fingerprintShort: shortFingerprint(fingerprintHex) } };
}
