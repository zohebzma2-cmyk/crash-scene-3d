import { describe, expect, it } from "vitest";
import { LABEL_MAX_DISTANCE_PX, layoutLabels, rectDistance, rectsOverlap, type LabelRequest, type Rect } from "../../src/viewer/math";

const veh = (id: string, x: number, y: number, w = 90, h = 60, lw = 130): LabelRequest => ({
  id, anchor: { x: x + w / 2, y: y + 8 }, rect: { x, y, w, h }, w: lw, h: 24,
});

const VIEWS = [{ w: 1100, h: 700 }, { w: 390, h: 420 }];

function check(reqs: readonly LabelRequest[], viewport: { w: number; h: number }, obstacles: readonly Rect[] = []) {
  const out = layoutLabels(reqs, { viewport, obstacles });
  const shown = out.filter((o) => o.visible);
  for (let i = 0; i < shown.length; i++) {
    const a = shown[i]!;
    // inside the view
    expect(a.x).toBeGreaterThanOrEqual(0); expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(viewport.w); expect(a.y + a.h).toBeLessThanOrEqual(viewport.h);
    // within reach of what it labels
    const req = reqs.find((r) => r.id === a.id)!;
    expect(a.distance).toBeLessThanOrEqual(LABEL_MAX_DISTANCE_PX + 0.5);
    expect(rectDistance(a, req.rect)).toBeCloseTo(a.distance);
    // a label that is not in its first-choice place has a leader back to its anchor
    if (a.moved) expect(a.leader).not.toBeNull();
    for (let j = i + 1; j < shown.length; j++) expect(rectsOverlap(a, shown[j]!, 0)).toBe(false);
    for (const o of obstacles) expect(rectsOverlap(a, o, 0)).toBe(false);
  }
  return out;
}

