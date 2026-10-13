import { iconStrokes } from "@csd/core/icon-strokes";
import type { Prim, Pt } from "./draw";
export function iconPrims(name: string, x: number, y: number, size: number, ink: string, rotationDeg = 0): Prim[] {
  const a = rotationDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return (iconStrokes[name] ?? []).map((line) => ({ k: "poly", pts: line.map((p): Pt => {
    const dx = (p[0]! - 12) * size / 24, dy = (p[1]! - 12) * size / 24;
    return [x + size / 2 + dx * c - dy * s, y + size / 2 + dx * s + dy * c];
  }), stroke: { color: ink, width: size / 12, cap: "round", join: "round" } }));
}
