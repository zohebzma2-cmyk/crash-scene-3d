// crash-scene-3d prototype controller. One shared scene state (state.js);
// every screen and every export renders from it plus the physics result.
import { store, newVehicle, LETTERS, MAX_VEHICLES, MIN_VEHICLES, canonical, sha256Hex, shortFp, isScene } from "./state.js";
import { simulate, poseAt, ZONES, speedCases, FRICTION, PHYSICS_VERSION, SCHEMA_VERSION } from "./physics.js";
import { validate } from "./validate.js";
import { dist, speed, lb, ACTION_WORD, ZONE_WORD, ROAD_WORD, PLACE_WORD, directionCaption, visibleStreets, vehicleName, fmtStamp } from "./format.js";
import { PRESETS, TYPES } from "./presets.js";
import { geocode } from "./geocode.js";
import * as vpic from "./vpic.js";
import { createLocationMap, createMiniMap } from "./map.js";
import { renderDiagram, fitViewBox, sceneBounds } from "./diagram.js";
import { renderPdf, renderPng, measurements, markerKeys, download, pngBlob, fitPdf, DISCLAIMER_LONG } from "./exports.js";
import { mapProvider, vehicleData } from "./config.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const NS = "http://www.w3.org/2000/svg";
function icon(id, cls = "icon") {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("class", cls); s.setAttribute("aria-hidden", "true");
  const u = document.createElementNS(NS, "use"); u.setAttribute("href", `#i-${id}`); s.append(u);
  return s;
}
const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};
const num = (t) => h("span", { class: "num", text: t });
const tokenMs = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const phone = matchMedia("(max-width: 767px)");

const ui = { validationArmed: false, units: "us", view: "near", measure: false, labels: true, paths: true, acceptedWarnings: false, lastExport: null, results: [], picked: -1 };

/* ================= Routing ================= */
const ROUTES = {
  location: { screen: "location", step: 1 }, vehicles: { screen: "vehicles", step: 2 },
  review: { screen: "review", step: 3 }, export: { screen: "export", step: 4 },
  pdf: { screen: "pdf", step: 0 }, png: { screen: "png", step: 0 },
};
const STEP_NAMES = ["", "Location", "Vehicles", "Review", "Save"];
let current = null;
function route() {
  const key = location.hash.slice(1) || "location";
  const r = Object.hasOwn(ROUTES, key) ? ROUTES[key] : ROUTES.location;
  current = r.screen;
  hideToast();
  if (r.screen !== "review") pause();
  $$(".screen").forEach((s) => s.toggleAttribute("data-active", s.id === `screen-${r.screen}`));
  $("#app").hidden = r.step === 0;
  $$(".stepper li").forEach((li) => {
    const n = Number(li.dataset.step);
    li.dataset.state = n < r.step ? "done" : n === r.step ? "current" : "todo";
    const a = $("a", li);
    if (n === r.step) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current");
  });
  $("#step-compact").textContent = `Step ${r.step} of 4 · ${STEP_NAMES[r.step] || ""}`;
  $("#step-bar").style.width = `${(r.step / 4) * 100}%`;
  document.title = `${STEP_NAMES[r.step] || r.screen.toUpperCase()} · Crash scene illustration · InsurifyAI (prototype)`;
  window.scrollTo(0, 0);
  render();
  if (booted) {
    const h1 = $(`#screen-${r.screen} h1`);
    if (h1) { h1.setAttribute("tabindex", "-1"); h1.focus({ preventScroll: true }); }
  }
  booted = true;
  if (r.screen === "pdf") requestAnimationFrame(() => fitPdf($("#pdf-page")));
}
let booted = false;
window.addEventListener("hashchange", route);

function render(reason = "") {
  const s = store.get();
  $(".claim-no").textContent = `Claim ${s.claim.number}`;
  $("#claim-vehicle").textContent = vehicleName(s.vehicles[0]) || "Vehicle not given";
  if (current === "location") renderLocation(s, reason);
  if (current === "vehicles") renderVehicles(s, reason);
  if (current === "review") renderReview(s, reason);
  if (current === "export") renderExport(s);
  if (current === "pdf") renderPdf($("#pdf-page"), s, simulate(s), validate(s), currentExport(s), locMap?.thumbnail());
  if (current === "png") renderPng($("#png-page"), s, simulate(s), currentExport(s));
}
store.subscribe((s, reason) => render(reason));

/* ================= Toast ================= */
let toastTimer = 0;
function toast(text) {
  $("#toast-text").textContent = text;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, tokenMs("--duration-toast"));
}
function hideToast() { clearTimeout(toastTimer); $("#toast").hidden = true; }
$("#toast-close").addEventListener("click", hideToast);

/* ================= Theme (prototype only) ================= */
$("#theme-toggle").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.classList.contains("dark") || (!root.classList.contains("light") && matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", !dark); root.classList.toggle("light", dark);
  $("#theme-toggle use").setAttribute("href", dark ? "#i-moon" : "#i-sun");
  render("theme");
});
const themeParam = new URLSearchParams(location.search).get("theme");
if (themeParam === "dark" || themeParam === "light") document.documentElement.classList.add(themeParam);
$$("[data-open]").forEach((b) => b.addEventListener("click", () => $(`#${b.dataset.open}`).showModal()));

/* ================= Step 1: location ================= */
let locMap = null;
function ensureLocMap() {
  if (locMap || !window.L) return;
  locMap = createLocationMap($("#map"), {
    onPin(lat, lon, how) {
      store.update((d) => {
        d.location.lat = lat; d.location.lon = lon;
        if (how === "drag" || how === "tap" || how === "keys") {
          if (d.location.label) d.location.nearLabel = d.location.label;
          d.location.label = "";
          d.location.source = "pin";
        }
      }, "pin");
    },
  });
  const { lat, lon } = store.get().location;
  if (lat != null) { locMap.setView(lat, lon); locMap.place(lat, lon, "restore"); }
}
$("#zoom-in").addEventListener("click", () => locMap?.zoomIn());
$("#zoom-out").addEventListener("click", () => locMap?.zoomOut());
$("#recenter").addEventListener("click", () => locMap?.recenter());

