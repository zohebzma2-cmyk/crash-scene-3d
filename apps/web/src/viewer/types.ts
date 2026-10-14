// The 3D viewer's interface (locked): the app shell mounts <Viewer> on the
// review step and calls the handle for export stills. Viewer internals are
// built separately (react-three-fiber); the shell never imports three directly.
import type { RoadNetwork, Scene, SimulationResult } from "@csd/core";
import type { VehicleModelAsset, VehicleModelQuery } from "../services/vehicle-models";

export type CameraView = "top" | "wide" | "driver-a" | "driver-b" | "aftermath";
export type Units = "us" | "metric";

export interface ViewerProps {
  readonly scene: Scene;
  readonly roads: RoadNetwork | null;
  readonly sim: SimulationResult;
  /** Current time, s (0 = impact). Owned by the shell's timeline. */
  readonly timeS: number;
  readonly view: CameraView;
  readonly showLabels: boolean;
  readonly showMeasurements: boolean;
  readonly showPaths: boolean;
  readonly units: Units;
  readonly reducedMotion: boolean;
  /**
   * Whether the measurement pills show their numbers. False on phones: the lines and rest outlines stay,
   * the numbers live in the Measure tab. Default true.
   */
  readonly showMeasureValues?: boolean;
  /** Which measurement overlays are switched on (Measure tab); the pills and lines follow them. Default: both. */
  readonly measureGroups?: { readonly impact: boolean; readonly travel: boolean };
  /** A label was tapped or clicked: select that vehicle. */
  readonly onSelectVehicle?: (id: string) => void;
  /**
   * Catalog 3D models (round B): the GLB for a vehicle, or null for our own low-poly model. Absent = always ours.
   * Never blocks the first frame: our model shows until the catalog one has loaded.
   */
  readonly loadModel?: (q: VehicleModelQuery, signal?: AbortSignal) => Promise<VehicleModelAsset | null>;
  /** Called once the scene has rendered its first frame (e2e waits on this). */
  readonly onReady?: () => void;
  /** True until the first frame: the view is drawn but kept hidden (the diagram and the loading status show instead). */
  readonly building?: boolean;
  /** The browser took the WebGL context away (GPU reset, too many contexts): the picture can't go on. */
  readonly onContextLost?: () => void;
  /**
   * Where the catalog-model note goes instead of the picture's corner: an element outside the picture (phones, under
   * the timeline), so the note never covers the crash on a small view. Absent or null: the note sits in the picture's
   * bottom-left corner with the legend.
   */
  readonly noteSlot?: HTMLElement | null;
}

/** The parts of a keyboard event the camera keys need. */
export interface CameraKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  preventDefault(): void;
}

export interface ViewerHandle {
  /**
   * PNG of the scene at time t seen from the fixed camera of `view`, with vehicle letters and names drawn in.
   * It renders offscreen: the on-screen picture, camera and time are untouched.
   */
  captureStill(timeS: number, view: CameraView, size: { width: number; height: number }): Promise<Uint8Array>;
  /**
   * Camera keys (arrows turn, plus and minus zoom, R resets). The page has ONE focus target for the whole
   * picture; it hands the keys it doesn't use itself to this. True when the key was used.
   */
  handleKey?(e: CameraKeyEvent): boolean;
}
