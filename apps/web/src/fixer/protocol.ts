// The messages between the page and the fixer's Web Worker (fixer.worker.ts). Everything stays in this browser tab:
// the scene and the roads go to a worker on the same page, never to a server.
import type { FixSuggestions, RoadNetwork, Scene } from "@csd/core";

export interface FixRequest {
  readonly id: number;
  readonly scene: Scene;
  /** The road data, sent only when the worker doesn't already hold `roadsKey`; null with roadsKey null = no road data. */
  readonly roads: RoadNetwork | null;
  /** Which road data the request is about (the page numbers each RoadNetwork it sends), or null for none. */
  readonly roadsKey: number | null;
  /** This device's remembered fix kinds (see memory.ts): only kinds and counts, no scene details. */
  readonly prefer: Readonly<Record<string, number>>;
  /** The Vehicles step's warnings: fixes that also clear the plain checks (FixOptions.gate). Absent = the Review refusal. */
  readonly gate?: boolean;
}

export type FixResponse =
  | { readonly id: number; readonly ok: true; readonly result: FixSuggestions }
  | { readonly id: number; readonly ok: false; readonly message: string };
