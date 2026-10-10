// Street names laid flat on the road surface, one per named street in view, in the label token color.
// The text is drawn once per name into a small canvas texture (no font file or network beyond the app's
// own bundled font). core's placeStreetNames picks the spots, so no two names overlap and none lies
// across a junction, under the vehicles or outside the part of the ground the camera shows; the choice is
// made again whenever the camera comes to rest somewhere new.
import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { CanvasTexture, SRGBColorSpace, Vector3, type Camera } from "three";
import { placeStreetNames, streetNameSpots, type NameSpot, type PlacedName, type RoadArt, type Vec2 } from "@csd/core";
import { LIFT, type GroundSurface } from "./scene-geometry";
import type { SceneColors } from "./tokens";

/** Street names are painted this tall, m, as a share of the width of the view; no taller than this share of the road width. */
const TEXT_OF_VIEW = 0.024;
const MIN_TEXT_M = 0.7;
const MAX_TEXT_M = 2.6;
const TEXT_SHARE = 0.42;
/** Smaller sizes tried when the full size doesn't fit. */
const SIZE_STEPS = [1, 0.78, 0.6];
const FONT_PX = 64;
const PAD_PX = 12;
const TRACK_PX = 6;
/** Names stay this far inside the edge of the view (share of half the screen), clear of the controls and edges. */
const VIEW_INSET = 0.86;
/** The camera has to hold still this long before names are placed again, ms. */
const SETTLE_MS = 250;
/** How far along the ground a ray that never meets it (above the horizon) is taken, m. */
const FAR_M = 600;

export interface Label { readonly canvas: HTMLCanvasElement; readonly texture: CanvasTexture; readonly aspect: number }

