// What the Review picture is doing while it is built: "Building the scene…" with the real stages (map data,
// terrain, 3D models, drawing), and, if something fails, what failed with a Retry button. Text only.
// The stages come from viewer/load-stages; this component only reads the app's state and draws them.
import { useEffect, useMemo, useRef } from "react";
import { Icon } from "../icons/Icon";
import { useRoads } from "../state/Roads";
import { HEADLINE, loadComplete, loadFailure, loadMessage, loadNotice, loadProgress, loadStages, stageChanges, type LoadInputs, type Stage } from "../viewer/load-stages";
import { retryViewer, useViewerModule } from "../viewer/load-viewer";

export interface ViewerStatusProps {
  /** The 3D view's first frame (or why it failed). */
  readonly scene: LoadInputs["scene"];
  /** False: no WebGL, so the top-down diagram is the picture and there is no 3D to load. */
  readonly webgl: boolean;
  /** The example's scene file is still on its way (its roads come next). */
  readonly exampleLoading?: boolean;
  /** Retry after the 3D view itself failed (WebGL could not start, or was lost). */
  readonly onRetryScene?: () => void;
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

export function ViewerStatus({ scene, webgl, exampleLoading = false, onRetryScene }: ViewerStatusProps) {
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
  const progress = loadProgress(stages);

  const retry = (s: Stage) => {
    if (s.id === "map") roads.retry();
    else if (s.id === "models") void retryViewer().catch(() => undefined);
    else onRetryScene?.();
  };

  return (
    <>
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
      {busy ? (
        <div className="viewer-status" data-testid="viewer-loading">
          <p className="viewer-status-title" role="status" aria-live="polite">
            <strong>{HEADLINE}</strong> <span className="viewer-status-now">{loadMessage(stages).slice(HEADLINE.length).trim()}</span>
          </p>
          <div className="viewer-status-bar" aria-hidden="true"><span style={{ transform: `scaleX(${progress.toFixed(3)})` }} /></div>
          <ul className="viewer-status-list" aria-hidden="true">
            {stages.filter((s) => s.status !== "skipped" || s.id === "terrain").map((s) => <StageRow key={s.id} s={s} />)}
          </ul>
        </div>
      ) : null}
    </>
  );
}
