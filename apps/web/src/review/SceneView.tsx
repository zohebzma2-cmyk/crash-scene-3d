// The picture on the Review step: the 3D viewer when the browser has WebGL,
// otherwise the top-down diagram (ViewerSlot), which is also shown while the
// 3D code loads. three.js is loaded lazily so the other steps stay light.
import { Suspense, forwardRef, lazy, useCallback, useImperativeHandle, useRef, useState } from "react";
import type { ViewerHandle } from "../viewer/types";
import { ViewerSlot, type ViewerSlotProps } from "./ViewerSlot";

const Viewer = lazy(() => import("../viewer/Viewer").then((m) => ({ default: m.Viewer })));

function hasWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Longest a save waits for the 3D view to draw its first frame before giving up on the pictures. */
const READY_WAIT_MS = 10_000;

export interface SceneViewProps extends ViewerSlotProps {
  /** Phones keep the lines and outlines but show the numbers in the Measure tab, not as pills over the small view. */
  readonly phone: boolean;
}

export const SceneView = forwardRef<ViewerHandle | null, SceneViewProps>(function SceneView({ phone, onSelectVehicle, ...props }, ref) {
  const [webgl] = useState(hasWebGL);
  const inner = useRef<ViewerHandle | null>(null);
  // The 3D code loads lazily and needs a first frame before it can take a picture. A save
  // pressed early waits for that (bounded), instead of quietly leaving the pictures out.
  const ready = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!ready.current) { let resolve = () => {}; const promise = new Promise<void>((r) => { resolve = r; }); ready.current = { promise, resolve }; }
  const onReady = props.onReady;
  const handleReady = useCallback(() => { ready.current?.resolve(); onReady?.(); }, [onReady]);
  useImperativeHandle(ref, () => ({
    captureStill: async (t, view, size) => {
      if (!webgl) throw new Error("The 3D view isn't available in this browser.");
      const timedOut = await Promise.race([ready.current!.promise.then(() => false), new Promise<boolean>((r) => window.setTimeout(() => r(true), READY_WAIT_MS))]);
      if (timedOut || !inner.current) throw new Error("The 3D view wasn't ready in time.");
      return inner.current.captureStill(t, view, size);
    },
    handleKey: (e) => inner.current?.handleKey?.(e) ?? false,
  }), [webgl]);
  const fallback = <ViewerSlot {...props} onReady={webgl ? undefined : props.onReady} {...(onSelectVehicle ? { onSelectVehicle } : {})} />;
  if (!webgl) return fallback;
  return (
    <Suspense fallback={fallback}>
      <Viewer ref={inner} {...props} onReady={handleReady} showMeasureValues={!phone} {...(onSelectVehicle ? { onSelectVehicle } : {})} />
    </Suspense>
  );
});
