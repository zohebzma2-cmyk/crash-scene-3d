// Top-down diagram built from the scene state and the physics result.
// World units are meters (x east, y north); SVG y is flipped. Colors, fonts
// and line styles come from CSS classes that use tokens; geometry is data.
import { poseAt } from "./physics.js";
import { PRESETS } from "./presets.js";

const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
};
const P = (x, y) => `${x.toFixed(2)} ${(-y).toFixed(2)}`;
const LANE = 3.6;

/** Bounds of everything worth showing; "near" = impact and rest, "wide" adds the approach. */
export function sceneBounds(sim, mode = "near") {
  const pts = [];
  for (const rv of sim.middle.vehicles) {
    const r = Math.max(rv.length_m, rv.width_m) / 2 + 1;
    for (const p of [rv.impactPose, rv.restPose, ...(mode === "wide" ? [poseAt(rv, -sim.approach_s)] : [poseAt(rv, -0.6)])]) {
      pts.push([p.x - r, p.y - r], [p.x + r, p.y + r]);
    }
  }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** viewBox string that fits the bounds into the given aspect (w/h) with padding. */
export function fitViewBox(b, aspect, pad = 4, minSpan = 18) {
  let w = Math.max(b.maxX - b.minX + pad * 2, minSpan), h = Math.max(b.maxY - b.minY + pad * 2, minSpan / aspect);
  if (w / h > aspect) h = w / aspect; else w = h * aspect;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return { x: cx - w / 2, y: -(cy + h / 2), w, h };
}

function drawPlace(g, scene, vb) {
  const big = 400;
  el("rect", { x: -big, y: -big, width: big * 2, height: big * 2, class: "d-ground" }, g);
  const place = scene.location.place;
  const ew = scene.location.streets?.ew, ns = scene.location.streets?.ns;
  const labelX = vb.x + Math.min(6, vb.w * 0.08);
  const labelYns = -(LANE + 2.5);                                   // south leg, just below the junction
  if (place === "parking") {
    el("rect", { x: -big, y: -big, width: big * 2, height: big * 2, class: "d-lot" }, g);
    for (let x = -60; x <= 60; x += 2.7) {
      el("path", { d: `M${P(x, 3.5)}L${P(x, 9)}M${P(x, -3.5)}L${P(x, -9)}`, class: "d-paint", "stroke-width": 0.15 }, g);
    }
    el("path", { d: `M${P(-60, 9)}L${P(60, 9)}M${P(-60, -9)}L${P(60, -9)}`, class: "d-curb", "stroke-width": 0.2 }, g);
    for (let x = -54; x <= 54; x += 13.5) el("path", { d: `M${P(x - 1.2, 0)}L${P(x + 1.2, 0)}M${P(x + 0.4, 0.8)}L${P(x + 1.2, 0)}L${P(x + 0.4, -0.8)}`, class: "d-paint d-arrow", "stroke-width": 0.18, fill: "none" }, g);
    const t = el("text", { x: labelX, y: -1.0, class: "d-street", "font-size": 1.1 }, g);
    t.textContent = scene.location.placeName ? scene.location.placeName.toUpperCase() : "PARKING LOT";
    return;
  }
  el("rect", { x: -big, y: -LANE, width: big * 2, height: LANE * 2, class: "d-road" }, g);
  el("path", { d: `M${P(-big, LANE)}L${P(big, LANE)}M${P(-big, -LANE)}L${P(big, -LANE)}`, class: "d-curb", "stroke-width": 0.2 }, g);
  if (place === "intersection") {
    el("rect", { x: -LANE, y: -big, width: LANE * 2, height: big * 2, class: "d-road" }, g);
    el("rect", { x: -LANE, y: -LANE, width: LANE * 2, height: LANE * 2, class: "d-road" }, g);
    el("path", { d: `M${P(-LANE, big)}L${P(-LANE, LANE)}M${P(LANE, big)}L${P(LANE, LANE)}M${P(-LANE, -big)}L${P(-LANE, -LANE)}M${P(LANE, -big)}L${P(LANE, -LANE)}`, class: "d-curb", "stroke-width": 0.2 }, g);
    el("path", { d: `M${P(-big, 0)}L${P(-LANE - 1, 0)}M${P(LANE + 1, 0)}L${P(big, 0)}M${P(0, big)}L${P(0, LANE + 1)}M${P(0, -LANE - 1)}L${P(0, -big)}`, class: "d-paint", "stroke-width": 0.15, "stroke-dasharray": "1.5 1.5" }, g);
    el("path", { d: `M${P(-LANE - 0.6, 0)}L${P(-LANE - 0.6, -LANE)}M${P(LANE + 0.6, 0)}L${P(LANE + 0.6, LANE)}M${P(0, LANE + 0.6)}L${P(-LANE, LANE + 0.6)}M${P(0, -LANE - 0.6)}L${P(LANE, -LANE - 0.6)}`, class: "d-paint", "stroke-width": 0.4 }, g);
    if (ns) {
      const t = el("text", { x: 0, y: 0, class: "d-street", "font-size": 1.1, "text-anchor": "end", transform: `translate(${(LANE / 2 + 0.4).toFixed(2)} ${(-labelYns).toFixed(2)}) rotate(-90)` }, g);
      t.textContent = ns.toUpperCase();
    }
  } else {
    el("path", { d: `M${P(-big, 0)}L${P(big, 0)}`, class: "d-paint", "stroke-width": 0.15, "stroke-dasharray": "3 2" }, g);
  }
  if (ew) {
    const t = el("text", { x: labelX, y: -(LANE / 2) - 0.2, class: "d-street", "font-size": 1.1 }, g);
    t.textContent = ew.toUpperCase();
  }
}

/** Vehicle silhouette in the vehicle frame (front = -y in SVG), matching the icon set. */
function drawVehicle(g, type, L, W, cls) {
  const x0 = -W / 2, y0 = -L / 2;
  const line = (d) => el("path", { d, class: "d-veh-line", "stroke-width": 0.14, fill: "none" }, g);
  const rx = Math.min(W * 0.3, 0.6);
  if (type === "motorcycle") {
    el("rect", { x: -0.18, y: y0, width: 0.36, height: 0.65, rx: 0.18, class: cls }, g);
    el("rect", { x: -0.18, y: L / 2 - 0.65, width: 0.36, height: 0.65, rx: 0.18, class: cls }, g);
    el("rect", { x: -0.22, y: -0.55, width: 0.44, height: 1.25, rx: 0.22, class: cls }, g);
    el("path", { d: `M${-W / 2} ${y0 + 0.75}H${W / 2}`, class: `${cls}-stroke`, "stroke-width": 0.16, fill: "none" }, g);
    return;
  }
  if (type === "truck") {
    el("rect", { x: x0 + 0.05, y: y0, width: W - 0.1, height: L * 0.22, rx: 0.35, class: cls }, g);
    el("rect", { x: x0, y: y0 + L * 0.25, width: W, height: L * 0.75, rx: 0.15, class: cls }, g);
    line(`M${x0 + 0.3} ${y0 + L * 0.09}H${-x0 - 0.3}`);
    return;
  }
  el("rect", { x: x0, y: y0, width: W, height: L, rx: type === "car" ? rx : rx * 0.7, class: cls }, g);
  if (type === "car") { line(`M${x0 + 0.25} ${y0 + L * 0.3}Q0 ${y0 + L * 0.24} ${-x0 - 0.25} ${y0 + L * 0.3}`); line(`M${x0 + 0.3} ${y0 + L * 0.84}Q0 ${y0 + L * 0.88} ${-x0 - 0.3} ${y0 + L * 0.84}`); }
  if (type === "suv") { line(`M${x0 + 0.25} ${y0 + L * 0.26}H${-x0 - 0.25}`); line(`M${x0 + W * 0.22} ${y0 + L * 0.4}V${y0 + L * 0.88}M${-x0 - W * 0.22} ${y0 + L * 0.4}V${y0 + L * 0.88}`); }
  if (type === "pickup") { line(`M${x0 + 0.25} ${y0 + L * 0.22}H${-x0 - 0.25}`); line(`M${x0} ${y0 + L * 0.45}H${-x0}`); el("rect", { x: x0 + W * 0.2, y: y0 + L * 0.52, width: W * 0.6, height: L * 0.4, rx: 0.1, class: "d-veh-line", "stroke-width": 0.14, fill: "none" }, g); }
  if (type === "van") { line(`M${x0 + 0.25} ${y0 + L * 0.13}Q0 ${y0 + L * 0.09} ${-x0 - 0.25} ${y0 + L * 0.13}`); for (const k of [0.38, 0.58, 0.78]) line(`M${x0 + W * 0.2} ${y0 + L * k}H${-x0 - W * 0.2}`); }
}

/**
 * Render the diagram into host (replacing its content).
 * opts: t (s), aspect, view ("near"|"wide"), measure, ghosts, paths, tags, markers
 * Returns { svg, vb, anchors } where anchors are world points for overlays.
 */
export function renderDiagram(host, scene, sim, opts = {}) {
  const { t = 0, aspect = 4 / 3, view = "near", measure = false, ghosts = false, paths = true, tags = false, markers = false } = opts;
  const vb = opts.viewBox || fitViewBox(sceneBounds(sim, view), aspect);
  const svg = el("svg", { viewBox: `${vb.x.toFixed(2)} ${vb.y.toFixed(2)} ${vb.w.toFixed(2)} ${vb.h.toFixed(2)}`, preserveAspectRatio: "xMidYMid meet", role: "img", class: "diagram" });
  const title = el("title", {}, svg);
  title.textContent = "Top-down picture of the vehicles from the details you entered";
  const ground = el("g", {}, svg);
  drawPlace(ground, scene, vb);

  const anchors = [];
  if (paths) {
    const gp = el("g", { class: "d-paths" }, svg);
    for (const rv of sim.middle.vehicles) {
      if (rv.speedAtImpact_mps > 0.01) {
        const pts = [];
        for (let k = 0; k <= 40; k++) { const p = poseAt(rv, -sim.approach_s * (1 - k / 40)); pts.push(P(p.x, p.y)); }
        el("path", { d: `M${pts.join("L")}`, class: `d-path v-${rv.id.toLowerCase()}`, "stroke-width": 0.18, "stroke-dasharray": "0.8 0.6", fill: "none" }, gp);
      }
      if (rv.postImpactDistance_m > 0.05) {
        el("path", { d: `M${P(rv.impactPose.x, rv.impactPose.y)}L${P(rv.restPose.x, rv.restPose.y)}`, class: `d-path v-${rv.id.toLowerCase()}`, "stroke-width": 0.18, fill: "none" }, gp);
      }
    }
  }
  el("circle", { cx: 0, cy: 0, r: 1.1, class: "d-impact", "stroke-width": 0.25, fill: "none" }, svg);
  el("circle", { cx: 0, cy: 0, r: 0.3, class: "d-impact-dot" }, svg);

  if (ghosts) {
    for (const rv of sim.middle.vehicles) {
      const g = el("g", { class: `v-${rv.id.toLowerCase()} d-ghost`, transform: `translate(${P(rv.restPose.x, rv.restPose.y)}) rotate(${rv.restPose.h.toFixed(1)})` }, svg);
      drawVehicle(g, rv.type, rv.length_m, rv.width_m, "d-ghost-body");
    }
  }

  const vehGroups = {};
  for (const rv of sim.middle.vehicles) {
    const g = el("g", { class: `v-${rv.id.toLowerCase()} d-veh`, "data-veh": rv.id }, svg);
    drawVehicle(g, rv.type, rv.length_m, rv.width_m, "d-veh-body");
    if (tags) {
      el("circle", { r: Math.min(0.75, rv.width_m * 0.42), class: "d-tag" }, g);
      const tx = el("text", { y: 0.38, class: "d-tag-text", "font-size": 1.05, "text-anchor": "middle" }, g);
      tx.textContent = rv.id;
    }
    vehGroups[rv.id] = g;
  }

  if (measure) {
    const gm = el("g", { class: "d-measure" }, svg);
    sim.middle.vehicles.forEach((rv) => {
      if (rv.postImpactDistance_m < 0.05) return;
      const a = rv.impactPose, b = rv.restPose;
      el("path", { d: `M${P(a.x, a.y)}L${P(b.x, b.y)}`, class: "d-measure-line", "stroke-width": 0.12, fill: "none" }, gm);
      anchors.push({ key: `moved-${rv.id}`, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    });
    if (sim.middle.vehicles.length >= 2) {
      const a = sim.middle.vehicles[0].restPose, b = sim.middle.vehicles[1].restPose;
      el("path", { d: `M${P(a.x, a.y)}L${P(b.x, b.y)}`, class: "d-measure-line", "stroke-width": 0.12, "stroke-dasharray": "0.5 0.4", fill: "none" }, gm);
      anchors.push({ key: "gap-AB", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    if (markers) {
      anchors.forEach((an, i) => {
        el("circle", { cx: an.x, cy: -an.y, r: 0.85, class: "d-marker" }, gm);
        const tx = el("text", { x: an.x, y: -an.y + 0.36, class: "d-marker-text", "font-size": 1.0, "text-anchor": "middle" }, gm);
        tx.textContent = String(i + 1);
      });
    }
  }

  host.replaceChildren(svg);
  const setTime = (time) => {
    for (const rv of sim.middle.vehicles) {
      const p = poseAt(rv, time);
      vehGroups[rv.id].setAttribute("transform", `translate(${P(p.x, p.y)}) rotate(${p.h.toFixed(1)})`);
    }
  };
  setTime(t);
  return { svg, vb, anchors, setTime };
}

export { PRESETS };
