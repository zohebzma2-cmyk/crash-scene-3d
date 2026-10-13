// Export pages and files, all built from the shared scene state and the
// physics result. Nothing is uploaded. Every export carries the disclaimer,
// the real time of export and the SHA-256 fingerprint of the scene file.
import { renderDiagram, fitViewBox, sceneBounds } from "./diagram.js";
import { dist, speed, lb, COMPASS_WORD, ACTION_WORD, ZONE_WORD, ROAD_WORD, PLACE_WORD, vehicleName, fmtDateTime, fmtStamp, directionCaption, visibleStreets } from "./format.js";
import { PRESETS } from "./presets.js";
import { FRICTION, RESTITUTION, DEFAULT_LIMIT_MPH, RANGE_HALF_MPH } from "./physics.js";
import { mapProvider } from "./config.js";
import { resolveColor } from "./map.js";

export const DISCLAIMER_SHORT = "Illustration only. This shows what you described. It is not an expert reconstruction and does not decide fault.";
export const DISCLAIMER_LONG = "This 3D illustration was made in your browser by InsurifyAI from details you entered: location, vehicles, directions and estimated speeds. It is a simplified picture to help explain your account. It is not an expert accident reconstruction, expert opinion or evidence of fault, and real vehicle movement may have been different.";

const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};
const NS = "http://www.w3.org/2000/svg";
function icon(id, cls = "icon") {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(NS, "use"); u.setAttribute("href", `#i-${id}`); s.append(u);
  return s;
}
const num = (text) => h("span", { class: "num", text });

/** Keys of the measurements drawn as numbered markers, in marker order (same rule as the diagram). */
export function markerKeys(sim) {
  const keys = sim.middle.vehicles.filter((rv) => rv.postImpactDistance_m >= 0.05).map((rv) => `moved-${rv.id}`);
  if (sim.middle.vehicles.length >= 2) keys.push("gap-AB");
  return keys;
}

/** Place line for exports: the searched place, or the pin with the place it was moved from. */
export function placeLine(loc, parts = 3) {
  const short = (t) => (t ? t.split(",").slice(0, parts).join(",").trim() : "");
  if (loc.label) return short(loc.label);
  if (loc.lat != null) return loc.nearLabel ? `Pin placed by the claimant, near ${short(loc.nearLabel).split(",")[0]}` : "Pin placed by the claimant";
  return loc.placeName || "Not set";
}

/** Measurement rows shared by the review panel, the PDF and the PNG legend. */
export function measurements(scene, sim) {
  const rows = sim.vehicles.map((rv) => ({ key: `moved-${rv.id}`, label: `${rv.id} moved after impact`, value: rv.postImpactDistance_m, id: rv.id }));
  if (sim.gaps.length) rows.push({ key: "gap-AB", label: `${sim.gaps[0].a} to ${sim.gaps[0].b} at final rest, centre to centre`, value: sim.gaps[0].restGap_m });
  for (const rv of sim.vehicles) {
    if (rv.approachDistance_m.hi > 0.05) rows.push({ key: `approach-${rv.id}`, label: `${rv.id}, last 2 s before impact`, value: rv.approachDistance_m, id: rv.id });
  }
  return rows;
}

function speedNote(v, sim) {
  const c = sim.cases[v.id];
  if (v.action === "parked") return "Parked";
  if (!c.unsure) return null;
  return c.limitAssumed
    ? `Not sure; around ${c.limit} mph, a typical city limit (limit not known). Picture: ${c.limit} mph.`
    : `Not sure; around the ${c.limit} mph limit given. Picture: ${c.limit} mph.`;
}

function stampParts(info) {
  if (!info) return { local: null, utc: null, short: null, full: null };
  return { local: fmtStamp(info.createdAt), utc: info.createdAt, short: info.short, full: info.full };
}

