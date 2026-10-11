// What the Review picture is doing while it is built: "Building the scene…" with the real stages (map data,
// terrain, 3D view, drawing), and, if something fails, what failed with a Retry button. Text only.
// The stages come from viewer/load-stages; this component only reads the app's state and draws them.
// The boxes sit top left in the picture (like the notice), clear of the crash in the middle; what a screen
// reader hears goes through the one live region the app keeps (LoadAnnouncer), not through these boxes.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons/Icon";
import { useRoads } from "../state/Roads";
import {
  HEADLINE, READY_TEXT, loadComplete, loadFailure, loadMessage, loadNotice, loadProgress, loadStages, onlySceneLeft, stageChanges,
  type LoadInputs, type Stage,
} from "../viewer/load-stages";
import { retryViewer, useViewerModule } from "../viewer/load-viewer";
import { announceLoad, loadAnnouncement } from "./LoadAnnouncer";

/** When only the first frame is left (a revisit with the 3D code cached), the box waits this long before showing, so it doesn't flash. */
export const SCENE_ONLY_DELAY_MS = 300;

export interface ViewerStatusProps {
  /** The 3D view's first frame (or why it failed). */
  readonly scene: LoadInputs["scene"];
  /** False: no WebGL, so the top-down diagram is the picture and there is no 3D to load. */
  readonly webgl: boolean;
  /** The example's scene file is still on its way (its roads come next). */
  readonly exampleLoading?: boolean;
  /** Retry after the 3D view itself failed (WebGL could not start, or was lost). */
  readonly onRetryScene?: () => void;
  /** Retry after the 3D code failed to load. */
  readonly onRetryChunk?: () => void;
}

function StageRow({ s }: { s: Stage }) {
  const mark = s.status === "done" ? <Icon name="check" className="icon-sm" />
    : s.status === "failed" ? <Icon name="warning" className="icon-sm" />
      : s.status === "active" ? <span className="spinner" />
        : <span className="viewer-status-dot" />;
  return (
    <li className="viewer-status-row" data-stage={s.id} data-status={s.status}>
      {mark}
      <span>{s.label}</span>
      {s.count && s.status === "active" ? <span className="num">{s.count.done} of {s.count.total}</span> : null}
      {s.status === "skipped" && s.id === "terrain" ? <span>flat ground</span> : null}
    </li>
  );
}

/** Performance marks for each stage change (csd:load:<stage>:<status>), so the load can be timed in the field and in tests. */
function useStageMarks(stages: readonly Stage[]) {
  const prev = useRef<readonly Stage[]>([]);
  useEffect(() => {
    for (const c of stageChanges(prev.current, stages)) {
      try { performance.mark(`csd:load:${c.id}:${c.to}`); } catch { /* marks are best effort */ }
    }
    prev.current = stages;
  }, [stages]);
}

export function ViewerStatus({ scene, webgl, exampleLoading = false, onRetryScene, onRetryChunk }: ViewerStatusProps) {
  const roads = useRoads();
  const chunk = useViewerModule();
  const map: LoadInputs["map"] = exampleLoading || roads.status === "loading" ? "loading" : roads.status === "error" ? "failed" : roads.status === "idle" ? "none" : "ready";
  const terrain: LoadInputs["terrain"] = roads.progress
    ? { done: roads.progress.terrainDone, total: roads.progress.terrainTotal }
    : roads.terrainAvailable === null ? null : { done: 0, total: 0, available: roads.terrainAvailable };
  const models: LoadInputs["models"] = webgl ? chunk.status : "none";
  const sceneKey = typeof scene === "object" ? `failed:${scene.failed}` : scene;
  // Derived again only when an input changes, so the marks fire once per real change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stages = useMemo(() => loadStages({ map, terrain, models, scene }), [map, terrain?.done, terrain?.total, terrain?.available, models, sceneKey]);
  useStageMarks(stages);

  const failure = loadFailure(stages);
  const notice = loadNotice(stages);
  const busy = !failure && !loadComplete(stages);
  // A revisit with everything cached only waits for the first frame: hold the box back a moment so it doesn't flash.
  const quick = busy && onlySceneLeft(stages);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (!quick) return;
    const id = window.setTimeout(() => setWaited(true), SCENE_ONLY_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [quick]);
  const showBox = busy && (!quick || waited);
  const progress = loadProgress(stages);

  // The one live region: each stage once (no tile counts), and "ready" when the box goes.
  // "Ready" follows a loading announcement even when it came from the skeleton this box replaced.
  const liveText = loadMessage(stages, { counts: false });
  useEffect(() => {
    if (showBox) announceLoad(liveText);
    else if (!busy && !failure && loadAnnouncement().startsWith(HEADLINE)) announceLoad(READY_TEXT);
  }, [showBox, busy, failure, liveText]);

  const retry = (s: Stage) => {
    if (s.id === "map") roads.retry();
    else if (s.id === "models") { if (onRetryChunk) onRetryChunk(); else void retryViewer().catch(() => undefined); }
    else onRetryScene?.();
  };

  if (!notice && !failure && !showBox) return null;
  return (
    <div className="viewer-overlays">
      {notice ? (
        <div className="viewer-notice" role="alert" data-testid="viewer-notice">
          <Icon name="warning" className="icon-sm" />
          <span>{notice.message}</span>
          <button type="button" className="btn btn-quiet viewer-retry" onClick={() => retry(notice)}>Retry</button>
        </div>
      ) : null}
      {failure ? (
        <div className="viewer-status is-error" role="alert" data-testid="viewer-error">
          <p className="viewer-status-title"><Icon name="warning" className="icon-sm" />{failure.message}</p>
          <button type="button" className="btn btn-secondary viewer-retry" onClick={() => retry(failure)}><Icon name="restart" className="icon-sm" />Retry</button>
        </div>
      ) : null}
      {showBox ? (
        <div className="viewer-status" data-testid="viewer-loading">
          <p className="viewer-status-title">
            <strong>{HEADLINE}</strong> <span className="viewer-status-now">{loadMessage(stages).slice(HEADLINE.length).trim()}</span>
          </p>
          <div className="viewer-status-bar" aria-hidden="true"><span style={{ transform: `scaleX(${progress.toFixed(3)})` }} /></div>
          <ul className="viewer-status-list" aria-hidden="true">
            {stages.filter((s) => s.status !== "skipped" || s.id === "terrain").map((s) => <StageRow key={s.id} s={s} />)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