describe("label layout", () => {
  it("puts a free label straight above its vehicle, with no leader", () => {
    const [l] = check([veh("A", 300, 300)], VIEWS[0]!);
    expect(l!.moved).toBe(false);
    expect(l!.leader).toBeNull();
    expect(l!.y + l!.h).toBeLessThanOrEqual(300);
  });

  it("never overlaps another label, a vehicle body, a control or a pill, and stays within 64 px", () => {
    const bodies = [veh("A", 300, 300), veh("B", 392, 300), veh("C", 300, 362)];
    const controls: Rect[] = [{ x: 700, y: 12, w: 360, h: 52 }, { x: 12, y: 600, w: 150, h: 52 }];
    const pill: LabelRequest = { id: "m1", anchor: { x: 392, y: 330 }, rect: { x: 392, y: 330, w: 0, h: 0 }, w: 120, h: 24, prefer: ["C"] };
    const reqs = [...bodies, pill];
    const out = check(reqs, VIEWS[0]!, [...bodies.map((b) => b.rect), ...controls]);
    expect(out.every((o) => o.visible)).toBe(true);
  });

  it("moves as little as it can: only the label that is blocked moves", () => {
    const out = check([veh("A", 100, 300), veh("B", 600, 300)], VIEWS[0]!);
    expect(out.every((o) => !o.moved)).toBe(true);
  });

  it("keeps a label near its car on a phone when two cars touch (the 390 px Top view)", () => {
    const out = check([veh("A", 120, 200, 110, 70, 150), veh("B", 230, 200, 110, 70, 150)], VIEWS[1]!, [{ x: 220, y: 8, w: 160, h: 52 }]);
    for (const o of out) expect(o.distance).toBeLessThanOrEqual(LABEL_MAX_DISTANCE_PX);
    const a = out.find((o) => o.id === "A")!, b = out.find((o) => o.id === "B")!;
    expect(rectsOverlap(a, b, 0)).toBe(false);
    expect(rectsOverlap(a, { x: 230, y: 200, w: 110, h: 70 }, 0)).toBe(false);
  });

  it("keeps labels clear of a controls rectangle on the edge it would otherwise use", () => {
    const controls: Rect = { x: 0, y: 0, w: 1100, h: 260 };
    check([veh("A", 300, 280)], VIEWS[0]!, [controls, veh("A", 300, 280).rect]);
  });

  it("leaves out a label whose vehicle is entirely off screen", () => {
    const out = layoutLabels([veh("A", -400, 100), veh("B", 300, 300)], { viewport: VIEWS[0]!, obstacles: [] });
    expect(out.find((o) => o.id === "A")!.visible).toBe(false);
    expect(out.find((o) => o.id === "B")!.visible).toBe(true);
  });

  it("keeps a label inside the view for a vehicle poking out of an edge", () => {
    const [l] = check([veh("A", 1060, 300)], VIEWS[0]!);
    expect(l!.visible).toBe(true);
  });

  it("Aftermath: vehicle labels and measurement pills crowded near each other keep an 8 px gap, with leaders", () => {
    const bodies = [veh("A", 420, 280, 90, 60, 150), veh("B", 520, 300, 100, 56, 150)];
    const pill = (id: string, x: number, y: number): LabelRequest => ({ id, anchor: { x, y }, rect: { x, y, w: 0, h: 0 }, w: 130, h: 24, prefer: ["C"], maxDistance: 150 });
    const reqs = [...bodies, pill("m1", 500, 320), pill("m2", 505, 330), pill("m3", 510, 316), pill("m4", 480, 300)];
    for (const viewport of VIEWS) {
      const out = layoutLabels(reqs, { viewport, obstacles: bodies.map((b) => b.rect), gap: 8, step: 8 });
      const shown = out.filter((o) => o.visible);
      for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(rectsOverlap(shown[i]!, shown[j]!, 7.5), `${shown[i]!.id} / ${shown[j]!.id}`).toBe(false);
      for (const o of shown) {
        const r = reqs.find((q) => q.id === o.id)!;
        expect(o.distance).toBeLessThanOrEqual((r.maxDistance ?? LABEL_MAX_DISTANCE_PX) + 0.5);
        if (o.moved) expect(o.leader).not.toBeNull();
      }
    }
  });

  it("goes further (with a leader) to stay clear of the controls when nothing near is clear", () => {
    const body = veh("A", 150, 200, 40, 90, 140);
    // The controls reach 140 px above and below the car, across the whole width: the near ring is all blocked.
    const controls: Rect[] = [{ x: 0, y: 60, w: 390, h: 340 }];
    const near = layoutLabels([body], { viewport: VIEWS[1]!, obstacles: [body.rect], controls })[0]!;
    const far = layoutLabels([body], { viewport: VIEWS[1]!, obstacles: [body.rect], controls, farDistance: 150 })[0]!;
    expect(rectsOverlap(near, controls[0]!, 0)).toBe(true);          // no longer reach: it sits under a control, never over the body
    expect(rectsOverlap(near, body.rect, 0)).toBe(false);
    expect(rectsOverlap(far, controls[0]!, 0)).toBe(false);          // with it, it is clear of both
    expect(rectsOverlap(far, body.rect, 0)).toBe(false);
    expect(far.distance).toBeGreaterThan(LABEL_MAX_DISTANCE_PX);
    expect(far.distance).toBeLessThanOrEqual(150.5);
    expect(far.leader).not.toBeNull();
  });

  it("sits under a control before it covers a vehicle", () => {
    const body = veh("A", 150, 150, 60, 60, 140);
    // Controls fill everything but the vehicle itself: the label must overlap a control, not the body.
    const controls: Rect[] = [{ x: 0, y: 0, w: 390, h: 150 }, { x: 0, y: 210, w: 390, h: 210 }, { x: 0, y: 150, w: 150, h: 60 }, { x: 210, y: 150, w: 180, h: 60 }];
    const [o] = layoutLabels([body], { viewport: VIEWS[1]!, obstacles: [body.rect], controls });
    expect(rectsOverlap(o!, body.rect, 0)).toBe(false);
  });
});
