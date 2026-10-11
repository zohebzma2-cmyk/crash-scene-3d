// The picture on the Review step: the 3D viewer when the browser has WebGL, otherwise the top-down diagram
// (ViewerSlot). The diagram is also what shows while the 3D view is built: the 3D view is mounted hidden on top
// of it and only takes over once it has drawn its first frame, and over both sits the loading status (map data,
// terrain, 3D models, drawing). If the 3D code can't load, or WebGL can't start or is lost, the diagram stays,
// with what went wrong and a Retry button. three.js is loaded lazily so the other steps stay light.
import { Component, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import type { ViewerHandle } from "../viewer/types";
import { hasWebGL, loadViewer, useViewerModule } from "../viewer/load-viewer";
import type { SceneFailure } from "../viewer/load-stages";
import { ViewerSlot, type ViewerSlotProps } from "./ViewerSlot";
import { ViewerStatus } from "./ViewerStatus";
import "../viewer/viewer.css";

/** Longest a save waits for the 3D view to draw its first frame before giving up on the pictures. */
const READY_WAIT_MS = 10_000;

/** Catches the 3D view failing to start (react-three-fiber throws "Error creating WebGL context" in render). */
class ViewerBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(): void { this.props.onError(); }
  override render(): ReactNode { return this.state.failed ? null : this.props.children; }
}

export interface SceneViewProps extends ViewerSlotProps {
  /** Phones keep the lines and outlines but show the numbers in the Measure tab, not as pills over the small view. */
  readonly phone: boolean;
}

type SceneState = "building" | "ready" | { failed: SceneFailure };

export const SceneView = forwardRef<ViewerHandle | null, SceneViewProps>(function SceneView({ phone, onSelectVehicle, ...props }, ref) {
  const [webgl] = useState(hasWebGL);
  const chunk = useViewerModule();
  useEffect(() => { if (webgl) void loadViewer().catch(() => undefined); }, [webgl]);
  const [scene, setScene] = useState<SceneState>("building");
  /** Bumped by Retry: a fresh 3D view (a new canvas and WebGL context). */
  const [attempt, setAttempt] = useState(0);
  const inner = useRef<ViewerHandle | null>(null);
  // The 3D code loads lazily and needs a first frame before it can take a picture. A save
  // pressed early waits for that (bounded), instead of quietly leaving the pictures out.
  const ready = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!ready.current) { let resolve = () => {}; const promise = new Promise<void>((r) => { resolve = r; }); ready.current = { promise, resolve }; }
  const onReady = props.onReady;
  const handleReady = useCallback(() => { setScene("ready"); ready.current?.resolve(); onReady?.(); }, [onReady]);
  // A failed 3D view lets a waiting save go on at once (without the 3D pictures) instead of waiting it out.
  const fail = useCallback((why: SceneFailure) => { setScene({ failed: why }); ready.current?.resolve(); }, []);
  const onBoundary = useCallback(() => fail("webgl"), [fail]);
  const onLost = useCallback(() => fail("lost"), [fail]);
  const retryScene = useCallback(() => { inner.current = null; setScene("building"); setAttempt((n) => n + 1); }, []);
  const failed = typeof scene === "object" || (webgl && chunk.status === "failed");
  useImperativeHandle(ref, () => ({
    captureStill: async (t, view, size) => {
      if (!webgl) throw new Error("The 3D view isn't available in this browser.");
      const timedOut = await Promise.race([ready.current!.promise.then(() => false), new Promise<boolean>((r) => window.setTimeout(() => r(true), READY_WAIT_MS))]);
      if (timedOut || !inner.current) throw new Error("The 3D view wasn't ready in time.");
      return inner.current.captureStill(t, view, size);
    },
    handleKey: (e) => inner.current?.handleKey?.(e) ?? false,
  }), [webgl]);

  const Viewer = chunk.module?.Viewer ?? null;
  const showDiagram = !webgl || scene !== "ready";
  const status = <ViewerStatus scene={webgl && Viewer ? scene : "waiting"} webgl={webgl} onRetryScene={retryScene} />;
  return (
    <>
      {showDiagram ? <ViewerSlot {...props} onReady={webgl ? undefined : props.onReady} {...(onSelectVehicle ? { onSelectVehicle } : {})} /> : null}
      {webgl && Viewer && !failed ? (
        <ViewerBoundary key={attempt} onError={onBoundary}>
          <Viewer
            ref={inner} {...props} building={scene !== "ready"} onReady={handleReady} onContextLost={onLost}
            showMeasureValues={!phone} {...(onSelectVehicle ? { onSelectVehicle } : {})}
          />
        </ViewerBoundary>
      ) : null}
      {status}
    </>
  );
});