function renderLocation(s, reason) {
  ensureLocMap();
  requestAnimationFrame(() => locMap?.invalidate());
  const loc = s.location;
  const q = $("#q");
  if (document.activeElement !== q && reason !== "typing") q.value = loc.query;
  $$("#place-tiles input").forEach((i) => { i.checked = i.value === loc.place; });
  $$("#road-tiles input").forEach((i) => { i.checked = i.value === s.road.condition; });
  $("#streets-group").hidden = loc.place === "parking";
  $("#street-ns-field").hidden = loc.place !== "intersection";
  for (const [id, key] of [["#street-ew", "ew"], ["#street-ns", "ns"]]) if (document.activeElement !== $(id)) $(id).value = loc.streets[key] || "";
  if (document.activeElement !== $("#date")) $("#date").value = s.occurred.date;
  if (document.activeElement !== $("#time")) $("#time").value = s.occurred.time;
  $("#map-empty").hidden = loc.lat != null;
  $("#map-hint").hidden = loc.lat == null;
  if (loc.lat != null) {
    $("#coords-label").textContent = loc.source === "pin" ? "Pin placed by you" : (loc.label ? `From search: ${loc.label.split(",").slice(0, 2).join(",")}` : "Pin");
    $("#coords").setAttribute("aria-live", "polite");
    $("#coords-value").textContent = `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`;
  } else {
    $("#coords-label").textContent = "No pin yet";
    $("#coords-value").textContent = "";
  }
  const status = $("#search-status");
  if (loc.lat == null && !status.childElementCount && !ui.results.length && loc.query === s.claim.address) {
    status.replaceChildren(h("p", { class: "status-line status-loading" }, icon("info", "icon icon-sm"), h("span", { text: "This is the address on your claim. Tap Search to find it on the map." })));
  }
}

$("#q").addEventListener("input", (e) => store.update((d) => { d.location.query = e.target.value; }, "typing"));
$("#search-form").addEventListener("submit", (e) => { e.preventDefault(); runSearch($("#q").value); });

let searching = false;
async function runSearch(text) {
  const q = text.trim();
  const status = $("#search-status"), btn = $("#search-btn");
  if (!q) { setStatus("empty", "Type an address, intersection or landmark first."); return; }
  if (searching) return;
  searching = true;
  btn.setAttribute("aria-busy", "true");
  $(".btn-label", btn).textContent = "Searching…";
  setStatus("loading", "Searching OpenStreetMap…");
  $("#results").hidden = true;
  try {
    const results = await geocode(q, { onWait: () => setStatus("loading", "Waiting a moment before the next search…") });
    ui.results = results; ui.picked = -1;
    if (!results.length) {
      setStatus("empty", "We couldn't find that. Try a nearby street or landmark, or tap the map where it happened.");
    } else {
      status.replaceChildren(h("p", { class: "visually-hidden", text: `${results.length} results. Pick the right one.` }));
      renderResults();
    }
  } catch (err) {
    setStatus("empty", "Search isn't working right now. Tap the map where it happened, or try again in a minute.");
  } finally {
    searching = false;
    btn.removeAttribute("aria-busy");
    $(".btn-label", btn).textContent = "Search";
  }
  function setStatus(kind, text) {
    status.replaceChildren(h("p", { class: `status-line status-${kind}` }, kind === "loading" ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(kind === "empty" ? "info" : "check", "icon icon-sm"), h("span", { text })));
    $("#search-attrib").hidden = kind !== "empty" && kind !== "loading" ? false : true;
  }
}
function renderResults() {
  const ul = $("#results");
  const hadFocus = ul.contains(document.activeElement);
  ul.replaceChildren(...ui.results.map((r, i) => h("li", {}, h("button", { type: "button", "aria-current": String(i === ui.picked), onclick: () => pickResult(i) }, icon("pin", "icon icon-sm"), h("span", {}, h("span", { class: "r-main", text: r.main }), h("span", { class: "r-sub", text: [r.sub, r.kind].filter(Boolean).join(" · ") }))))));
  ul.hidden = false;
  $("#search-attrib").hidden = false;
  if (hadFocus && ui.picked >= 0) $$("button", ul)[ui.picked]?.focus();
}
function pickResult(i) {
  const r = ui.results[i];
  ui.picked = i;
  renderResults();
  store.update((d) => {
    d.location.label = r.label; d.location.nearLabel = ""; d.location.lat = r.lat; d.location.lon = r.lon; d.location.source = "search";
    if (r.road && !d.location.streets.ew) d.location.streets.ew = r.road;
  }, "pick");
  locMap?.setView(r.lat, r.lon);
  locMap?.place(r.lat, r.lon, "search");
}
$$("#place-tiles input").forEach((i) => i.addEventListener("change", () => store.update((d) => { d.location.place = i.value; })));
$$("#road-tiles input").forEach((i) => i.addEventListener("change", () => store.update((d) => { d.road.condition = i.value; })));
$("#street-ew").addEventListener("input", (e) => store.update((d) => { d.location.streets.ew = e.target.value; }, "typing"));
$("#street-ns").addEventListener("input", (e) => store.update((d) => { d.location.streets.ns = e.target.value; }, "typing"));
$("#date").addEventListener("change", (e) => store.update((d) => { d.occurred.date = e.target.value; }));
$("#time").addEventListener("change", (e) => store.update((d) => { d.occurred.time = e.target.value; }));

/* ================= Step 2: vehicles ================= */
let miniMap = null;
const cards = new Map();
const lookups = new Map();      // vehicle id → { state, text }
let makesList = null;

function ensureMakes() {
  if (makesList || !document.getElementById("dl-makes")) {
    if (!document.getElementById("dl-makes")) document.body.append(h("datalist", { id: "dl-makes" }));
    if (makesList) return;
  }
  makesList = vpic.makes().then((list) => {
    $("#dl-makes").replaceChildren(...list.map((m) => h("option", { value: m })));
    return list;
  }).catch(() => { makesList = null; return []; });
}

