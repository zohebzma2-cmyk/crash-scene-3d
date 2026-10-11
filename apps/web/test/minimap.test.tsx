// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialDoc, reducer, type Doc } from "../src/state/doc";
import { all, click, flush, get, renderApp, sizeMapContainers, text } from "./helpers";
import { fakePlaceVehicles } from "../src/services/fakes";
import { makeServices, tbone } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); });

const placed = (picked: boolean): Doc => {
  const d = reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" });
  return { ...d, directionSet: picked ? [true, true] : [false, false] };
};
const WRONG_WAY = "Vehicle B is going the wrong way on Park Street.";

describe("step 2 mini map", () => {
  it("uses the same tile layer as the Location map (drawn from road data in fixtures mode), never the gray road drawing", async () => {
    sizeMapContainers();
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: placed(true) });
    await flush(900);
    expect(all(".map-frame-sm path.map-road").length).toBe(0);
    const tiles = all(".map-frame-sm img.leaflet-tile");
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) expect(t.getAttribute("src")).toMatch(/^data:/);   // drawn locally, no OSM tile files
  });

  it("says nothing about placement before a direction is picked, even if placement would fail", async () => {
    const { services } = makeServices();
    services.physics.placeVehicles = () => ({ ok: false, errors: [{ code: "wrong-way", text: WRONG_WAY, vehicleIds: ["B"] }] });
    app = await renderApp(services, { hash: "#vehicles", storage: placed(false) });
    await flush(900);
    expect(text()).not.toContain(WRONG_WAY);
    expect(document.querySelector(".mini-note")).toBeNull();
  });

  it("shows a placement problem once every direction is picked, under the map and clear of its attribution", async () => {
    const { services } = makeServices();
    services.physics.placeVehicles = () => ({ ok: false, errors: [{ code: "wrong-way", text: WRONG_WAY, vehicleIds: ["B"] }] });
    app = await renderApp(services, { hash: "#vehicles", storage: placed(true) });
    await flush(900);
    const note = get(".mini-note");
    expect(note.textContent).toBe(WRONG_WAY);
    expect(note.closest(".map-frame")).toBeNull();              // not inside the map, where the attribution sits
    expect(document.querySelector(".map-frame-sm .mini-note")).toBeNull();
    expect(document.querySelector(".map-frame-sm .map-attrib")).not.toBeNull();
  });

  it("does not draw a vehicle whose direction isn't picked", async () => {
    const { services } = makeServices();
    services.physics.placeVehicles = fakePlaceVehicles;
    app = await renderApp(services, { hash: "#vehicles", storage: { ...placed(false), directionSet: [true, false] } });
    await flush(900);
    expect(all(".mlabel").map((l) => l.textContent?.[0])).toEqual(["A"]);
  });
});

describe("direction checks wait for every direction", () => {
  it("does not run checkScene while a direction is unpicked, and runs it once all are picked", async () => {
    const { services, checkScene } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: placed(false) });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush();
    expect(checkScene).not.toHaveBeenCalled();
    expect(text(get("alert"))).toContain("Pick which way your car was going.");
    click(get("radio", "Northbound on Main Street", document.getElementById("vehicle-A")!));
    click(get("radio", "Westbound on Park Street", document.getElementById("vehicle-B")!));
    await flush();
    expect(checkScene).toHaveBeenCalled();
  });
});