/** Full PDF page into host. info = last export (time + fingerprint) or null. */
export function renderPdf(host, scene, sim, warnings, info, thumb) {
  const s = stampParts(info);
  const loc = scene.location;
  const place = placeLine(loc);
  const streets = visibleStreets(loc);
  const fig = h("div", { class: "pdf-fig" });
  if (thumb?.url) {
    fig.append(h("img", { src: thumb.url, alt: "Map of the place with the impact pin" }), h("span", { class: "fig-attrib", text: mapProvider.tiles.attributionText }));
  } else {
    const host2 = h("div", { class: "diagram-host" });
    fig.append(host2, h("span", { class: "fig-note", text: `Map not available. ${loc.lat != null ? `Coordinates ${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}.` : "No location set."}` }));
    queueMicrotask(() => renderDiagram(host2, scene, sim, { t: sim.restTime_s, aspect: 16 / 10, paths: false, view: "near" }));
  }
  const dfig = h("div", { class: "pdf-fig" });
  const dhost = h("div", { class: "diagram-host" });
  dfig.append(dhost);
  const rows = measurements(scene, sim);
  const mi = new Map(markerKeys(sim).map((k, i) => [k, i + 1]));

  const vehicleRows = scene.vehicles.map((v) => {
    const rv = sim.vehicles.find((x) => x.id === v.id);
    const note = speedNote(v, sim);
    return h("tr", {},
      h("td", {}, h("span", { class: `badge-letter v-${v.id.toLowerCase()}`, text: v.id })),
      h("td", {}, vehicleName(v) || v.role),
      h("td", {}, `${PRESETS[v.type].label}, ${lb(rv.mass_kg)}`),
      h("td", {}, directionCaption(v, streets)),
      h("td", {}, num(speed(rv.speedAtImpact_mps, { both: true }).text), note ? h("span", { class: "sub", text: note }) : null),
      h("td", {}, ZONE_WORD[v.zone]),
    );
  });

  const unsure = scene.vehicles.filter((v) => sim.cases[v.id].unsure);
  const assumptions = [
    `Road ${ROAD_WORD[scene.road.condition]}, as entered: friction ${sim.friction} (dry ${FRICTION.dry} · wet ${FRICTION.wet} · snow ${FRICTION.snow} · ice ${FRICTION.ice}). Flat surface.`,
    "Rigid bodies with class-average weights (EPA 2025 Trends Report where available).",
    unsure.length
      ? `Not sure of ${unsure.map((v) => v.id).join(", ")}'s speed: run at the limit ±${RANGE_HALF_MPH} mph (${DEFAULT_LIMIT_MPH} mph if unknown); picture uses the middle, distances show the range.`
      : "Speeds and directions as entered.",
    `No braking or steering unless entered. Simplified collision (restitution ${RESTITUTION}); motion computed in closed form.`,
  ];

  host.replaceChildren(...[
    h("header", { class: "pdf-head" }, h("span", { class: "logo" }, icon("shield", "icon logo-mark"), h("span", { class: "logo-word" }, "Insurify", h("span", { text: "AI" }))), (scene.claim.number || "").trim() ? h("span", { class: "claim", text: `Claim ${scene.claim.number}` }) : null),
    h("div", {}, h("h1", { class: "pdf-title", text: "Crash scene illustration" }), h("p", { class: "sub", text: "Illustration only. Made from the details the claimant entered." })),
    h("div", { class: "pdf-grid" },
      h("section", {},
        h("h3", { text: "Location and time" }),
        h("dl", { class: "pdf-kv" },
          h("dt", { text: "Place" }), h("dd", { text: place }),
          h("dt", { text: "Coordinates" }), h("dd", {}, loc.lat != null ? num(`${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`) : "Not set"),
          h("dt", { text: "Date and time" }), h("dd", { text: fmtDateTime(scene.occurred.date, scene.occurred.time) || "Not given" }),
          h("dt", { text: "Road" }), h("dd", { text: `${PLACE_WORD[loc.place]} · ${ROAD_WORD[scene.road.condition]}` })),
        h("div", { style: "margin-top: var(--space-2)" }, fig)),
      h("section", {},
        h("h3", { text: "Top-down diagram" }), dfig,
        h("p", { class: "sub fig-caption", text: "Vehicles at final rest (middle run). Dashed: path before impact. Red ring: point of impact. Numbers match Key measurements." }))),
    h("section", {}, h("h3", { text: "Vehicles" }),
      h("table", {}, h("thead", {}, h("tr", {}, ["", "Vehicle", "Type, weight", "Direction", "Speed at impact", "Hit on"].map((t) => h("th", { text: t })))), h("tbody", {}, vehicleRows))),
    h("div", { class: "pdf-grid" },
      h("section", {}, h("h3", { text: "Key measurements" }),
        h("div", { class: "mlist" }, rows.flatMap((r) => [
          mi.has(r.key) ? h("span", { class: "mnum", text: String(mi.get(r.key)) }) : h("span", {}),
          h("span", { text: r.label }), num(dist(r.value).text)]))),
      h("section", {}, h("h3", { text: "Assumptions used" }), h("ul", { class: "assume" }, assumptions.map((a) => h("li", { text: a }))))),
    warnings.length ? h("p", { class: "checks" }, h("strong", { text: "Details that may not fit together: " }), warnings.map((w) => w.text).join(" ")) : null,
    h("footer", { class: "pdf-foot" },
      h("p", { class: "pdf-disclaimer", text: DISCLAIMER_LONG }),
      h("p", { class: "pdf-meta" },
        s.local ? h("span", {}, "Made ", h("strong", { text: s.local }), " · ", num(s.utc)) : h("span", { class: "unsaved", text: "Not saved yet. The time and fingerprint are added when you save." }),
        s.short ? h("span", {}, "Fingerprint ", h("strong", {}, num(s.short))) : null,
        h("span", { text: `Map ${mapProvider.tiles.attributionText}` })),
      s.full ? h("p", { class: "pdf-check" }, h("strong", { text: "How to check: " }), `the fingerprint is the SHA-256 of the scene file from the same save ${(scene.claim.number || "").trim() ? `(crash-scene-${scene.claim.number}.json)` : "(saved beside it)"}. Hashing that file must give `, num(s.full), ". If it doesn't, the scene was changed. Without the scene file, the fingerprint can't be checked.") : null),
  ].filter(Boolean));
  queueMicrotask(() => renderDiagram(dhost, scene, sim, { t: sim.restTime_s, aspect: 16 / 10, measure: true, markers: true, tags: true, paths: true }));
}

