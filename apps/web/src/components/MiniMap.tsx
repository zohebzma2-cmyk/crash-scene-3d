// Vehicles step: the pin plus each vehicle's silhouette where it came from, pointing the way it was
// facing. Positions come from placeVehicles (lane paths), so vehicles sit on their lanes, never on
// buildings and never on top of each other. Labels use collision avoidance with a leader line.
import L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MapContainer } from "react-leaflet";
import { PRESETS, goingWords, vehicleTag, type RoadNetwork, type Scene, type SceneVehicle } from "@csd/core";
import { mapConfig } from "../config/map";
import { Icon } from "../icons/Icon";
import { layoutMiniMap, metersPerPixel, type MiniVehiclePlacement } from "../lib/miniMapLayout";
import { placeLabels, type LabelRequest } from "../lib/labels";
import { tokenPx } from "../lib/dom";
import { useServices } from "../services/context";
import { useDoc } from "../state/DocProvider";
import { unansweredOf } from "../state/doc";
import { useRoads } from "../state/Roads";
import { MapTiles } from "./MapTiles";
import { NorthArrow } from "./NorthArrow";
import { ucFirst } from "../lib/text";
import { paintStyle } from "../lib/paint";
import { FeatureLegend, MapRoadFeatures } from "./RoadFeatures";

const FALLBACK_MARKER_PX = 44;
const FALLBACK_PIN_PX = 32;
const PIN_TIP_INSET_PX = 2;
const LABEL_H = 28;
const LABEL_CHAR_PX = 7;
const LABEL_PAD = 40;
const NORTH_GUTTER_PX = 12;

const markerPx = (): number => tokenPx("--size-touch", FALLBACK_MARKER_PX);