function buildCard(v) {
  const node = $("#tpl-vehicle").content.firstElementChild.cloneNode(true);
  const id = v.id;
  const upd = (fn, reason) => store.update((d) => { const x = d.vehicles.find((y) => y.id === node.dataset.id); if (x) fn(x, d); }, reason);
  node.dataset.id = id;
  const titleId = `v-title-${Math.random().toString(36).slice(2, 8)}`;
  $("[data-role]", node).id = titleId;
  node.setAttribute("aria-labelledby", titleId);
  // unique ids for labels
  for (const f of ["year", "make", "model"]) {
    const input = $(`[data-field="${f}"]`, node);
    input.id = `v-${id}-${f}-${Math.random().toString(36).slice(2, 7)}`;
    $(`[data-for="${f}"]`, node).setAttribute("for", input.id);
  }
  const modelList = h("datalist", { id: `dl-models-${id}-${Math.random().toString(36).slice(2, 7)}` });
  node.append(modelList);
  $('[data-field="model"]', node).setAttribute("list", modelList.id);
  $('[data-field="make"]', node).setAttribute("list", "dl-makes");
  $('[data-field="make"]', node).addEventListener("focus", ensureMakes);

  $('[data-field="year"]', node).addEventListener("input", (e) => {
    const y = e.target.value.replace(/\D/g, "").slice(0, 4);
    e.target.value = y;
    upd((x) => { x.year = y.length === 4 ? Number(y) : null; }, "typing");
    scheduleLookup(node);
  });
  $('[data-field="make"]', node).addEventListener("input", (e) => { upd((x) => { x.make = e.target.value; }, "typing"); scheduleLookup(node); });
  $('[data-field="model"]', node).addEventListener("input", (e) => { upd((x) => { x.model = e.target.value; }, "typing"); applyModelType(node); });
  $('[data-field="model"]', node).addEventListener("change", () => applyModelType(node));

  // type tiles
  const types = $("[data-types]", node);
  for (const t of TYPES) {
    types.append(h("button", { type: "button", class: "tile", role: "radio", "aria-checked": "false", "data-type": t, onclick: () => upd((x) => { x.type = t; x.typeSource = "manual"; }) }, icon(PRESETS[t].icon, "icon"), h("span", { text: PRESETS[t].label })));
  }
  types.setAttribute("role", "radiogroup");
  // actions
  const acts = $("[data-actions]", node);
  acts.setAttribute("role", "radiogroup");
  for (const [a, label, ic] of [["straight", "Straight", "act-straight"], ["turn-left", "Turning left", "act-left"], ["turn-right", "Turning right", "act-right"], ["backing", "Backing up", "act-backing"], ["parked", "Parked", "act-parked"]]) {
    acts.append(h("button", { type: "button", class: "tile", role: "radio", "aria-checked": "false", "data-action": a, onclick: () => upd((x) => { x.action = a; }) }, icon(ic, "icon"), h("span", { text: label })));
  }
  // compass
  const compass = $("[data-compass]", node);
  for (const [deg, letter, word] of [[0, "N", "North"], [90, "E", "East"], [180, "S", "South"], [270, "W", "West"]]) {
    compass.append(h("button", { type: "button", role: "radio", "aria-checked": "false", "aria-label": word, "data-h": String(deg), onclick: () => upd((x) => { x.heading = deg; }) }, letter));
  }
  // speed
  $$("[data-speed]", node).forEach((b) => b.addEventListener("click", () => upd((x) => { x.speedMph = Math.min(120, Math.max(0, x.speedMph + Number(b.dataset.speed))); })));
  $$("[data-limit]", node).forEach((b) => b.addEventListener("click", () => upd((x) => { x.limitMph = Math.min(75, Math.max(10, x.limitMph + Number(b.dataset.limit))); })));
  $("[data-unsure]", node).addEventListener("click", () => upd((x) => { x.unsure = !x.unsure; }));
  $("[data-nolimit]", node).addEventListener("click", () => upd((x) => { x.limitKnown = !x.limitKnown; }));
  // zones
  const zones = $("[data-zones]", node);
  zones.setAttribute("role", "radiogroup");
  for (const z of ZONES) {
    zones.append(h("button", { type: "button", role: "radio", "aria-checked": "false", "data-z": z, onclick: () => upd((x) => { x.zone = z; }) }, ZONE_WORD[z].replace(" side", "")));
  }
  $("[data-remove]", node).addEventListener("click", () => removeVehicle(node.dataset.id));
  return node;
}

function scheduleLookup(node) {
  clearTimeout(node._lookupTimer);
  node._lookupTimer = setTimeout(() => lookupModels(node), 450);
}
async function lookupModels(node) {
  const v = store.get().vehicles.find((x) => x.id === node.dataset.id);
  if (!v) return;
  if (!v.year || !v.make || v.make.trim().length < 2) { lookups.set(v.id, null); node._models = null; render("lookup"); return; }
  if (v.year < 1981 || v.year > new Date().getFullYear() + 1) { lookups.set(v.id, { state: "warn", text: "Check the year. Pick the type below." }); render("lookup"); return; }
  lookups.set(v.id, { state: "loading", text: `Looking up ${v.make} models for ${v.year}…` });
  render("lookup");
  const asked = `${v.year}|${v.make.trim().toLowerCase()}`;
  const stillCurrent = () => { const now = store.get().vehicles.find((x) => x.id === node.dataset.id); return now && `${now.year}|${now.make.trim().toLowerCase()}` === asked; };
  try {
    const list = await vpic.models(v.make, v.year);
    if (!stillCurrent()) return;            // a newer lookup owns this card now
    node._models = list;
    $("datalist", node).replaceChildren(...list.map((m) => h("option", { value: m.name })));
    lookups.set(v.id, list.length ? { state: "ok", text: `${list.length} ${v.make} models for ${v.year}. Pick yours to fill in the type.` } : { state: "warn", text: `No ${v.make} models found for ${v.year}. Pick the type below.` });
  } catch {
    if (!stillCurrent()) return;
    node._models = null;
    lookups.set(node.dataset.id, { state: "warn", text: "Couldn't reach the vehicle list. Pick the type below." });
  }
  applyModelType(node);
}
function applyModelType(node) {
  const v = store.get().vehicles.find((x) => x.id === node.dataset.id);
  if (!v || !node._models) { render("lookup"); return; }
  const m = node._models.find((x) => x.name.toLowerCase() === v.model.trim().toLowerCase());
  if (m && m.type) {
    store.update((d) => { const x = d.vehicles.find((y) => y.id === v.id); x.type = m.type; x.typeSource = "vpic"; }, "lookup");
    lookups.set(v.id, { state: "ok", text: `${PRESETS[m.type].label} from NHTSA vPIC (${m.vpicType}). Weight and size: ${PRESETS[m.type].label.toLowerCase()} class average.` });
  } else if (m && !m.type) {
    lookups.set(v.id, { state: "warn", text: `vPIC lists ${m.name} as "${m.vpicType}". Pick the closest type below.` });
  }
  render("lookup");
}