/** Diagram picture page (1600 × 1600) into host. */
export function renderPng(host, scene, sim, info) {
  const s = stampParts(info);
  const canvas = h("div", { class: "png-canvas" });
  const dhost = h("div", { class: "diagram-host" });
  const all = measurements(scene, sim);
  const rows = markerKeys(sim).map((k) => all.find((r) => r.key === k)).filter(Boolean);
  const legend = h("div", { class: "png-legend" }, rows.map((r, i) => h("div", { class: "row" }, h("span", { class: "mnum", text: String(i + 1) }), h("span", { text: r.label }), num(dist(r.value).text))));
  const bar = h("span", { class: "bar", "data-scale-m": "5" });
  const unsure = scene.vehicles.filter((v) => sim.cases[v.id].unsure).map((v) => `${v.id} speed not known: ${speed(sim.vehicles.find((x) => x.id === v.id).speedAtImpact_mps).text}`);
  canvas.append(dhost,
    h("div", { class: "png-title" }, "Top-down diagram",
      h("span", { text: [placeLine(scene.location, 2), fmtDateTime(scene.occurred.date, scene.occurred.time), `${ROAD_WORD[scene.road.condition]} road`].filter(Boolean).join(" · ") }),
      unsure.length ? h("span", { text: `${unsure.join("; ")}. Picture uses the middle value.` }) : null),
    legend,
    h("div", { class: "png-scale", "aria-label": `North is up. Scale bar ${dist(5).text}.` }, h("span", { class: "north" }, icon("heading", "icon"), "N"), h("span", { class: "scalebar" }, bar, num(dist(5).text))));
  host.replaceChildren(canvas,
    h("div", { class: "png-foot" }, icon("info", "icon"), h("span", { text: DISCLAIMER_SHORT }),
      h("span", { class: "meta" }, s.short ? h("span", {}, "Fingerprint ", num(s.short)) : h("span", { class: "unsaved", text: "Not saved yet" }), s.local ? num(s.local) : null)));
  queueMicrotask(() => {
    const out = renderDiagram(dhost, scene, sim, { t: sim.restTime_s, aspect: 1600 / 1440, measure: true, markers: true, tags: true });
    const unit = dhost.clientWidth / out.vb.w;
    if (unit > 0) bar.style.width = `${5 * unit}px`;
  });
}

