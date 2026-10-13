import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import { FEATURE_NAMES, featureDescription, featureIcon, toLatLon, type RoadFeature, type RoadNetwork } from "@csd/core";
import { Icon } from "../icons/Icon";
import { tokenPx } from "../lib/dom";

function FeatureMarker({ map, net, features }: { map: L.Map; net: RoadNetwork; features: readonly RoadFeature[] }) {
  const [host] = useState(() => document.createElement("div"));
  const first = features[0]!;
  useEffect(() => {
    const p = toLatLon(net.frame, first.position);
    const size = tokenPx("--size-icon-sm", 16);
    const icon = L.divIcon({ html: host, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    const marker = L.marker([p.lat, p.lon], { icon, interactive: false, keyboard: false }).addTo(map);
    return () => { marker.remove(); };
  }, [map, net, first, host]);
  return createPortal(<span className="road-feature-marker" role="img" aria-label={features.map(featureDescription).join(" ")} title={features.map(featureDescription).join(" ")}>{features.map((f) => <span key={f.id} style={{ transform: f.kind === "oneway" && f.facingDeg !== null ? `rotate(${f.facingDeg - 90}deg)` : undefined }}><Icon name={featureIcon(f.kind)} className="icon-sm" /></span>)}</span>, host);
}
export function MapRoadFeatures({ map, roads }: { map: L.Map; roads: RoadNetwork }) {
  const groups = new Map<string, RoadFeature[]>();
  for (const f of roads.features ?? []) {
    const key = `${f.source}-${f.osmId}`;
    const group = groups.get(key) ?? [];
    group.push(f); groups.set(key, group);
  }
  return <>{[...groups.entries()].map(([id, features]) => <FeatureMarker key={id} map={map} net={roads} features={features} />)}</>;
}
export function FeatureLegend({ roads }: { roads: RoadNetwork | null }) {
  const kinds = [...new Set(roads?.features?.map((f) => f.kind) ?? [])];
  if (!kinds.length) return null;
  return <details className="feature-legend"><summary>Road features from OpenStreetMap</summary>
    <p className="hint">Only tagged features are shown. Signal colors at the time are unknown. Road annotations do not mark sign positions. Missing tags mean unknown.</p>
    <ul>{kinds.map((kind) => <li key={kind}><Icon name={featureIcon(kind)} className="icon-sm" />{FEATURE_NAMES[kind]}</li>)}</ul>
    <ul className="feature-road-tags">{roads?.features?.filter((f) => f.source === "way" && f.kind !== "crosswalk").map((f) => <li key={f.id}>{f.label}</li>)}</ul>
  </details>;
}