function removeVehicle(id) {
  const ids = store.get().vehicles.map((v) => v.id);
  if (ids.length <= MIN_VEHICLES) return;
  // Keep each card (and its vPIC lookup) with its vehicle while letters re-pack.
  const oldCards = new Map(cards), oldLookups = new Map(lookups);
  oldCards.get(id)?.remove();
  cards.clear(); lookups.clear();
  ids.filter((x) => x !== id).forEach((old, i) => {
    const node = oldCards.get(old);
    if (node) { node.dataset.id = LETTERS[i]; cards.set(LETTERS[i], node); }
    if (oldLookups.has(old)) lookups.set(LETTERS[i], oldLookups.get(old));
  });
  store.update((d) => { d.vehicles = d.vehicles.filter((v) => v.id !== id).map((v, i) => ({ ...v, id: LETTERS[i] })); }, "remove");
  $("#add-vehicle").focus({ preventScroll: true });
  toast(`Vehicle removed. ${store.get().vehicles.length} vehicles now.`);
}
$("#add-vehicle").addEventListener("click", () => {
  const s = store.get();
  if (s.vehicles.length >= MAX_VEHICLES) return;
  const id = LETTERS[s.vehicles.length];
  store.update((d) => { d.vehicles.push(newVehicle(id, { heading: 180, zone: "front" })); }, "add");
  const card = cards.get(id);
  card?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  $('[data-field="year"]', card)?.focus({ preventScroll: true });
});

function renderVehicles(s, reason) {
  if (!miniMap && window.L) miniMap = createMiniMap($("#mini-map"));
  const list = $("#vehicle-list");
  // keyed by id: build missing cards, drop removed ones, keep order
  for (const [id, node] of cards) if (!s.vehicles.find((v) => v.id === id)) { node.remove(); cards.delete(id); }
  s.vehicles.forEach((v, i) => {
    let node = cards.get(v.id);
    if (!node) { node = buildCard(v); cards.set(v.id, node); }
    if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null);
    fillCard(node, v, s);
  });
  $("#add-vehicle").hidden = s.vehicles.length >= MAX_VEHICLES;
  $("#mini-map-empty").hidden = s.location.lat != null;
  if (miniMap && !miniMap._queued) { miniMap._queued = true; requestAnimationFrame(() => { miniMap._queued = false; miniMap.invalidate(); miniMap.render(store.get()); }); }
  // After the first try to continue, checks stay live while details change.
  if (ui.validationArmed) showWarnings(validate(s), "#vehicle-warnings", "#vehicle-warning-list");
}

function fillCard(node, v, s) {
  node.className = `vehicle v-${v.id.toLowerCase()}`;
  $("[data-letter]", node).textContent = v.id;
  $("[data-role]", node).textContent = v.id === "A" ? "Your car" : `Vehicle ${v.id}`;
  const cv = s.claim.vehicle;
  const sameAsClaim = v.fromClaim && v.year === cv.year && v.make === cv.make && v.model === cv.model;
  $("[data-sub]", node).textContent = [vehicleName(v), sameAsClaim ? "from your claim" : (v.fromClaim ? "changed from your claim" : null)].filter(Boolean).join(" · ") || "Year, make and model if you know them";
  $("[data-remove]", node).hidden = v.id === "A" || s.vehicles.length <= MIN_VEHICLES;
  for (const f of ["year", "make", "model"]) {
    const input = $(`[data-field="${f}"]`, node);
    const val = v[f] == null ? "" : String(v[f]);
    if (document.activeElement !== input && input.value !== val) input.value = val;
  }
  const lk = lookups.get(v.id);
  const lookup = $("[data-lookup]", node);
  lookup.className = `lookup${lk?.state === "warn" ? " is-warn" : ""}`;
  lookup.replaceChildren(...(lk ? [lk.state === "loading" ? h("span", { class: "spinner", "aria-hidden": "true" }) : icon(lk.state === "ok" ? "check" : "info", "icon icon-sm"), h("span", { text: lk.text })]
    : [h("span", { text: v.typeSource === "claim" ? `${PRESETS[v.type].label}, from your claim. Change it if it's wrong.` : "Enter the year, make and model to fill in the type, or pick it below." })]));
  $$("[data-type]", node).forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.type === v.type));
    $(".auto", b)?.remove();
    if (b.dataset.type === v.type && v.typeSource === "vpic") b.append(h("span", { class: "auto", text: "vPIC" }));
  });
  $$("[data-action]", node).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.action === v.action)));
  $$("[data-compass] button", node).forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.h) === v.heading)));
  $("[data-dir-arrow]", node).style.rotate = `${v.heading}deg`;
  $("[data-dir-caption]", node).textContent = directionCaption(v, visibleStreets(s.location));
  $("[data-dir-legend]", node).textContent = v.action === "backing" ? "Which way was it facing? (It was backing up.)" : v.action === "parked" ? "Which way was it facing?" : "Which way was it going?";
  const parked = v.action === "parked";
  $("[data-speed-group]", node).hidden = parked;
  const out = $("[data-speed-out]", node);
  $("[data-unsure]", node).setAttribute("aria-pressed", String(v.unsure));
  $$("[data-speed]", node).forEach((b) => { b.disabled = v.unsure; });
  $("[data-limit-row]", node).hidden = !v.unsure;
  $("[data-nolimit]", node).setAttribute("aria-pressed", String(!v.limitKnown));
  $$("[data-limit]", node).forEach((b) => { b.disabled = !v.limitKnown; });
  const vis = visibleStreets(s.location);
  const street = v.heading % 180 === 0 ? vis.ns : vis.ew;
  $("[data-limit-label]", node).textContent = street ? `Speed limit on ${street}` : "Speed limit where it was driving";
  if (v.unsure) {
    const c = speedCases({ ...v, action: "straight" });      // the same numbers the physics runs
    out.textContent = `${c.lo}–${c.hi}`;
    out.classList.add("range");
    $("[data-limit-out]", node).textContent = v.limitKnown ? String(v.limitMph) : "—";
    $("[data-range-note]", node).textContent = c.limitAssumed
      ? `We'll show ${c.lo}–${c.hi} mph, around ${c.limit} mph, a typical city limit. The picture uses ${c.limit} mph.`
      : `We'll show ${c.lo}–${c.hi} mph, around the ${c.limit} mph limit. The picture uses ${c.limit} mph.`;
  } else {
    out.textContent = String(v.speedMph);
    out.classList.remove("range");
  }
  $$("[data-zones] button", node).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.z === v.zone)));
  $("[data-zone-icon] use", node).setAttribute("href", `#i-${PRESETS[v.type].icon}`);
  // name the per-vehicle buttons so they make sense out of context
  $("[data-remove]", node).setAttribute("aria-label", `Remove vehicle ${v.id}`);
  $('[data-speed="-5"]', node).setAttribute("aria-label", `Slower, vehicle ${v.id}`);
  $('[data-speed="5"]', node).setAttribute("aria-label", `Faster, vehicle ${v.id}`);
  $$('[role="radiogroup"]', node).forEach(rove);
}