/* ---------- Real files ---------- */
export function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Rasterize the diagram picture page into a PNG blob (always light). */
export async function pngBlob(pageEl) {
  const W = 1600, H = 1600;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const col = (v) => resolveColor(`var(${v})`, "light");
  ctx.fillStyle = col("--color-surface"); ctx.fillRect(0, 0, W, H);
  const pageBox = pageEl.getBoundingClientRect();
  const sx = W / pageBox.width, sy = H / pageBox.height;
  // 1) the diagram SVG with computed styles inlined
  const svg = pageEl.querySelector(".diagram-host > svg");
  if (svg) {
    const clone = svg.cloneNode(true);
    const src = svg.querySelectorAll("*"), dst = clone.querySelectorAll("*");
    src.forEach((n, i) => {
      const cs = getComputedStyle(n);
      for (const p of ["fill", "stroke", "opacity", "font-family", "font-weight", "letter-spacing", "stroke-dasharray"]) {
        const v = cs.getPropertyValue(p);
        if (v && v !== "normal") dst[i].setAttribute(p, v);
      }
    });
    clone.setAttribute("xmlns", NS);
    const box = svg.getBoundingClientRect();
    clone.setAttribute("width", String(box.width)); clone.setAttribute("height", String(box.height));
    const img = new Image();
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    ctx.drawImage(img, (box.left - pageBox.left) * sx, (box.top - pageBox.top) * sy, box.width * sx, box.height * sy);
    URL.revokeObjectURL(url);
  }
  // 2) the boxes and text drawn as boxes + text with the page's own fonts and colors
  for (const sel of [".png-title", ".png-legend", ".png-scale", ".png-foot"]) {
    const el = pageEl.querySelector(sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    ctx.fillStyle = cs.backgroundColor;
    roundRect(ctx, (r.left - pageBox.left) * sx, (r.top - pageBox.top) * sy, r.width * sx, r.height * sy, parseFloat(cs.borderTopLeftRadius) * sx);
    drawText(ctx, el, pageBox, sx, sy);
  }
  return new Promise((res) => c.toBlob(res, "image/png"));
}
function roundRect(ctx, x, y, w, hgt, r) { ctx.beginPath(); ctx.roundRect(x, y, w, hgt, r || 0); ctx.fill(); }
function drawText(ctx, root, pageBox, sx, sy) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    const cs = getComputedStyle(el);
    if (el.classList.contains("mnum")) {
      const r = el.getBoundingClientRect();
      ctx.fillStyle = cs.backgroundColor;
      ctx.beginPath(); ctx.arc((r.left + r.width / 2 - pageBox.left) * sx, (r.top + r.height / 2 - pageBox.top) * sy, (r.width / 2) * sx, 0, Math.PI * 2); ctx.fill();
    }
    range.selectNodeContents(n);
    for (const rect of range.getClientRects()) {
      ctx.fillStyle = cs.color;
      ctx.font = `${cs.fontWeight} ${parseFloat(cs.fontSize) * sx}px ${cs.fontFamily}`;
      ctx.textBaseline = "alphabetic";
      // place each line box; clientRects split wrapped lines
      const text = textForRect(n, rect, range);
      ctx.fillText(text, (rect.left - pageBox.left) * sx, (rect.bottom - pageBox.top) * sy - (rect.height * sy) * 0.22);
    }
  }
  // icons in these boxes (north arrow, info) are drawn as simple strokes
  for (const svg of root.querySelectorAll("svg.icon")) {
    const r = svg.getBoundingClientRect();
    const cx = (r.left + r.width / 2 - pageBox.left) * sx, cy = (r.top + r.height / 2 - pageBox.top) * sy, s = (r.height / 2) * sy;
    ctx.strokeStyle = getComputedStyle(svg).color; ctx.lineWidth = Math.max(2, s / 6); ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    if (svg.closest(".north")) { ctx.moveTo(cx, cy + s * 0.8); ctx.lineTo(cx, cy - s * 0.8); ctx.moveTo(cx - s * 0.55, cy - s * 0.25); ctx.lineTo(cx, cy - s * 0.8); ctx.lineTo(cx + s * 0.55, cy - s * 0.25); }
    else { ctx.arc(cx, cy, s * 0.8, 0, Math.PI * 2); ctx.moveTo(cx, cy - s * 0.1); ctx.lineTo(cx, cy + s * 0.45); ctx.moveTo(cx, cy - s * 0.4); ctx.lineTo(cx, cy - s * 0.39); }
    ctx.stroke();
  }
  for (const bar of root.querySelectorAll(".bar")) {
    const r = bar.getBoundingClientRect();
    ctx.fillStyle = getComputedStyle(bar).backgroundColor;
    roundRect(ctx, (r.left - pageBox.left) * sx, (r.top - pageBox.top) * sy, r.width * sx, r.height * sy, r.height * sy / 2);
  }
}
function textForRect(node, rect, range) {
  // find the characters whose boxes sit on this line
  const t = node.textContent;
  let out = "";
  for (let i = 0; i < t.length; i++) {
    range.setStart(node, i); range.setEnd(node, i + 1);
    const r = range.getBoundingClientRect();
    if (Math.abs(r.top - rect.top) < 2) out += t[i];
  }
  range.selectNodeContents(node);
  return out;
}

/** Shrink the PDF in steps until the footer (disclaimer, time, fingerprint) is fully on the page. */
export function fitPdf(page) {
  page.removeAttribute("data-fit");
  const over = () => {
    const foot = page.querySelector(".pdf-foot");
    if (!foot || !page.offsetHeight) return false;
    const pad = parseFloat(getComputedStyle(page).paddingBottom);
    return foot.getBoundingClientRect().bottom > page.getBoundingClientRect().bottom - pad + 0.5;
  };
  for (const level of ["1", "2", "3"]) { if (!over()) return; page.setAttribute("data-fit", level); }
}