function VehicleMarker({ map, lat, lon, vehicle, heading }: { map: L.Map; lat: number; lon: number; vehicle: SceneVehicle; heading: number }) {
  const [host] = useState(() => document.createElement("div"));
  const ref = useRef<L.Marker | null>(null);
  useEffect(() => {
    const px = markerPx();
    const icon = L.divIcon({ html: host, className: "", iconSize: [px, px], iconAnchor: [px / 2, px / 2] });
    const m = L.marker([lat, lon], { icon, interactive: false, keyboard: false }).addTo(map);
    ref.current = m;
    return () => { m.remove(); ref.current = null; };
    // Created once; position updates below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, host]);
  useEffect(() => { ref.current?.setLatLng([lat, lon]); }, [lat, lon]);
  return createPortal(
    <div className={`veh-marker v-${vehicle.id.toLowerCase()}`} style={paintStyle(vehicle)} data-paint={vehicle.color?.hex ?? ""}>
      <span className="veh-icon" style={{ rotate: `${heading}deg` }}><Icon name={PRESETS[vehicle.type].icon} /></span>
      <b>{vehicle.id}</b>
    </div>,
    host,
  );
}

/** Under the mini map until every vehicle's details are in (they are drawn then). */
export const MINI_WAITING_TEXT = "The vehicles show here once each one's details are picked.";

export function MiniMap({ scene }: { scene: Scene }) {
  const { doc } = useDoc();
  const { physics, mode } = useServices();
  const roads = useRoads();
  const [map, setMap] = useState<L.Map | null>(null);
  const [, setTick] = useState(0);
  const { lat, lon } = scene.location;
  const located = doc.located;
  const net: RoadNetwork | null = roads.net;

  useEffect(() => {
    if (!map) return;
    const on = () => setTick((t) => t + 1);
    map.on("move zoom resize", on);
    return () => { map.off("move zoom resize", on); };
  }, [map]);

  // Re-center only when the pin itself moves, so the claimant's own panning is kept.
  const centered = useRef("");
  useEffect(() => {
    if (!map || !located) return;
    const key = `${lat},${lon}`;
    if (centered.current === key) return;
    centered.current = key;
    map.setView([lat, lon], mapConfig.placeZoom, { animate: false });
  }, [map, located, lat, lon]);

  // Every direction picked and every detail answered (a parked vehicle has no speed): only then is a placement problem
  // about the claimant's own answers rather than a placeholder.
  const allPicked = doc.directionSet.every(Boolean) && scene.vehicles.every((v, i) => unansweredOf(doc, i).every((f) => f === "speed" && v.action === "parked"));
  const layout = useMemo(() => {
    if (!located) return null;
    try {
      const frame = net?.frame ?? { origin: { lat, lon } };
      const pin = net ? physics.toLocal(net.frame, { lat, lon }) : { x: 0, y: 0 };
      const placed = physics.placeVehicles(scene, net, pin);
      // A message about a vehicle whose direction hasn't been picked yet would be about a placeholder bearing: say nothing.
      if (!placed.ok) return { frame, pin, items: [] as MiniVehiclePlacement[], error: allPicked ? (placed.errors[0]?.text ?? null) : null };
      const items = layoutMiniMap({
        pin,
        vehicles: placed.vehicles.map((p) => ({ id: p.id, path: p.path?.points ?? null, impact: { x: p.impactPose.xM, y: p.impactPose.yM }, headingDeg: (p.impactPose.headingRad * 180) / Math.PI })),
        buildings: net?.buildings.map((b) => b.footprint) ?? [],
        mPerPx: metersPerPixel(lat, mapConfig.placeZoom),
        markerPx: markerPx(),
      });
      return { frame, pin, items, error: null };
    } catch {
      return null;
    }
  }, [located, scene, net, physics, lat, lon, allPicked]);

  // The vehicles are drawn once every one of them is answered: where each sits depends on all of them (directions, hit
  // sides, types), and an unanswered one is only a placeholder.
  const markers = layout?.items.map((it) => {
    const at = scene.vehicles.findIndex((x) => x.id === it.id);
    const v = allPicked ? scene.vehicles[at] : undefined;
    const ll = layout ? physics.toLatLon(layout.frame, it.pos) : null;
    return v && ll ? { it, v, ll } : null;
  }).filter((m): m is NonNullable<typeof m> => m != null) ?? [];

  // Label positions in screen pixels, after collision avoidance.
  let labels: Array<{ id: string; text: string; x: number; y: number; leader: { x1: number; y1: number; x2: number; y2: number } | null }> = [];
  if (map && located && markers.length) {
    const size = map.getSize();
    const px = markerPx();
    const pinPx = tokenPx("--size-pin", FALLBACK_PIN_PX);
    const anchors = markers.map(({ v, ll }) => {
      const p = map.latLngToContainerPoint([ll.lat, ll.lon]);
      // Core's one label: "A · Your car · Northbound", "B · Other car · Heading northwest".
      const text = vehicleTag(v, ucFirst(goingWords(v.travel.bearingDeg)));
      return { id: v.id, text, x: p.x, y: p.y };
    });
    const pinPt = map.latLngToContainerPoint([lat, lon]);
    const requests: LabelRequest[] = anchors.map((a) => ({ id: a.id, anchor: { x: a.x, y: a.y }, w: a.text.length * LABEL_CHAR_PX + LABEL_PAD, h: LABEL_H, clearance: px / 2 + 2 }));
    // The north arrow (top right, one touch target in from the edge) is kept clear like the markers.
    const gutter = tokenPx("--space-3", NORTH_GUTTER_PX);
    const north = { x: size.x - gutter - px, y: gutter, w: px, h: px };
    const obstacles = [...anchors.map((a) => ({ x: a.x - px / 2, y: a.y - px / 2, w: px, h: px })), { x: pinPt.x - pinPx / 2, y: pinPt.y - pinPx, w: pinPx, h: pinPx }, north];
    const placed = placeLabels(requests, { bounds: { w: size.x, h: size.y }, obstacles });
    labels = anchors.map((a) => {
      const pl = placed.find((p) => p.id === a.id);
      return { id: a.id, text: a.text, x: pl?.x ?? a.x, y: pl?.y ?? a.y, leader: pl?.leader ?? null };
    });
  }

  return (
    <>
    <div className="map-frame map-frame-sm">
      <MapContainer
        ref={setMap}
        className="map map-sm"
        center={[lat, lon]}
        zoom={located ? mapConfig.placeZoom : mapConfig.emptyZoom}
        zoomControl={false}
        attributionControl={false}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        touchZoom={false}
        boxZoom={false}
        keyboard={false}
        maxZoom={mapConfig.placeZoom}
        minZoom={mapConfig.placeZoom}
        aria-label="Map showing where each vehicle was going"
      >
        <MapTiles fixtures={mode === "fixtures"} roads={net} />
        {map && net ? <MapRoadFeatures map={map} roads={net} /> : null}
        {located && map ? <PinMarker map={map} lat={lat} lon={lon} /> : null}
        {located && map ? markers.map(({ it, v, ll }) => <VehicleMarker key={v.id} map={map} lat={ll.lat} lon={ll.lon} vehicle={v} heading={it.headingDeg} />) : null}
      </MapContainer>
      {located ? (
        <div className="mini-labels" aria-hidden="true">
          <svg className="mini-leaders">
            {labels.filter((l) => l.leader).map((l) => <line key={l.id} x1={l.leader?.x1} y1={l.leader?.y1} x2={l.leader?.x2} y2={l.leader?.y2} className={`mini-leader v-${l.id.toLowerCase()}`} />)}
          </svg>
          {labels.map((l) => <span key={l.id} className={`mlabel v-${l.id.toLowerCase()}`} style={{ left: l.x, top: l.y }}>{l.text}</span>)}
        </div>
      ) : (
        <div className="map-empty"><Icon name="pin" className="icon-lg" /><p>Set the place in step 1 to see the vehicles on the map.</p></div>
      )}
      <NorthArrow />
      <p className="map-attrib"><a href={mapConfig.attributionUrl} target="_blank" rel="noopener noreferrer">{mapConfig.attribution}</a></p>
    </div>
    {layout?.error ? <p className="mini-note" role="status">{layout.error}</p> : located && !allPicked ? <p className="mini-note">{MINI_WAITING_TEXT}</p> : null}
    <FeatureLegend roads={net} />
    </>
  );
}

function PinMarker({ map, lat, lon }: { map: L.Map; lat: number; lon: number }) {
  const [host] = useState(() => document.createElement("div"));
  const ref = useRef<L.Marker | null>(null);
  useEffect(() => {
    const size = tokenPx("--size-pin", FALLBACK_PIN_PX);
    const icon = L.divIcon({ html: host, className: "", iconSize: [size, size], iconAnchor: [size / 2, size - PIN_TIP_INSET_PX] });
    const m = L.marker([lat, lon], { icon, interactive: false, keyboard: false }).addTo(map);
    ref.current = m;
    return () => { m.remove(); ref.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, host]);
  useEffect(() => { ref.current?.setLatLng([lat, lon]); }, [lat, lon]);
  return createPortal(<div className="pin-marker"><Icon name="pin" /></div>, host);
}