/* Radio groups made of buttons: one tab stop per group, arrow keys move the choice. */
function rove(group) {
  const radios = $$('[role="radio"]', group);
  const checked = radios.find((r) => r.getAttribute("aria-checked") === "true") || radios[0];
  radios.forEach((r) => r.setAttribute("tabindex", r === checked ? "0" : "-1"));
}
document.addEventListener("keydown", (e) => {
  const radio = e.target.closest?.('[role="radio"]');
  if (!radio) return;
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (!step) return;
  e.preventDefault();
  const radios = $$('[role="radio"]', radio.closest('[role="radiogroup"]'));
  const next = radios[(radios.indexOf(radio) + step + radios.length) % radios.length];
  next.click();
  next.focus();
});

function showWarnings(list, boxSel, listSel) {
  const box = $(boxSel);
  box.hidden = list.length === 0;
  $(listSel).replaceChildren(...list.map((w) => h("li", { text: w.text })));
}
$("#to-review").addEventListener("click", () => {
  ui.validationArmed = true;
  const w = validate(store.get());
  if (w.length) {
    showWarnings(w, "#vehicle-warnings", "#vehicle-warning-list");
    $("#vehicle-warnings").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    $("#warn-fix").focus({ preventScroll: true });
    return;
  }
  location.hash = "#review";
});
$("#warn-fix").addEventListener("click", () => {
  const first = validate(store.get())[0];
  const card = first && cards.get(first.ids[0]);
  card?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  $("[data-zones] button[aria-checked=true]", card)?.focus({ preventScroll: true });
});
$("#warn-continue").addEventListener("click", () => { ui.acceptedWarnings = true; });

