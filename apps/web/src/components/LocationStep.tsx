// Step 1: where did it happen? Search, the map and pin, the kind of place, when, and the road.
import { useEffect, useState } from "react";
import { PLACE_KINDS, ROAD_CONDITIONS, type LatLon, type PlaceKind, type RoadCondition, type RoadNetwork } from "@csd/core";
import { RadioGroup } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { usePhone } from "../lib/dom";
import { useServices } from "../services/context";
import { useDoc } from "../state/DocProvider";
import { useFlow } from "../state/Flow";
import { useRoads } from "../state/Roads";
import { useUi } from "../state/Ui";
import { LocationMap } from "./LocationMap";
import type { MapBias } from "./mapLayers";
import { SearchPanel } from "./SearchPanel";
import { Tips } from "../tips/Tips";
import { Tile } from "./Tile";
import { CLAIM_NUMBER_MAX, sanitizeClaimNumber } from "../lib/claim";
import { GatePanel } from "./Warnings";
import { SceneQuestions } from "./questions/SceneQuestions";

/** A view zoomed out further than this is not a place to bias a search toward. */
const VIEW_BIAS_MIN_ZOOM = 9;

const PLACE_TILES: Record<PlaceKind, { icon: string; label: string }> = {
  intersection: { icon: "place-intersection", label: "Intersection" },
  road: { icon: "place-road", label: "Road" },
  parking: { icon: "place-parking", label: "Parking lot" },
};
const ROAD_TILES: Record<RoadCondition, { icon: string; label: string }> = {
  dry: { icon: "road-dry", label: "Dry" },
  wet: { icon: "road-wet", label: "Wet" },
  snow: { icon: "road-snow", label: "Snow" },
  ice: { icon: "road-ice", label: "Ice" },
};

export function streetNames(streets: { roads: ReadonlyArray<{ name: string | null }> } | null): string[] {
  const seen = new Set<string>();
  for (const r of streets?.roads ?? []) if (r.name) seen.add(r.name);
  return [...seen];
}

function StreetsHere() {
  const roads = useRoads();
  const names = streetNames(roads.streets);
  let text: string;
  switch (roads.status) {
    case "idle": return null;
    case "loading": text = "Looking up the roads at the pin…"; break;
    case "ready": text = names.length ? `Streets at the pin: ${new Intl.ListFormat("en", { type: "conjunction" }).format(names)}` : "We found roads here, but none with a name at the pin."; break;
    case "none": text = "We couldn't find a road at the pin. Move the pin onto a road, or carry on and pick each direction yourself."; break;
    case "error": text = roads.message ?? "We couldn't load the roads here."; break;
  }
  return <p className="streets-here" aria-live="polite">{text}</p>;
}

