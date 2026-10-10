// The step 1 map: Leaflet through react-leaflet, the full OSM tiles from our proxy (street names,
// labels, landmarks), with the pin and the chosen streets drawn on top. Near full width on
// desktop; on a phone a compact map with "Expand map" that opens it full screen in a modal dialog.
// Pan is smooth; zoom is pinch, Ctrl/⌘ + wheel or the +/− buttons (a plain wheel scrolls the page);
// the keyboard pans and zooms the focused map. Coordinates are shown by the caller under the map.
// Tiles load only for the area in view. Attribution stays visible.
import L from "leaflet";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapContainer, useMap, useMapEvents } from "react-leaflet";
import type { RoadNetwork } from "@csd/core";
import { mapConfig } from "../config/map";
import { Icon } from "../icons/Icon";
import { resolveColor, tokenPx, usePhone } from "../lib/dom";
import { captureThumbnail, metersPerImagePixel, thumbnailCrop, type LoadedTile } from "../lib/thumbnail";
import { mapThumbnail } from "../services/thumbnail";
import type { PinHow } from "../state/doc";
import { BiasLayer, KeyboardLayer, PanLayer, ResizeLayer, StreetLayer, WheelZoomLayer, type MapBias } from "./mapLayers";
import { NorthArrow } from "./NorthArrow";
import { MapTiles, NEUTRAL_TILE_ATTR } from "./MapTiles";

const FALLBACK_PIN_PX = 32;
/** The icon's tip is this far above its bottom edge. */
const PIN_TIP_INSET_PX = 2;
/** Thumbnail capture: wait for tiles to settle, draw at this pixel ratio, and mark the pin with a dot and ring. */
const THUMB_DELAY_MS = 500;
const THUMB_SCALE = 2;
const THUMB_DOT_RADIUS_PX = 7;
const THUMB_RING_PX = 3;
/** Less than this much of the view around the pin isn't worth a picture: the PDF draws the road outline instead. */
const THUMB_MIN_SIDE_PX = 120;
/** Zoomed out further than this the map shows a city, not the place: the PDF draws the road outline instead. */
const THUMB_MIN_ZOOM = mapConfig.placeZoom - 3;
/** Wheel zoom lands on quarter levels; the tiles stay at whole levels. */
const ZOOM_SNAP = 0.25;
/** How long "Use Ctrl + scroll to zoom" stays up. */
const WHEEL_HINT_MS = 1600;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const WHEEL_HINT_TEXT = "Use Ctrl + scroll to zoom";

export interface MapPin { readonly lat: number; readonly lon: number }

export interface LocationMapProps {
  readonly pin: MapPin | null;
  /** Increase to recenter on the pin (after a search pick or the recenter button). */
  readonly focusSeq: number;
  /** Every placement by the claimant: a tap on the map, a drag of the pin, or the arrow keys on it. */
  readonly onPin: (lat: number, lon: number, how: PinHow) => void;
  /** The same placements without the "how", for callers that only need the point. */
  readonly onPick?: (lat: number, lon: number) => void;
  /** Recenter on this point whenever `seq` changes (a search pick that has no pin yet). */
  readonly center?: { readonly lat: number; readonly lon: number; readonly seq: number };
  /** Called when the view stops moving: where the map looks, for biasing search toward it. */
  readonly onBias?: (bias: MapBias) => void;
  /** Fixtures mode: cached tiles for the example areas, never a request to another origin. */
  readonly fixtures: boolean;
  /** The road data around the pin; the chosen streets are drawn from it. */
  readonly roads: RoadNetwork | null;
  /** Names of the chosen streets, highlighted under the pin. */
  readonly streets?: readonly string[];
  /** Open already expanded (a phone's "Open the map" before any place is set). */
  readonly startExpanded?: boolean;
}