/* ================= Step 3: review ================= */
const rv = { sim: null, out: null, t: 0, T0: -2, T1: 1, playing: false, raf: 0, played: false, key: "" };
function renderReview(s, reason) {
  rv.sim = simulate(s);
  rv.T0 = -rv.sim.approach_s; rv.T1 = rv.sim.restTime_s;
  showWarnings(validate(s), "#review-warnings", "#review-warning-list");
  drawReview();
  fillSummary(s, rv.sim);
  $("#track-impact").style.left = `${((0 - rv.T0) / (rv.T1 - rv.T0)) * 100}%`;
  if (reason === "" || reason === "rebuild") {
    // The viewer always opens at the moment of impact. A first visit plays the approach once and stops there.
    if (!rv.played && !reduceMotion && !navigator.webdriver) { rv.played = true; setTime(rv.T0); play(true); }
    else setTime(0);
  } else setTime(Math.min(rv.t, rv.T1));
}
function drawReview() {
  const host = $("#review-diagram");
  const box = host.getBoundingClientRect();
  const aspect = box.width && box.height ? box.width / box.height : 4 / 3;
  rv.out = renderDiagram(host, store.get(), rv.sim, { t: rv.t, aspect, view: ui.view, measure: ui.measure, ghosts: ui.measure, paths: ui.paths });
  buildOverlays();
}
function buildOverlays() {
  const s = store.get();
  const labels = $("#label-layer");
  labels.hidden = !ui.labels;
  labels.replaceChildren(...rv.sim.middle.vehicles.map((m) => h("span", { class: `vlabel v-${m.id.toLowerCase()}`, "data-id": m.id }, h("span", { class: "badge-letter", text: m.id }), h("span", { text: m.id === "A" ? "Your car" : `Vehicle ${m.id}` }), num(""))));
  const pills = $("#measure-pills");
  const rows = measurements(s, rv.sim);
  pills.hidden = !ui.measure || phone.matches;
  pills.replaceChildren(...rv.out.anchors.map((a, i) => {
    const row = rows.find((r) => r.key === a.key);
    return h("span", { class: "mpill", "data-x": String(a.x), "data-y": String(a.y) }, h("span", { class: "mnum", text: String(i + 1) }), num(row ? dist(row.value, { both: false, units: ui.units }).text : ""));
  }));
}
function placeOverlays() {
  const canvas = $("#viewer-canvas");
  if (!rv.out || !canvas.offsetParent) return;
  const ctm = rv.out.svg.getScreenCTM(), box = canvas.getBoundingClientRect();
  if (!ctm) return;
  const s = store.get();
  const taken = [];
  for (const m of rv.sim.middle.vehicles) {
    const p = poseAt(m, rv.t);
    const label = $(`.vlabel[data-id="${m.id}"]`);
    if (!label) continue;
    const v = s.vehicles.find((x) => x.id === m.id);
    const unsure = rv.sim.cases[m.id]?.unsure;
    $(".num", label).textContent = v?.action === "parked" && rv.t <= 0 ? "parked" : `${unsure ? "~" : ""}${speed(p.speed_mps, { units: ui.units }).text}`;
    const r = Math.max(m.length_m, m.width_m) / 2 + 0.6;
    label.removeAttribute("data-flip");
    let pt = new DOMPoint(p.x, -(p.y + r)).matrixTransform(ctm);
    label.style.left = `${pt.x - box.left}px`; label.style.top = `${pt.y - box.top}px`;
    let lr = label.getBoundingClientRect();
    if (lr.top < box.top || taken.some((t) => overlaps(t, lr))) {
      pt = new DOMPoint(p.x, -(p.y - r)).matrixTransform(ctm);
      label.setAttribute("data-flip", "");
      label.style.top = `${pt.y - box.top}px`;
      lr = label.getBoundingClientRect();
    }
    taken.push(lr);
  }
  const pad = parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.5;
  for (const pill of $$("#measure-pills .mpill")) {
    const pt = new DOMPoint(Number(pill.dataset.x), -Number(pill.dataset.y)).matrixTransform(ctm);
    pill.style.left = `${pt.x - box.left}px`; pill.style.top = `${pt.y - box.top}px`;
    let r = pill.getBoundingClientRect();
    let dx = 0;
    if (r.right > box.right - pad) dx = box.right - pad - r.right;
    if (r.left + dx < box.left + pad) dx = box.left + pad - r.left;
    pill.style.left = `${pt.x - box.left + dx}px`;
    for (let i = 0; i < 8 && taken.some((t) => overlaps(t, pill.getBoundingClientRect())); i++) pill.style.top = `${parseFloat(pill.style.top) + r.height + pad / 2}px`;
    taken.push(pill.getBoundingClientRect());
  }
}
const overlaps = (a, b) => !(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top);