export function LocationStep() {
  const { doc, dispatch } = useDoc();
  const { scene, located } = doc;
  const services = useServices();
  const roads = useRoads();
  const flow = useFlow();
  const phone = usePhone();
  const [focusSeq, setFocusSeq] = useState(0);
  const [mapOpen, setMapOpen] = useState(false);
  const { highlight } = useUi();
  // Where a search pick sends the map (a street pick has no pin yet), and where the map is looking.
  const [panTo, setPanTo] = useState<{ lat: number; lon: number; seq: number } | null>(null);
  const [view, setView] = useState<LatLon | null>(null);
  // A street picked in search is drawn before there is a pin: its roads load around the pick.
  const [preview, setPreview] = useState<RoadNetwork | null>(null);
  const loc = scene.location;
  const names = highlight.length ? highlight : streetNames(roads.streets);
  const drawn = roads.net ?? preview;
  const pin = located ? { lat: loc.lat, lon: loc.lon } : null;
  // On a phone, a big empty map would push the form down. Show a compact note until a place is set.
  const compact = phone && !located && !mapOpen;
  const panSeq = panTo?.seq;
  const panLat = panTo?.lat;
  const panLon = panTo?.lon;
  useEffect(() => {
    if (!highlight.length || located || panLat == null || panLon == null) return;
    let off = false;
    services.roads.load({ lat: panLat, lon: panLon }).then((n) => { if (!off) setPreview(n); }, () => undefined);
    return () => { off = true; };
    // One load per pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panSeq, highlight.length, located]);
  const coordsLabel = !located ? "No pin yet" : loc.source === "pin" ? "Pin placed by you" : loc.label ? `From search: ${loc.label.split(",").slice(0, 2).join(",")}` : "Pin";
  return (
    <section aria-labelledby="h-location">
      <div className="split split-location">
        <div className="split-head">
          <h1 className="title" id="h-location">Where did it happen?</h1>
          <p className="lede">Search for the place, then drag the pin to where the vehicles hit.</p>
        </div>

        <div className="split-search"><SearchPanel
          onPicked={(at) => { setFocusSeq((n) => n + 1); if (at) setPanTo((p) => ({ lat: at.lat, lon: at.lon, seq: (p?.seq ?? 0) + 1 })); }}
          bias={pin ?? view}
          pin={pin}
        /></div>

        <Tips step="location" />

        <div className="split-side">
          {compact ? (
            <div className="map-compact" data-testid="map-compact">
              <Icon name="pin" className="icon-lg" />
              <p>No place yet. Search above, or open the map and tap where it happened.</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMapOpen(true)}>Open the map</button>
            </div>
          ) : (
            <LocationMap pin={pin} focusSeq={focusSeq} onPin={(lat, lon, how) => dispatch({ type: "pin", lat, lon, how })} fixtures={services.mode === "fixtures"} roads={drawn} streets={names} startExpanded={mapOpen}
              center={panTo ?? undefined} onBias={(b: MapBias) => setView(b.zoom >= VIEW_BIAS_MIN_ZOOM ? { lat: b.lat, lon: b.lon } : null)} />
          )}
          <p className="coords" aria-live="polite">
            <span className="coords-label">{coordsLabel}</span>
            {located ? <span className="num">{loc.lat.toFixed(5)}, {loc.lon.toFixed(5)}</span> : null}
          </p>
          <StreetsHere />
        </div>

        <div className="split-main">
          <div className="group" role="group" aria-labelledby="place-label">
            <p className="group-label" id="place-label">What kind of place?</p>
            <RadioGroup className="tiles tiles-3" aria-labelledby="place-label" values={PLACE_KINDS} value={loc.place} onChange={(place) => dispatch({ type: "place", place })}>
              {PLACE_KINDS.map((k) => <Tile key={k} value={k} icon={PLACE_TILES[k].icon} label={PLACE_TILES[k].label} />)}
            </RadioGroup>
          </div>

          <div className="group">
            <p className="group-label">When did it happen?</p>
            <div className="row-2">
              <div className="field">
                <label className="field-sub" htmlFor="date">Date</label>
                <input className="input" id="date" type="date" value={scene.occurred.date} onChange={(e) => dispatch({ type: "date", date: e.target.value })} />
              </div>
              <div className="field">
                <label className="field-sub" htmlFor="time">Time</label>
                <input className="input" id="time" type="time" value={scene.occurred.time ?? ""} onChange={(e) => dispatch({ type: "time", time: e.target.value || null })} />
              </div>
            </div>
            {/* A new visitor starts on today with no time. No claim hands over a date yet, so there is no "From your claim" hint. */}
          </div>

          <div className="group" role="group" aria-labelledby="road-label">
            <p className="group-label" id="road-label">What was the road like?</p>
            <RadioGroup className="tiles tiles-4" aria-labelledby="road-label" values={ROAD_CONDITIONS} value={scene.road.condition} onChange={(condition) => dispatch({ type: "condition", condition })}>
              {ROAD_CONDITIONS.map((c) => <Tile key={c} value={c} icon={ROAD_TILES[c].icon} label={ROAD_TILES[c].label} />)}
            </RadioGroup>
            <p className="hint">This changes how far the vehicles slide in the picture.</p>
          </div>

          <div className="group">
            <label className="group-label" htmlFor="claim-number">Claim number (optional)</label>
            <input
              className="input claim-number-input" id="claim-number" type="text" autoComplete="off" spellCheck={false} autoCapitalize="characters"
              maxLength={CLAIM_NUMBER_MAX} aria-describedby="claim-number-hint" value={scene.claim.number}
              onChange={(e) => dispatch({ type: "claim-number", number: sanitizeClaimNumber(e.target.value) })}
            />
            <p className="hint" id="claim-number-hint">Letters, numbers and dashes, up to {CLAIM_NUMBER_MAX}. It goes on your files and their names.</p>
          </div>

          <SceneQuestions />
          <GatePanel />

          <div className="actions">
            <button type="button" className="btn btn-primary" onClick={() => flow.go("vehicles")}>Next: vehicles <Icon name="arrow-right" className="icon-sm" /></button>
          </div>
        </div>
      </div>
    </section>
  );
}
