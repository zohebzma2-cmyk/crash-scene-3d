// Leaflet maps with OSM tiles through mapProvider (DESIGN.md section 9).
// Tiles load only for the area in view. The PDF thumbnail is copied from tiles
// already loaded in the visible map, never fetched separately.
import { mapProvider } from "./config.js";
import { PRESETS } from "./presets.js";
import { travelDir } from "./physics.js";

const L = () => window.L;
const DEFAULT_VIEW = { center: [39.5, -98.35], zoom: 4 };   // whole continental US until a place is set
const PLACE_ZOOM = 18;

function tileLayer(onLoad) {
  return L().tileLayer(mapProvider.tiles.url, {
    maxZoom: mapProvider.tiles.maxZoom,
    attribution: mapProvider.tiles.attribution,
    crossOrigin: "anonymous",          // lets the loaded tiles be copied into the PDF thumbnail
  }).on("load", () => onLoad?.());
}

function svgIcon(id) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", `#i-${id}`);
  svg.append(use);
  return svg;
}

function pinIcon() {
  const el = document.createElement("div");
  el.className = "pin-marker";
  el.append(svgIcon("pin"));
  // anchored at the tip so the pin sits on the point, not on nearby labels
  return L().divIcon({ html: el, className: "", iconSize: [36, 36], iconAnchor: [18, 34] });
}

/** Main location map. onPin(lat, lon, how) is called when the pin moves. */
export function createLocationMap(container, { onPin }) {
  const map = L().map(container, { zoomControl: false, attributionControl: true, tap: true });
  map.attributionControl.setPrefix(false);
  let captureTimer = 0;
  const scheduleCapture = () => { clearTimeout(captureTimer); captureTimer = setTimeout(() => capture(), 500); };
  tileLayer(scheduleCapture).addTo(map);
  map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
  let marker = null;
  let thumb = null;

  const place = (lat, lon, how) => {
    if (!marker) {
      marker = L().marker([lat, lon], { draggable: true, icon: pinIcon(), keyboard: true, title: "Impact pin", alt: "Impact pin" }).addTo(map);
      marker.on("dragend", () => { const p = marker.getLatLng(); onPin(p.lat, p.lng, "drag"); scheduleCapture(); });
      // keyboard: arrow keys nudge the pin about 2 m (Shift: about 10 m)
      marker.getElement()?.addEventListener("keydown", (e) => {
        const d = { ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
        if (!d) return;
        e.preventDefault();
        const p = marker.getLatLng(), m = e.shiftKey ? 10 : 2;
        const nlat = p.lat + (d[0] * m) / 111320, nlon = p.lng + (d[1] * m) / (111320 * Math.cos((p.lat * Math.PI) / 180));
        marker.setLatLng([nlat, nlon]);
        onPin(nlat, nlon, "keys");
        scheduleCapture();
      });
    } else marker.setLatLng([lat, lon]);
    if (how !== "drag") onPin(lat, lon, how);
    scheduleCapture();
  };
  map.on("click", (e) => place(e.latlng.lat, e.latlng.lng, "tap"));

  const capture = () => {
    // Copy the tiles that are already loaded and visible into one image.
    const box = container.getBoundingClientRect();
    if (!box.width || !marker) return;
    const canvas = document.createElement("canvas");
    const scale = 2;
    canvas.width = Math.round(box.width * scale); canvas.height = Math.round(box.height * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    let drew = 0;
    for (const img of container.querySelectorAll("img.leaflet-tile-loaded")) {
      const r = img.getBoundingClientRect();
      if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) continue;
      try { ctx.drawImage(img, r.left - box.left, r.top - box.top, r.width, r.height); drew++; } catch { return; }
    }
    if (!drew) return;
    const pt = map.latLngToContainerPoint(marker.getLatLng());
    const pin = getComputedStyle(container).getPropertyValue("--color-map-pin").trim() || "currentColor";
    ctx.fillStyle = resolveColor(pin);
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = resolveColor("var(--color-surface)"); ctx.stroke();
    try { thumb = { url: canvas.toDataURL("image/png"), w: box.width, h: box.height, at: Date.now() }; } catch { thumb = null; }
  };
  map.on("moveend zoomend", scheduleCapture);

  return {
    map,
    place,
    setView(lat, lon, zoom = PLACE_ZOOM) { map.setView([lat, lon], zoom); },
    zoomIn: () => map.zoomIn(),
    zoomOut: () => map.zoomOut(),
    recenter() { if (marker) map.setView(marker.getLatLng(), Math.max(map.getZoom(), PLACE_ZOOM - 1)); },
    invalidate() { map.invalidateSize(); },
    hasPin: () => !!marker,
    capture,
    thumbnail: () => thumb,
  };
}

/** Small map on the vehicles step: pin plus each vehicle where it came from. */
export function createMiniMap(container) {
  const map = L().map(container, { zoomControl: false, attributionControl: true, dragging: true, scrollWheelZoom: false, doubleClickZoom: true });
  map.attributionControl.setPrefix(false);
  tileLayer().addTo(map);
  const layer = L().layerGroup().addTo(map);
  let centeredOn = "";
  return {
    map,
    render(scene) {
      layer.clearLayers();
      const { lat, lon } = scene.location;
      if (lat == null) return;
      const key = `${lat},${lon}`;
      if (key !== centeredOn) { map.setView([lat, lon], PLACE_ZOOM, { animate: false }); centeredOn = key; }   // keep the user's pan otherwise
      L().marker([lat, lon], { icon: pinIcon(), interactive: false }).addTo(layer);
      const mPerDegLat = 111320, mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
      const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** PLACE_ZOOM;   // spacing in screen terms
      scene.vehicles.forEach((v, i) => {
        const back = (v.action === "parked" ? 36 : 64) * mPerPx;
        const u = travelDir(v);
        const fan = (i - (scene.vehicles.length - 1) / 2) * 48 * mPerPx;      // keep markers apart
        const dx = -u.x * back + u.y * fan, dy = -u.y * back - u.x * fan;
        const el = document.createElement("div");
        el.className = `veh-marker v-${v.id.toLowerCase()}`;
        const icon = svgIcon(PRESETS[v.type]?.icon || "veh-car");
        icon.style.transform = `rotate(${v.heading}deg)`;
        el.append(icon);
        const b = document.createElement("b");
        b.textContent = v.id;
        el.append(b);
        L().marker([lat + dy / mPerDegLat, lon + dx / mPerDegLon], {
          icon: L().divIcon({ html: el, className: "", iconSize: [40, 40], iconAnchor: [20, 20] }),
          interactive: false, keyboard: false,
        }).addTo(layer);
      });
    },
    invalidate() { map.invalidateSize(); },
  };
}

/** Resolve a CSS color expression (tokens, light-dark) to an rgb() string. */
export function resolveColor(expr, scheme) {
  const probe = document.createElement("span");
  probe.style.color = expr.startsWith("var(") || expr.startsWith("light-dark(") ? expr : expr;
  if (scheme) probe.style.colorScheme = scheme;
  probe.style.display = "none";
  document.body.append(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  return c;
}