function readout(t) {
  const el = $("#readout");
  if (Math.abs(t) < 0.05) { el.replaceChildren("At impact"); return "At impact"; }
  if (t >= rv.T1 - 0.01) { el.replaceChildren("Final rest"); return "Final rest"; }
  const words = t < 0 ? "before impact" : "after impact";
  el.replaceChildren(num(`${Math.abs(t).toFixed(1)} s`), ` ${words}`);
  return `${Math.abs(t).toFixed(1)} seconds ${words}`;
}
function setTime(t) {
  rv.t = Math.min(rv.T1, Math.max(rv.T0, t));
  rv.out?.setTime(rv.t);
  const frac = (rv.t - rv.T0) / (rv.T1 - rv.T0);
  $("#track-fill").style.width = `${frac * 100}%`;
  $("#thumb").style.left = `${frac * 100}%`;
  const track = $("#track");
  track.setAttribute("aria-valuemin", rv.T0.toFixed(1)); track.setAttribute("aria-valuemax", rv.T1.toFixed(2));
  track.setAttribute("aria-valuenow", rv.t.toFixed(2));
  track.setAttribute("aria-valuetext", readout(rv.t));
  placeOverlays();
}
function play(stopAtImpact = false) {
  if (rv.playing) { pause(); return; }
  if (rv.t >= rv.T1 - 0.01) setTime(rv.T0);          // at the end: restart from the beginning
  rv.playing = true;
  $("#play").setAttribute("aria-label", "Pause"); $("#play-icon").setAttribute("href", "#i-pause");
  let last = performance.now();
  const tick = (now) => {
    const t = rv.t + ((now - last) / 1000) * Number($("#rate").value);
    last = now;
    if (stopAtImpact && rv.t < 0 && t >= 0) { setTime(0); pause(); return; }
    setTime(t);
    if (rv.t >= rv.T1) { pause(); return; }
    rv.raf = requestAnimationFrame(tick);
  };
  rv.raf = requestAnimationFrame(tick);
}
function pause() {
  rv.playing = false; cancelAnimationFrame(rv.raf);
  $("#play").setAttribute("aria-label", "Play"); $("#play-icon").setAttribute("href", "#i-play");
}
$("#play").addEventListener("click", () => play());
$("#track").addEventListener("keydown", (e) => {
  const big = e.shiftKey ? 1 : 0.1;
  const k = { ArrowLeft: -big, ArrowDown: -big, ArrowRight: big, ArrowUp: big }[e.key];
  if (k) { e.preventDefault(); pause(); setTime(rv.t + k); }
  else if (e.key === "Home") { e.preventDefault(); pause(); setTime(rv.T0); }
  else if (e.key === "End") { e.preventDefault(); pause(); setTime(rv.T1); }
  else if (e.key === " ") { e.preventDefault(); play(); }
  else if (e.key.toLowerCase() === "i") { e.preventDefault(); pause(); setTime(0); }
});
$("#viewer-canvas").addEventListener("keydown", (e) => {
  if (e.target !== e.currentTarget) return;          // let its buttons handle their own keys
  if (e.key === " ") { e.preventDefault(); play(); }
  else if (e.key.toLowerCase() === "i") { pause(); setTime(0); }
});
(() => {
  const wrap = $("#track-wrap");
  let down = false;
  const seek = (e) => { const r = $("#track").getBoundingClientRect(); setTime(rv.T0 + ((e.clientX - r.left) / r.width) * (rv.T1 - rv.T0)); };
  wrap.addEventListener("pointerdown", (e) => { down = true; pause(); wrap.setPointerCapture(e.pointerId); seek(e); });
  wrap.addEventListener("pointermove", (e) => { if (down) seek(e); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) wrap.addEventListener(ev, () => { down = false; });
})();
$$(".view-controls .seg").forEach((b) => b.addEventListener("click", () => {
  ui.view = b.dataset.view;
  $$(".view-controls .seg").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  drawReview(); setTime(rv.t);
}));
$$(".tab").forEach((tab) => tab.addEventListener("click", () => {
  $$(".tab").forEach((t) => { t.setAttribute("aria-selected", String(t === tab)); $(`#${t.getAttribute("aria-controls")}`).hidden = t !== tab; });
}));
$("#sw-measure").addEventListener("change", (e) => { ui.measure = e.target.checked; drawReview(); setTime(rv.t); if (ui.measure && phone.matches) $("#t-measure").click(); });
$("#sw-labels").addEventListener("change", (e) => { ui.labels = e.target.checked; $("#label-layer").hidden = !ui.labels; });
$("#sw-paths").addEventListener("change", (e) => { ui.paths = e.target.checked; drawReview(); setTime(rv.t); });
$$("#units input").forEach((i) => i.addEventListener("change", () => { ui.units = i.value; renderReview(store.get(), "units"); }));
phone.addEventListener("change", () => { if (current === "review") renderReview(store.get(), "resize"); });
window.addEventListener("resize", () => { if (current === "review") { drawReview(); setTime(rv.t); } });

function fillSummary(s, sim) {
  $("#summary-list").replaceChildren(...s.vehicles.map((v) => {
    const m = sim.vehicles.find((x) => x.id === v.id);
    const sp = v.action === "parked" ? "parked" : `${sim.cases[v.id].unsure ? "not sure, " : ""}${speed(m.speedAtImpact_mps, { units: ui.units }).text}`;
    return h("li", { class: `summary-item v-${v.id.toLowerCase()}` }, h("span", { class: "badge-letter", text: v.id }),
      h("div", {}, h("h3", { text: `${v.id === "A" ? "Your car" : `Vehicle ${v.id}`} · ${vehicleName(v) || PRESETS[v.type].label}` }),
        h("p", { text: `${directionCaption(v, visibleStreets(s.location))} · ${sp}` }),
        h("p", { text: `Hit on the ${ZONE_WORD[v.zone].toLowerCase()}` })));
  }));
  $("#summary-road").replaceChildren(icon(`road-${s.road.condition}`, "icon icon-sm"), `${PLACE_WORD[s.location.place]}, ${ROAD_WORD[s.road.condition]} road`);
  const parts = s.vehicles.map((v) => {
    const c = sim.cases[v.id];
    const who = v.id === "A" ? "your car (A)" : `vehicle ${v.id}`;
    const label = PRESETS[v.type].label;
    const type = `${/^[AEIOU]|^SUV/.test(label) ? "an" : "a"} ${label === "SUV" ? "SUV" : label.toLowerCase()}`;
    if (v.action === "parked") return `${who}, ${type}, was parked facing ${({ 0: "north", 90: "east", 180: "south", 270: "west" })[v.heading]} and was hit on the ${ZONE_WORD[v.zone].toLowerCase()}`;
    const sp = c.unsure ? (c.limitAssumed ? `about ${c.lo}–${c.hi} mph (not sure, and the limit wasn't known, so ${c.limit} mph was assumed)` : `about ${c.lo}–${c.hi} mph (not sure; around the ${c.limit} mph limit)`) : `about ${c.mid} mph`;
    return `${who}, ${type}, was ${ACTION_WORD[v.action]} at ${sp}, ${directionCaption(v, visibleStreets(s.location)).toLowerCase()}, and was hit on the ${ZONE_WORD[v.zone].toLowerCase()}`;
  });
  const sentence = parts.join("; ");
  $("#scene-summary").textContent = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}. The road was ${ROAD_WORD[s.road.condition]}.`;
  const rows = measurements(s, sim);
  const markers = markerKeys(sim);
  $("#measure-list").replaceChildren(...rows.map((r) => h("div", {}, h("dt", {}, markers.includes(r.key) ? h("span", { class: "mnum", text: String(markers.indexOf(r.key) + 1) }) : null, r.label), h("dd", {}, num(dist(r.value, { both: false, units: ui.units }).text)))));
  $("#measure-note").textContent = Object.values(sim.cases).some((c) => c.unsure) ? "Ranges come from the speeds you weren't sure of. The picture uses the middle value." : "Dashed outlines on the picture show where each vehicle ends up.";
}

/* ================= Step 4: save ================= */
/** The scene file: every input plus the derived values DESIGN.md section 8 lists, stamped with the model version. */
function exportScene(s, createdAt) {
  const { query, autoSearched, ...location } = s.location;
  return {
    ...s, schemaVersion: SCHEMA_VERSION, physicsVersion: PHYSICS_VERSION, location,
    road: { ...s.road, friction: FRICTION[s.road.condition] },
    vehicles: s.vehicles.map((v) => {
      const c = speedCases(v);
      return { ...v,
        speedSource: v.action === "parked" ? "parked" : v.unsure ? "not-sure" : "claimant",
        postedLimitMph: c.unsure ? c.limit : null,
        postedLimitSource: c.unsure ? (c.limitAssumed ? "default" : "claimant") : null,
        speedRangeMph: c.unsure ? [c.lo, c.hi] : null,
        speedUsedMph: c.mid };
    }),
    createdAt, disclaimer: DISCLAIMER_LONG,
  };
}
const DERIVED = ["speedSource", "postedLimitMph", "postedLimitSource", "speedRangeMph", "speedUsedMph"];
function currentExport(s) {
  if (!ui.lastExport) return null;
  return ui.lastExport.stateKey === canonical(exportScene(s, null)) ? ui.lastExport : null;
}
let previewKind = "pdf";
function renderExport(s) {
  const sim = simulate(s);
  const info = currentExport(s);
  renderPdf($("#pdf-page"), s, sim, validate(s), info, locMap?.thumbnail());
  renderPng($("#png-page"), s, sim, info);
  const stamp = $("#export-stamp");
  stamp.classList.toggle("is-stale", !!ui.lastExport && !info);
  if (info) stamp.replaceChildren(h("span", {}, "Saved ", h("strong", { text: fmtStamp(info.createdAt) })), h("span", {}, "Fingerprint ", h("strong", {}, num(info.short))));
  else if (ui.lastExport) stamp.replaceChildren(h("span", { text: `You changed the scene after saving at ${fmtStamp(ui.lastExport.createdAt)}. Save again to update the files.` }));
  else stamp.replaceChildren(h("span", { text: "The time of saving and a fingerprint are added to every file when you save." }));
  if (!$('input[name="fmt"][value="json"]').checked) stamp.append(h("span", { text: "Also save the scene file: the fingerprint can only be checked against it." }));
  setPreview(previewKind);
}
function setPreview(kind) {
  previewKind = kind;
  $$(".preview-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.preview === kind)));
  const host = $("#preview-host");
  $("#preview-open").hidden = kind === "json";
  $("#preview-open").setAttribute("href", `#${kind}`);
  if (kind === "json") {
    const s = store.get();
    const info = currentExport(s);
    host.replaceChildren(h("pre", { class: "json-preview", text: JSON.stringify(JSON.parse(info ? info.text : canonical(exportScene(s, "(added when you save)"))), null, 2) }));
    return;
  }
  // render the page offscreen-but-laid-out, then show a scaled clone
  const src = kind === "pdf" ? $("#pdf-page") : $("#png-page");
  const screen = src.closest(".screen");
  screen.classList.add("offscreen");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (kind === "pdf") fitPdf(src);
    const clone = src.cloneNode(true);
    clone.removeAttribute("id"); $$("[id]", clone).forEach((n) => n.removeAttribute("id"));
    clone.setAttribute("aria-hidden", "true");
    const w = src.offsetWidth, hgt = src.offsetHeight;
    screen.classList.remove("offscreen");
    const avail = host.clientWidth;
    const scale = Math.min(1, avail / w);
    const box = h("div", { class: "preview-box" });
    clone.style.transform = `scale(${scale})`;
    box.style.width = `${w * scale}px`; box.style.height = `${hgt * scale}px`;
    box.append(clone);
    host.replaceChildren(box);
  }));
}
$$(".preview-tabs button").forEach((b) => b.addEventListener("click", () => setPreview(b.dataset.preview)));

