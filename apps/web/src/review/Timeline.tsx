// The timeline scrubber: play/pause (restarts from the start at the end), a track with the impact
// marker, a readout (numbers mono, words sans) and the playback speed. It is an ARIA slider:
// Space plays/pauses, left/right 0.1 s, Shift+left/right 1 s, Home/End, I jumps to impact.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "../icons/Icon";
import { effectiveRate } from "../viewer/effects/shake";

export const RATES = [0.25, 0.5, 1] as const;
export type Rate = (typeof RATES)[number];
export const STEP_S = 0.1;
export const BIG_STEP_S = 1;
/** Within this of the end counts as "at the end". */
const END_EPS_S = 0.01;
/** Within this of zero counts as "at impact". */
const IMPACT_EPS_S = 0.05;

export interface TimelineState {
  readonly t: number;
  readonly playing: boolean;
  readonly rate: Rate;
}

/** Next state when the play button (or Space) is pressed. At the end it restarts from the beginning. */
export function togglePlay(s: TimelineState, t0: number, t1: number): TimelineState {
  if (s.playing) return { ...s, playing: false };
  return { ...s, t: s.t >= t1 - END_EPS_S ? t0 : s.t, playing: true };
}

/**
 * `reducedMotion` turns off the slow-down around impact. Otherwise playback eases down to 0.25x within 0.25 s
 * of the impact and back (see viewer/effects/shake.ts). Only the playback clock slows: `t` is always the true sim time.
 */
export function useTimeline(t0: number, t1: number, opts: { startAtImpact: boolean; reducedMotion?: boolean }) {
  const reduced = opts.reducedMotion ?? false;
  const [state, setState] = useState<TimelineState>({ t: opts.startAtImpact ? 0 : t0, playing: false, rate: 1 });
  const frame = useRef(0);
  const stopAt = useRef<number | null>(null);
  const clamp = useCallback((t: number) => Math.min(t1, Math.max(t0, t)), [t0, t1]);

  // The animation loop: advances t by real elapsed time times the playback rate.
  useEffect(() => {
    if (!state.playing) return;
    let last = performance.now();
    const tick = (now: number) => {
      const real = (now - last) / 1000;
      last = now;
      setState((s) => {
        let t = s.t + real * effectiveRate(s.rate, s.t, reduced);
        const stop = stopAt.current;
        if (stop != null && s.t < stop && t >= stop) { stopAt.current = null; return { ...s, t: stop, playing: false }; }
        if (t >= t1) return { ...s, t: t1, playing: false };
        if (t < t0) t = t0;
        return { ...s, t };
      });
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [state.playing, t0, t1, reduced]);

  return {
    ...state,
    seek: (t: number) => setState((s) => ({ ...s, t: clamp(t), playing: false })),
    toggle: () => { stopAt.current = null; setState((s) => togglePlay(s, t0, t1)); },
    setRate: (rate: Rate) => setState((s) => ({ ...s, rate })),
    /** First visit: play the approach once and stop at impact. */
    playApproach: () => { stopAt.current = 0; setState((s) => ({ ...s, t: t0, playing: true })); },
    pause: () => setState((s) => ({ ...s, playing: false })),
  };
}

export type TimelineApi = ReturnType<typeof useTimeline>;

export function readout(t: number, t1: number): { number: string | null; words: string; text: string } {
  if (Math.abs(t) < IMPACT_EPS_S) return { number: null, words: "At impact", text: "At impact" };
  if (t >= t1 - END_EPS_S) return { number: null, words: "Final rest", text: "Final rest" };
  const n = `${Math.abs(t).toFixed(1)} s`;
  const w = t < 0 ? "before impact" : "after impact";
  return { number: n, words: w, text: `${Math.abs(t).toFixed(1)} seconds ${w}` };
}

export interface TimelineProps {
  readonly api: TimelineApi;
  readonly t0: number;
  readonly t1: number;
  /** The "Aftermath" button: jump to final rest in the Aftermath view. Hidden when absent. */
  readonly onAftermath?: () => void;
  readonly aftermathOn?: boolean;
}

export function Timeline({ api, t0, t1, onAftermath, aftermathOn }: TimelineProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const frac = (api.t - t0) / (t1 - t0);
  const impactFrac = (0 - t0) / (t1 - t0);
  const r = readout(api.t, t1);

  const seekFromPointer = (e: PointerEvent) => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || !box.width) return;
    api.seek(t0 + ((e.clientX - box.left) / box.width) * (t1 - t0));
  };
  const onKey = (e: KeyboardEvent) => {
    const big = e.shiftKey ? BIG_STEP_S : STEP_S;
    const delta = ({ ArrowLeft: -big, ArrowDown: -big, ArrowRight: big, ArrowUp: big } as Record<string, number>)[e.key];
    if (delta !== undefined) { e.preventDefault(); api.seek(api.t + delta); }
    else if (e.key === "Home") { e.preventDefault(); api.seek(t0); }
    else if (e.key === "End") { e.preventDefault(); api.seek(t1); }
    else if (e.key === " ") { e.preventDefault(); api.toggle(); }
    else if (e.key.toLowerCase() === "i") { e.preventDefault(); api.seek(0); }
  };

  return (
    <div className="timeline">
      <button className="play" type="button" aria-label={api.playing ? "Pause" : "Play"} onClick={api.toggle}><Icon name={api.playing ? "pause" : "play"} /></button>
      <div
        className="track-wrap"
        onPointerDown={(e) => { setDragging(true); e.currentTarget.setPointerCapture?.(e.pointerId); seekFromPointer(e); }}
        onPointerMove={(e) => { if (dragging) seekFromPointer(e); }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        <div
          className="track"
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Timeline"
          aria-valuemin={t0}
          aria-valuemax={t1}
          aria-valuenow={Number(api.t.toFixed(2))}
          aria-valuetext={r.text}
          onKeyDown={onKey}
        >
          <span className="track-fill" style={{ width: `${frac * 100}%` }} />
          <span className="track-impact" style={{ left: `${impactFrac * 100}%` }}><span className="track-impact-label">Impact</span></span>
          <span className="thumb" style={{ left: `${frac * 100}%` }} />
        </div>
      </div>
      <span className="readout" aria-hidden="true">{r.number ? <><span className="num">{r.number}</span> {r.words}</> : r.words}</span>
      {onAftermath ? <button type="button" className="aftermath-btn" aria-pressed={aftermathOn ?? false} onClick={onAftermath}>Aftermath</button> : null}
      <select className="rate" aria-label="Playback speed" value={api.rate} onChange={(e) => api.setRate(Number(e.target.value) as Rate)}>
        {RATES.map((x) => <option key={x} value={x}>{x}×</option>)}
      </select>
    </div>
  );
}