export function drawLabel(text: string, font: string, color: string): Label | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const upper = text.toUpperCase();
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(upper).width + TRACK_PX * (upper.length - 1) + PAD_PX * 2);
  canvas.width = w;
  canvas.height = FONT_PX + PAD_PX;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${TRACK_PX}px`;
  ctx.fillText(upper, PAD_PX, canvas.height / 2);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return { canvas, texture, aspect: (w - PAD_PX * 2) / FONT_PX };
}

/** The part of the ground plane the camera shows, as a polygon in the local frame (x east, y north). */
export function groundInView(camera: Camera, groundY: number, scratch: readonly [Vector3, Vector3, Vector3]): Vec2[] {
  const [near, dir, eye] = scratch;
  eye.setFromMatrixPosition(camera.matrixWorld);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    near.set(sx! * VIEW_INSET, sy! * VIEW_INSET, 0.5).unproject(camera);
    dir.copy(near).sub(eye).normalize();
    // A ray that never meets the ground (above the horizon) is cut off FAR_M along it.
    const t = dir.y < -1e-3 ? Math.min((groundY - eye.y) / dir.y, FAR_M) : FAR_M;
    return { x: eye.x + dir.x * t, y: -(eye.z + dir.z * t) };
  });
}

/**
 * Where the names go for a view: core picks spots whose whole text lies inside `view` (the ground the camera shows),
 * at a size that follows the width of that view. Used for the live camera and for the export stills' own cameras.
 */
export function placeNamesInView(spots: readonly NameSpot[], aspectOf: (name: string) => number | undefined, view: readonly Vec2[], focus: Vec2, avoid: readonly Vec2[]): PlacedName[] {
  // About the width of the view across: the size that reads well on screen follows it.
  const xs = view.map((p) => p.x), ys = view.map((p) => p.y);
  const span = Math.sqrt((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)));
  const base = Math.min(MAX_TEXT_M, Math.max(MIN_TEXT_M, span * TEXT_OF_VIEW));
  return placeStreetNames(spots, (name, width) => SIZE_STEPS.map((k) => {
    const heightM = Math.min(base, width * TEXT_SHARE) * k;
    return { heightM, lengthM: heightM * (aspectOf(name) ?? name.length * 0.7) };
  }), focus, { avoid, inside: view });
}

export function StreetNames({ art, ground, focus, avoid, colors }: { art: RoadArt | null; ground: GroundSurface; focus: Vec2; avoid: readonly Vec2[]; colors: SceneColors }) {
  const camera = useThree((s) => s.camera);
  const family = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim() || "sans-serif", []);
  const weight = useMemo(() => getComputedStyle(document.documentElement).getPropertyValue("--weight-bold").trim() || "700", []);
  const font = `${weight} ${FONT_PX}px ${family}`;
  const color = colors.css["--color-scene-label"];

  // The bundled font may still be loading when the first labels are drawn: draw again once it is there.
  const [fontReady, setFontReady] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.load(font).then(() => { if (live) setFontReady((n) => n + 1); }).catch(() => undefined);
    return () => { live = false; };
  }, [font]);

  const spots = useMemo(() => (art ? streetNameSpots(art, focus) : []), [art, focus]);
  const labels = useMemo(() => {
    void fontReady;
    const made = new Map<string, Label>();
    for (const name of new Set(spots.map((s) => s.name))) { const l = drawLabel(name, font, color); if (l) made.set(name, l); }
    return made;
  }, [spots, font, color, fontReady]);
  useEffect(() => () => labels.forEach((l) => l.texture.dispose()), [labels]);

  // Where the camera has come to rest: the ground in view, re-read once it holds still.
  const scratch = useMemo((): [Vector3, Vector3, Vector3] => [new Vector3(), new Vector3(), new Vector3()], []);
  const [view, setView] = useState<Vec2[] | null>(null);
  const seen = useRef<{ key: string; since: number; shown: string; pose: Float32Array; moved: boolean; quad: Vec2[] }>({ key: "", since: 0, shown: "", pose: new Float32Array(18), moved: true, quad: [] });
  useFrame(() => {
    const s = seen.current;
    // Nothing is worked out while the camera isn't moving: compare its pose first.
    const m = camera.matrixWorld.elements, pose = s.pose;
    let same = pose[16] === Math.fround((camera as { aspect?: number }).aspect ?? 0) && pose[17] === Math.fround(camera.projectionMatrix.elements[5]!);
    for (let i = 0; i < 16 && same; i++) if (pose[i] !== Math.fround(m[i]!)) same = false;
    if (same && !s.moved) {
      if (s.key !== s.shown && performance.now() - s.since >= SETTLE_MS) { s.shown = s.key; setView(s.quad); }
      return;
    }
    for (let i = 0; i < 16; i++) pose[i] = m[i]!;
    pose[16] = (camera as { aspect?: number }).aspect ?? 0; pose[17] = camera.projectionMatrix.elements[5]!;
    s.moved = false;
    s.quad = groundInView(camera, ground.heightAt(focus), scratch);
    const key = s.quad.map((p) => `${Math.round(p.x / 2)},${Math.round(p.y / 2)}`).join("|");
    if (key !== s.key) { s.key = key; s.since = performance.now(); }
  });

  const placed = useMemo(() => (view ? placeNamesInView(spots, (name) => labels.get(name)?.aspect, view, focus, avoid) : []), [view, spots, labels, focus, avoid]);

  return (
    <group name="street-names">
      {placed.flatMap((p) => {
        const l = labels.get(p.name);
        if (!l) return [];
        const planeH = p.heightM * (l.canvas.height / FONT_PX), planeW = p.heightM * (l.canvas.width / FONT_PX);
        return [(
          <mesh key={`${p.name}-${p.at.x.toFixed(1)}-${p.at.y.toFixed(1)}`} position={[p.at.x, ground.heightAt(p.at) + LIFT.paint + 0.04, -p.at.y]} rotation={[-Math.PI / 2, 0, p.angleRad]}>
            <planeGeometry args={[planeW, planeH]} />
            <meshBasicMaterial map={l.texture} transparent depthWrite={false} toneMapped={false} />
          </mesh>
        )];
      })}
    </group>
  );
}