function PinLayer({ pin, onPin }: { pin: MapPin; onPin: LocationMapProps["onPin"] }) {
  const map = useMap();
  const [host] = useState(() => document.createElement("div"));
  const marker = useRef<L.Marker | null>(null);
  const callback = useRef(onPin);
  useEffect(() => { callback.current = onPin; });

  useEffect(() => {
    const size = tokenPx("--size-pin", FALLBACK_PIN_PX);
    // The pin is anchored at its tip, so it sits on the point.
    const icon = L.divIcon({ html: host, className: "", iconSize: [size, size], iconAnchor: [size / 2, size - PIN_TIP_INSET_PX] });
    const m = L.marker([pin.lat, pin.lon], { draggable: true, icon, keyboard: true, title: "Impact pin", alt: "Impact pin" }).addTo(map);
    marker.current = m;
    m.on("dragend", () => { const p = m.getLatLng(); callback.current(p.lat, p.lng, "drag"); });
    const el = m.getElement();
    const onKey = (e: KeyboardEvent) => {
      const d = ({ ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] } as Record<string, [number, number]>)[e.key];
      if (!d) return;
      // The pin takes the arrow keys; the map does not pan with it.
      e.preventDefault();
      e.stopPropagation();
      const p = m.getLatLng();
      const meters = e.shiftKey ? mapConfig.nudgeShiftM : mapConfig.nudgeM;
      const lat = p.lat + (d[0] * meters) / mapConfig.metersPerDegLat;
      const lon = p.lng + (d[1] * meters) / (mapConfig.metersPerDegLat * Math.cos((p.lat * Math.PI) / 180));
      m.setLatLng([lat, lon]);
      callback.current(lat, lon, "keys");
    };
    el?.addEventListener("keydown", onKey);
    return () => { el?.removeEventListener("keydown", onKey); m.remove(); marker.current = null; };
    // The marker is created once per mount; later pin changes move it (next effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, host]);

  useEffect(() => {
    const m = marker.current;
    if (!m) return;
    const p = m.getLatLng();
    if (Math.abs(p.lat - pin.lat) > 1e-9 || Math.abs(p.lng - pin.lon) > 1e-9) m.setLatLng([pin.lat, pin.lon]);
  }, [pin.lat, pin.lon]);

  return createPortal(<div className="pin-marker"><Icon name="pin" /></div>, host);
}

function ClickLayer({ onPin }: { onPin: LocationMapProps["onPin"] }) {
  useMapEvents({ click: (e) => onPin(e.latlng.lat, e.latlng.lng, "tap") });
  return null;
}

function FocusLayer({ pin, seq, center }: { pin: MapPin | null; seq: number; center: LocationMapProps["center"] }) {
  const map = useMap();
  const last = useRef(seq);
  const lastCenter = useRef(center?.seq);
  useEffect(() => {
    if (seq !== last.current && pin) {
      last.current = seq;
      map.setView([pin.lat, pin.lon], Math.max(map.getZoom(), mapConfig.placeZoom - 1));
    }
  }, [seq, pin, map]);
  useEffect(() => {
    if (!center || center.seq === lastCenter.current) return;
    lastCenter.current = center.seq;
    map.setView([center.lat, center.lon], Math.max(map.getZoom(), mapConfig.placeZoom - 1));
  }, [center, map]);
  return null;
}

/** Copies the tiles already loaded in the view into a PNG for the PDF thumbnail, for the current pin only. */
function ThumbnailLayer({ pin: pinProp }: { pin: MapPin | null }) {
  const map = useMap();
  const lat = pinProp?.lat;
  const lon = pinProp?.lon;
  useEffect(() => {
    const pin = lat == null || lon == null ? null : { lat, lon };
    // A thumbnail of another pin is never kept.
    mapThumbnail.clear();
    let timer = 0;
    let off = false;
    let seq = 0;
    const capture = () => {
      // Every capture attempt, including the early clears below, overtakes any encode still in flight.
      const mine = ++seq;
      const container = map.getContainer();
      const box = container.getBoundingClientRect();
      if (!pin || !box.width || !box.height) return;
      if (map.getZoom() < THUMB_MIN_ZOOM) { mapThumbnail.clear(); return; }
      // Crop the view to the largest rectangle centered on the pin, so the pin is the middle of the picture.
      const p = map.latLngToContainerPoint([pin.lat, pin.lon]);
      const crop = thumbnailCrop({ w: box.width, h: box.height }, { x: p.x, y: p.y }, THUMB_MIN_SIDE_PX);
      if (!crop) { mapThumbnail.clear(); return; }
      const tiles: LoadedTile[] = [];
      for (const img of container.querySelectorAll<HTMLImageElement>(`img.leaflet-tile-loaded:not([${NEUTRAL_TILE_ATTR}])`)) {
        const r = img.getBoundingClientRect();
        tiles.push({ image: img, rect: { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height } });
      }
      // Whatever goes wrong (no context, no tiles, no blob, an error), the old thumbnail must not survive.
      void captureThumbnail({
        metersPerPixel: metersPerImagePixel(pin.lat, map.getZoom(), THUMB_SCALE),
        crop, tiles, pin: { x: p.x, y: p.y }, scale: THUMB_SCALE, dotRadius: THUMB_DOT_RADIUS_PX, ringWidth: THUMB_RING_PX,
        dotColor: resolveColor("--color-map-pin"), ringColor: resolveColor("--color-surface", "light"),
        createCanvas: (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; },
      }).then((bytes) => {
        if (off || mine !== seq) return;
        if (bytes) mapThumbnail.set(bytes, pin); else mapThumbnail.clear();
      });
    };
    const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(capture, THUMB_DELAY_MS); };
    map.on("moveend zoomend load", schedule);
    schedule();
    return () => { off = true; window.clearTimeout(timer); map.off("moveend zoomend load", schedule); };
  }, [map, lat, lon]);
  return null;
}


