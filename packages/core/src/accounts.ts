import type { LatLon, RoadNetwork, Scene, SceneVehicle } from "./contracts";
import { toLocal } from "./physics/projection";

export const ANSWER_LABELS: Readonly<Record<string, string>> = {
  daylight: "Daylight", "dusk-dawn": "Dusk or dawn", "dark-lit": "Dark with street lights", "dark-unlit": "Dark with no lights",
  clear: "Clear", rain: "Rain", snow: "Snow", fog: "Fog", "sun-glare": "Sun glare", "parked-cars": "Parked cars", hedges: "Hedges",
  green: "Green", yellow: "Yellow", red: "Red", flashing: "Flashing", stop: "Stop sign", yield: "Yield", none: "None", yes: "Yes", no: "No", "not-sure": "Not sure",
};
export interface AccountItem { readonly key: string; readonly icon: string; readonly icons?: readonly string[]; readonly short: string; readonly text: string }
const lightingIcon = { daylight: "light-daylight", "dusk-dawn": "light-dusk", "dark-lit": "light-street-lit", "dark-unlit": "light-dark", "not-sure": "light-dusk" };
export function sceneAccountItems(scene: Scene): AccountItem[] {
  const c = scene.conditions;
  if (!c) return [];
  return [
    ...(c.lighting ? [{ key: "lighting", icon: lightingIcon[c.lighting], short: ANSWER_LABELS[c.lighting]!, text: `Claimant said: lighting — ${ANSWER_LABELS[c.lighting]}.` }] : []),
    ...(c.weather ? [{ key: "weather", icon: c.weather === "not-sure" ? "weather-clear" : `weather-${c.weather}`, short: ANSWER_LABELS[c.weather]!, text: `Claimant said: weather — ${ANSWER_LABELS[c.weather]}.` }] : []),
    ...(c.visibility?.length ? [{ key: "visibility", icon: "visibility-glare", icons: c.visibility.map((v) => v === "parked-cars" ? "visibility-parked" : v === "hedges" ? "visibility-hedges" : "visibility-glare"), short: c.visibility.map((x) => ANSWER_LABELS[x]).join(", "), text: `Claimant said: visibility issues — ${c.visibility.map((x) => ANSWER_LABELS[x]).join(", ")}.` }] : []),
  ];
}
export function vehicleAccountItems(v: SceneVehicle): AccountItem[] {
  const labels = { control: "traffic control", signaled: "signaled", braking: "braking", swerving: "swerving", airbags: "airbags deployed", towed: "towed" } as const;
  const icons = { control: v.account?.control === "stop" ? "feature-stop" : v.account?.control === "yield" ? "feature-yield" : "feature-signal", signaled: v.account?.signaled === "no" ? "signal-off" : "signal-on", braking: "braking", swerving: "swerving", airbags: "airbag", towed: "tow-truck" };
  const items: AccountItem[] = [];
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    const value = v.account?.[key];
    if (value) {
      const answer = value === "none" && key === "control" ? "No control" : ANSWER_LABELS[value]!;
      items.push({ key: `${v.id}-${key}`, icon: icons[key], short: `${v.id}: ${answer}`, text: `Claimant said, vehicle ${v.id}: ${labels[key]} — ${answer}.` });
    }
  }
  if (v.account?.lane === "entered" && v.travel.lane !== null) items.push({ key: `${v.id}-lane`, icon: "feature-lanes", short: `${v.id}: lane ${v.travel.lane + 1}`, text: `Claimant said, vehicle ${v.id}: lane ${v.travel.lane + 1} from the right.` });
  if (v.account?.lane === "not-sure") items.push({ key: `${v.id}-lane`, icon: "feature-lanes", short: `${v.id}: Not sure`, text: `Claimant said, vehicle ${v.id}: lane — Not sure.` });
  return items;
}
export const accountItems = (scene: Scene): AccountItem[] => [...sceneAccountItems(scene), ...scene.vehicles.flatMap(vehicleAccountItems)];

/** Only an explicit directional count, or an unambiguous tagged total, is offered. Never use the physics defaults. */
export function taggedLaneCount(net: RoadNetwork | null, v: SceneVehicle, location?: LatLon): number | null {
  // Older files/examples retain a road name without an id. Resolve only that named road,
  // read-only; the nearest tagged segment below disambiguates divided carriageways.
  const named = v.travel.roadName?.trim().toLowerCase();
  const roads = net?.ways.filter((w) => v.travel.roadId !== null ? w.id === v.travel.roadId : named && w.name?.trim().toLowerCase() === named) ?? [];
  if (!roads.length) return null;
  const osmIds = new Set(roads.flatMap((w) => w.osmWayIds));
  const pin = net && location ? toLocal(net.frame, location) : { x: 0, y: 0 };
  const candidates = net?.taggedRoads?.filter((t) => osmIds.has(t.osmId)) ?? [];
  const nearest = candidates.map((t) => {
    // Find the tangent nearest the pin, rather than the end-to-end bearing of a curved road.
    let distance = Infinity, dot = 0;
    for (let i = 1; i < t.centerline.length; i++) {
      const a = t.centerline[i - 1]!, b = t.centerline[i]!;
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const k = len2 ? Math.max(0, Math.min(1, ((pin.x - a.x) * dx + (pin.y - a.y) * dy) / len2)) : 0;
      const d = Math.hypot(a.x + k * dx - pin.x, a.y + k * dy - pin.y);
      if (d < distance && len2 > 0) { distance = d; const r = v.travel.bearingDeg * Math.PI / 180; dot = (dx * Math.sin(r) + dy * Math.cos(r)) / Math.sqrt(len2); }
    }
    return { t, distance, dot };
  });
  const closest = Math.min(...nearest.map((x) => x.distance));
  // At a lane-count boundary, equally near segments must agree; a distant segment must not
  // override the pin's count. A perpendicular heading gives no trustworthy lane direction.
  const counts = nearest.filter((x) => x.distance <= closest + 1).map(({ t, dot }) => {
    if (Math.abs(dot) < Math.SQRT1_2) return null;
    const along = dot > 0;
    if (t.oneway) return along ? t.lanes ?? t.forward : null;
    const explicit = along ? t.forward : t.backward;
    if (explicit !== null) return explicit;
    const opposite = along ? t.backward : t.forward;
    const total = t.lanes === null ? null : t.lanes - (t.bothWays ?? 0);
    if (total !== null && opposite !== null && total > opposite) return total - opposite;
    return null; // A total alone does not establish a directional split (4 could mean 3 + 1).
  });
  return counts.length && counts.every((x) => x === counts[0]) ? counts[0]! : null;
}
