// Label placement with collision avoidance. Labels try a few preferred spots
// around their anchor (above, below, right, left), then step outward on a ring
// and get a leader line back to the anchor. They never leave the bounds and
// never overlap each other or the obstacles when any spot is free.
import { rectsOverlap, type Rect } from "./geometry";

export type Side = "above" | "below" | "right" | "left" | "center";

export interface LabelRequest {
  readonly id: string;
  /** Anchor point in px inside the bounds. */
  readonly anchor: { readonly x: number; readonly y: number };
  readonly w: number;
  readonly h: number;
  /** Clear space around the anchor (half the thing being labeled), px. */
  readonly clearance: number;
  /** Sides to try first, in order. */
  readonly prefer?: readonly Side[];
  /**
   * Explicit places to try instead of the sides, best first (a street name on its road). Each is the
   * label's full rectangle. With `optional`, a label with no free spot is left out instead of forced in.
   */
  readonly spots?: readonly Rect[];
  readonly optional?: boolean;
}

export interface Placement {
  readonly id: string;
  /** Top-left corner, px. */
  readonly x: number;
  readonly y: number;
  readonly side: Side | "far" | "spot";
  /** Which of the request's `spots` was used. */
  readonly spot?: number;
  /** Set when the label sits away from its anchor. */
  readonly leader: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } | null;
}

export interface PlaceOptions {
  readonly bounds: { readonly w: number; readonly h: number };
  readonly obstacles?: readonly Rect[];
  /** Space kept between labels, px. */
  readonly gap?: number;
  /** Ring step for far candidates, px. */
  readonly step?: number;
}

const DEFAULT_ORDER: readonly Side[] = ["above", "below", "right", "left"];

function candidate(r: LabelRequest, side: Side): Rect {
  const { x, y } = r.anchor;
  const c = r.clearance;
  switch (side) {
    case "above": return { x: x - r.w / 2, y: y - c - r.h, w: r.w, h: r.h };
    case "below": return { x: x - r.w / 2, y: y + c, w: r.w, h: r.h };
    case "right": return { x: x + c, y: y - r.h / 2, w: r.w, h: r.h };
    case "left": return { x: x - c - r.w, y: y - r.h / 2, w: r.w, h: r.h };
    default: return { x: x - r.w / 2, y: y - r.h / 2, w: r.w, h: r.h };
  }
}

const inside = (rc: Rect, b: { w: number; h: number }) => rc.x >= 0 && rc.y >= 0 && rc.x + rc.w <= b.w && rc.y + rc.h <= b.h;

function leaderFor(r: LabelRequest, rc: Rect): Placement["leader"] {
  // From the anchor to the nearest point on the label's edge.
  const nx = Math.max(rc.x, Math.min(r.anchor.x, rc.x + rc.w));
  const ny = Math.max(rc.y, Math.min(r.anchor.y, rc.y + rc.h));
  return { x1: r.anchor.x, y1: r.anchor.y, x2: nx, y2: ny };
}

export function placeLabels(requests: readonly LabelRequest[], opts: PlaceOptions): Placement[] {
  const gap = opts.gap ?? 4;
  const step = opts.step ?? 12;
  const obstacles = opts.obstacles ?? [];
  const placed: Rect[] = [];
  const out: Placement[] = [];

  const free = (rc: Rect) => inside(rc, opts.bounds) && !obstacles.some((o) => rectsOverlap(rc, o)) && !placed.some((p) => rectsOverlap(rc, p, gap));

  for (const r of requests) {
    let chosen: Rect | null = null;
    let side: Placement["side"] = "above";
    if (r.spots) {
      const i = r.spots.findIndex((rc) => free(rc));
      if (i >= 0) {
        const rc = r.spots[i] as Rect;
        placed.push(rc);
        out.push({ id: r.id, x: rc.x, y: rc.y, side: "spot", spot: i, leader: null });
        continue;
      }
      if (r.optional) continue;
    }
    for (const s of [...(r.prefer ?? []), ...DEFAULT_ORDER]) {
      const rc = candidate(r, s);
      if (free(rc)) { chosen = rc; side = s; break; }
    }
    if (!chosen) {
      // Walk outward on a ring of 12 directions until a free spot turns up.
      search: for (let k = 1; k <= 12; k++) {
        const radius = r.clearance + k * step;
        for (let a = 0; a < 12; a++) {
          const ang = (a / 12) * Math.PI * 2;
          const cx = r.anchor.x + Math.sin(ang) * (radius + r.w / 2 * Math.abs(Math.sin(ang)));
          const cy = r.anchor.y - Math.cos(ang) * (radius + r.h / 2 * Math.abs(Math.cos(ang)));
          const rc: Rect = { x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h };
          if (free(rc)) { chosen = rc; side = "far"; break search; }
        }
      }
    }
    if (!chosen) {
      // Nothing is free: take the preferred spot, nudged inside the bounds.
      const rc = candidate(r, (r.prefer ?? DEFAULT_ORDER)[0] ?? "above");
      chosen = { ...rc, x: Math.max(0, Math.min(rc.x, opts.bounds.w - rc.w)), y: Math.max(0, Math.min(rc.y, opts.bounds.h - rc.h)) };
      side = "far";
    }
    placed.push(chosen);
    out.push({ id: r.id, x: chosen.x, y: chosen.y, side, leader: side === "far" ? leaderFor(r, chosen) : null });
  }
  return out;
}

/** Estimated pill size when the real one can't be measured (first paint, tests). */
export function estimateLabelSize(text: string, charPx: number, heightPx: number, padPx: number): { w: number; h: number } {
  return { w: Math.ceil(text.length * charPx + padPx), h: heightPx };
}