interface ViewProps extends LocationMapProps {
  readonly expanded: boolean;
  readonly phone: boolean;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly expandRef: React.RefObject<HTMLButtonElement | null>;
  readonly closeRef: React.RefObject<HTMLButtonElement | null>;
}

/** The map and everything drawn on or around it. It lives in one DOM node that moves between the page and the full-screen dialog. */
function MapView({ pin, focusSeq, onPin, onPick, center, onBias, fixtures, roads, streets, expanded, phone, onExpand, onCollapse, expandRef, closeRef }: ViewProps) {
  const [map, setMap] = useState<L.Map | null>(null);
  // The map opens where the pin is now; later pin moves are handled by the layers.
  const [start] = useState(pin);
  const [wheelHint, setWheelHint] = useState(false);
  const hintTimer = useRef(0);
  const keysId = useId();
  const compact = phone && !expanded;
  const placed = useCallback((lat: number, lon: number, how: PinHow) => { onPin(lat, lon, how); onPick?.(lat, lon); }, [onPin, onPick]);

  useEffect(() => () => { window.clearTimeout(hintTimer.current); }, []);
  const showHint = useCallback(() => {
    setWheelHint(true);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setWheelHint(false), WHEEL_HINT_MS);
  }, []);

  // data-zoom lets tests and screenshots read the zoom without a re-render per frame.
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!map) return;
    const write = () => { frame.current?.setAttribute("data-zoom", String(map.getZoom())); };
    write();
    map.on("zoom zoomend", write);
    return () => { map.off("zoom zoomend", write); };
  }, [map]);

  return (
    <div ref={frame} className="map-frame map-frame-lg" data-empty={pin ? undefined : "true"} data-expanded={expanded ? "true" : undefined} role="application" aria-label="Map. Drag the pin, or tap the map to move it.">
      {expanded ? (
        <button ref={closeRef} type="button" className="btn btn-secondary btn-sm map-close" onClick={onCollapse}><Icon name="close" className="icon-sm" /><span>Close map</span></button>
      ) : null}
      <MapContainer
        ref={setMap}
        className="map"
        center={start ? [start.lat, start.lon] : [39.5, -98.35]}
        zoom={start ? mapConfig.placeZoom : mapConfig.emptyZoom}
        zoomControl={false}
        attributionControl={false}
        scrollWheelZoom={false}
        keyboard={false}
        zoomSnap={ZOOM_SNAP}
        minZoom={mapConfig.minZoom}
        maxZoom={mapConfig.maxZoom}
      >
        <MapTiles fixtures={fixtures} roads={roads} />
        <StreetLayer roads={roads} names={streets ?? []} />
        <ClickLayer onPin={placed} />
        {pin ? <PinLayer pin={pin} onPin={placed} /> : null}
        <FocusLayer pin={pin} seq={focusSeq} center={center} />
        <WheelZoomLayer onPlainWheel={showHint} />
        <KeyboardLayer describedBy={keysId} />
        <ResizeLayer />
        <PanLayer enabled={!compact} />
        <BiasLayer onBias={onBias} />
        <ThumbnailLayer pin={pin} />
      </MapContainer>
      <p id={keysId} className="visually-hidden">Arrow keys pan the map. Plus and minus zoom. Tab to the pin, then the arrow keys move it.</p>
      {pin ? (
        <p className="map-hint"><Icon name="pin" className="icon-sm" /><span>{compact ? "Drag the pin to move it" : "Drag the pin to where the vehicles hit"}</span></p>
      ) : (
        <div className="map-empty"><Icon name="pin" className="icon-lg" /><p>Search for the place, or tap the map to drop the pin.</p></div>
      )}
      <p className="map-wheel-hint" data-show={wheelHint ? "true" : "false"} aria-hidden="true">{WHEEL_HINT_TEXT}</p>
      <p className="map-attrib"><a href={mapConfig.attributionUrl} target="_blank" rel="noopener noreferrer">{mapConfig.attribution}</a></p>
      <NorthArrow />
      <div className="map-tools" role="group" aria-label="Map controls">
        <button className="map-tool" type="button" aria-label="Zoom in" onClick={() => map?.zoomIn()}><Icon name="plus" /></button>
        <button className="map-tool" type="button" aria-label="Zoom out" onClick={() => map?.zoomOut()}><Icon name="minus" /></button>
        <button className="map-tool" type="button" aria-label="Center on the pin" disabled={!pin} onClick={() => { if (pin) map?.setView([pin.lat, pin.lon], Math.max(map.getZoom(), mapConfig.placeZoom - 1)); }}><Icon name="crosshair" /></button>
      </div>
      {compact ? (
        <button ref={expandRef} type="button" className="btn btn-secondary btn-sm map-expand" onClick={onExpand}>Expand map</button>
      ) : null}
    </div>
  );
}

