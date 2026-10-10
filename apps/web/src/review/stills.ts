// The 3D stills for the exports (moment of impact in Wide; final rest in the Aftermath view). They can only be
// captured while the 3D view is mounted (Review), and the Save step builds the
// files later, so they wait here, keyed by the exact scene they were taken of.
import { canonicalJson, type Scene } from "@csd/core";

export interface Stills { readonly impact?: Uint8Array; readonly rest?: Uint8Array }

/** 1920 × 933: with the exports footer band (147 px) the PNGs come out 1920 × 1080. */
export const STILL_SIZE = { width: 1920, height: 933 } as const;

let held: { key: string; stills: Stills } | null = null;

const keyOf = (scene: Scene): string => canonicalJson(scene);

export function keepStills(scene: Scene, stills: Stills): void { held = { key: keyOf(scene), stills }; }

/** Stills for this exact scene, or none (never a picture of a different scene). */
export function stillsFor(scene: Scene): Stills | undefined { return held && held.key === keyOf(scene) ? held.stills : undefined; }

export function dropStills(): void { held = null; }
