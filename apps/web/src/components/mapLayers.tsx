// Behaviours that sit on the Location map's Leaflet instance: Ctrl/⌘ + wheel and pinch zoom, the
// "use Ctrl + scroll" hint, keyboard pan and zoom, resize handling, panning that can be switched
// off (a compact phone map lets the page scroll), the view's bias point, and the highlighted streets.
import L from "leaflet";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import type { RoadNetwork } from "@csd/core";
import { tokenPx } from "../lib/dom";
import { clampZoom, mapKeyAction, wheelZoomDelta } from "../lib/mapZoom";
import { useServices } from "../services/context";

const FALLBACK_STREET_LINE_PX = 6;
const FALLBACK_STREET_HALO_PX = 14;

/**
 * A plain wheel scrolls the page and only tells the claimant how to zoom; Ctrl or ⌘ + wheel zooms
 * around the pointer (a trackpad pinch arrives the same way). Safari's pinch comes as gesture events.
 */
export function WheelZoomLayer({ onPlainWheel }: { onPlainWheel: () => void }) {
  const map = useMap();
  const callback = useRef(onPlainWheel);
  useEffect(() => { callback.current = onPlainWheel; });
  useEffect(() => {
    const el = map.getContainer();
    // The zoom we are heading for, kept as a fraction so tiny pinch steps add up.
    let target = map.getZoom();
    let applied = target;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) { callback.current(); return; }
      e.preventDefault();
      if (Math.abs(map.getZoom() - applied) > 0.01) target = map.getZoom();
      target = clampZoom(target + wheelZoomDelta(e), map.getMinZoom(), map.getMaxZoom());
      map.setZoomAround(map.mouseEventToContainerPoint(e), target, { animate: false });
      applied = map.getZoom();
    };
    let startZoom = map.getZoom();
    const onGestureStart = (e: Event) => { e.preventDefault(); startZoom = map.getZoom(); };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as Event & { scale?: number }).scale;
      if (typeof scale !== "number" || !(scale > 0)) return;
      map.setZoom(clampZoom(startZoom + Math.log2(scale), map.getMinZoom(), map.getMaxZoom()), { animate: false });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [map]);
  return null;
}

/** Arrow keys pan and +/− zoom while the map itself has focus (the pin has its own arrow-key nudge). */
export function KeyboardLayer({ describedBy }: { describedBy: string }) {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    el.tabIndex = 0;
    el.setAttribute("aria-describedby", describedBy);
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== el) return;
      const action = mapKeyAction(e);
      if (!action) return;
      e.preventDefault();
      if (action.kind === "pan") map.panBy([action.dx, action.dy]);
      else if (action.delta > 0) map.zoomIn();
      else map.zoomOut();
    };
    el.addEventListener("keydown", onKey);
    return () => { el.removeEventListener("keydown", onKey); el.removeAttribute("tabindex"); el.removeAttribute("aria-describedby"); };
  }, [map, describedBy]);
  return null;
}

/** The map follows its container's size (the expanded map, a rotated phone, a resized window). */
export function ResizeLayer() {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => { map.invalidateSize(); });
    ro.observe(map.getContainer());
    return () => { ro.disconnect(); };
  }, [map]);
  return null;
}

/** Dragging the map can be switched off, so a one-finger swipe on a compact phone map scrolls the page. */
export function PanLayer({ enabled }: { enabled: boolean }) {
  const map = useMap();
  useEffect(() => {
    if (enabled) map.dragging.enable(); else map.dragging.disable();
  }, [map, enabled]);
  return null;
}

export interface MapBias { readonly lat: number; readonly lon: number; readonly zoom: number }

/** Reports where the map is looking, for search to bias its suggestions toward the view. */
export function BiasLayer({ onBias }: { onBias?: ((bias: MapBias) => void) | undefined }) {
  const map = useMap();
  const callback = useRef(onBias);
  useEffect(() => { callback.current = onBias; });
  useEffect(() => {
    const report = () => { const c = map.getCenter(); callback.current?.({ lat: c.lat, lon: c.lng, zoom: map.getZoom() }); };
    map.on("moveend", report);
    return () => { map.off("moveend", report); };
  }, [map]);
  return null;
}

/** The chosen streets, drawn from the road data: a white halo under a colored line, below the pin. */
export function StreetLayer({ roads, names }: { roads: RoadNetwork | null; names: readonly string[] }) {
  const map = useMap();
  const { physics } = useServices();
  const key = names.join("\n");
  useEffect(() => {
    if (!roads || key === "") return;
    const wanted = new Set(key.split("\n"));
    const lines = roads.ways
      .filter((w) => w.name != null && wanted.has(w.name))
      .map((w) => w.centerline.map((v) => { const p = physics.toLatLon(roads.frame, v); return [p.lat, p.lon] as [number, number]; }));
    if (lines.length === 0) return;
    const group = L.layerGroup().addTo(map);
    const common = { interactive: false, lineCap: "round", lineJoin: "round" } as const;
    const halo = tokenPx("--size-street-halo", FALLBACK_STREET_HALO_PX);
    const line = tokenPx("--size-street-line", FALLBACK_STREET_LINE_PX);
    for (const pts of lines) L.polyline(pts, { ...common, className: "map-street-halo", weight: halo }).addTo(group);
    for (const pts of lines) L.polyline(pts, { ...common, className: "map-street", weight: line }).addTo(group);
    return () => { group.remove(); };
  }, [roads, key, map, physics]);
  return null;
}