/** The full-screen map: a modal dialog, so Esc closes it and Tab stays inside it. */
function MapDialog({ onClose, bodyRef }: { onClose: () => void; bodyRef: (el: HTMLDivElement | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  // A layout effect, so the dialog is open before the map's own layout effects move focus into it.
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    // The map is moved into the dialog from outside React's tree, so its keys reach us as DOM events.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close.current(); return; }
      if (e.key !== "Tab") return;
      const items = Array.from(d.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    d.addEventListener("keydown", onKeyDown);
    return () => {
      d.removeEventListener("keydown", onKeyDown);
      if (d.open && typeof d.close === "function") d.close(); else d.removeAttribute("open");
    };
  }, []);
  return (
    <dialog ref={ref} className="map-dialog" aria-label="Map" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <div className="map-dialog-body" ref={bodyRef} />
    </dialog>
  );
}

export function LocationMap(props: LocationMapProps) {
  const phone = usePhone();
  const [expanded, setExpanded] = useState(props.startExpanded === true);
  // One DOM node holds the map; it moves between the page's slot and the dialog, so the view, the
  // loaded tiles and the thumbnail capture carry over untouched.
  const [host] = useState(() => { const d = document.createElement("div"); d.className = "map-host"; return d; });
  const slot = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  const wantExpanded = useRef(expanded);
  const [slotHeight, setSlotHeight] = useState<number | null>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  const place = useCallback(() => {
    const target = wantExpanded.current ? body.current : slot.current;
    if (target && host.parentElement !== target) target.append(host);
  }, [host]);
  const slotRef = useCallback((el: HTMLDivElement | null) => { slot.current = el; place(); }, [place]);
  const bodyRef = useCallback((el: HTMLDivElement | null) => { body.current = el; place(); }, [place]);

  const expand = () => {
    // The page keeps the map's room while the map is full screen, so it doesn't jump on return.
    setSlotHeight(slot.current?.getBoundingClientRect().height ?? null);
    wantExpanded.current = true;
    setExpanded(true);
  };
  const collapse = () => { wantExpanded.current = false; returnFocus.current = true; setExpanded(false); };

  useLayoutEffect(() => {
    place();
    if (expanded) closeRef.current?.focus();
    else if (returnFocus.current) { returnFocus.current = false; expandRef.current?.focus(); }
  }, [expanded, place]);

  return (
    <>
      <div className="map-slot" ref={slotRef} style={expanded && slotHeight ? { height: slotHeight } : undefined} />
      {expanded ? <MapDialog onClose={collapse} bodyRef={bodyRef} /> : null}
      {createPortal(<MapView {...props} expanded={expanded} phone={phone} onExpand={expand} onCollapse={collapse} expandRef={expandRef} closeRef={closeRef} />, host)}
    </>
  );
}