$$('input[name="fmt"]').forEach((i) => i.addEventListener("change", () => renderExport(store.get())));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
let saving = false;
$("#save-btn").addEventListener("click", async () => {
  if (saving) return;                                   // one save at a time: one time and fingerprint per save
  const chosen = $$("input[name=fmt]:checked").map((i) => i.value);
  if (!chosen.length) { toast("Pick at least one file to save."); return; }
  if (!crypto?.subtle) { toast("This browser can't make the fingerprint here. Open the tool over https."); return; }
  saving = true;
  const btn = $("#save-btn");
  btn.setAttribute("aria-busy", "true");
  const pngScreen = $("#screen-png");
  const saved = [];
  try {
    const s = store.get();
    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");      // the real time of this export
    const text = canonical(exportScene(s, createdAt));
    const full = await sha256Hex(text);
    const info = { createdAt, full, short: shortFp(full), text, stateKey: canonical(exportScene(s, null)) };
    ui.lastExport = info;
    renderExport(s);
    if (chosen.includes("json")) { download(new Blob([text], { type: "application/json" }), `crash-scene-${s.claim.number}.json`); saved.push("scene file"); }
    if (chosen.includes("png")) {
      pngScreen.classList.add("offscreen");
      renderPng($("#png-page"), s, simulate(s), info);
      await nextFrame();
      const blob = await pngBlob($("#png-page"));
      if (blob) { download(blob, `crash-scene-${s.claim.number}-diagram.png`); saved.push("diagram picture"); }
    }
    if (chosen.includes("pdf")) {
      if (navigator.webdriver) saved.push("PDF (print window skipped in tests)");
      else {
        const back = location.hash || "#export";
        location.hash = "#pdf";
        await nextFrame();
        fitPdf($("#pdf-page"));
        window.print();                                  // the browser's Save as PDF
        location.hash = back;
        await nextFrame();
        saved.push("PDF (if you chose Save as PDF)");
      }
    }
    toast(`Saved to your device: ${saved.join(", ")}.`);
  } catch (err) {
    toast(`Saving didn't finish: ${err?.message || "something went wrong"}. ${saved.length ? `Saved so far: ${saved.join(", ")}.` : "Nothing was saved."}`);
  } finally {
    pngScreen.classList.remove("offscreen");
    btn.removeAttribute("aria-busy");
    saving = false;
  }
});

/* Open a saved scene file: rebuilds the same scene and tells the claimant its fingerprint. */
$("#open-scene").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const { createdAt, disclaimer, ...scene } = data;
    scene.vehicles = (scene.vehicles || []).map((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !DERIVED.includes(k))));
    if (scene.road) delete scene.road.friction;
    if (!disclaimer || !isScene(scene)) throw new Error("not a crash-scene file");
    scene.location = { query: scene.location.label || "", nearLabel: "", ...scene.location };
    const fp = shortFp(await sha256Hex(text));
    store.replace(scene);
    location.hash = "#review";
    await nextFrame();
    toast(`Opened the scene saved ${createdAt ? fmtStamp(createdAt) : ""}. File fingerprint ${fp}.`);
  } catch (err) {
    toast(`That file couldn't be opened (${err.message}).`);
  }
});

/* ================= Boot ================= */
(async () => {
  try {
    const res = await fetch("icons.svg");
    const doc = new DOMParser().parseFromString(await res.text(), "image/svg+xml");
    document.body.prepend(document.importNode(doc.documentElement, true));
  } catch { /* icons missing: buttons keep their text labels */ }
  route();
})();
