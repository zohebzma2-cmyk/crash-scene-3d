// @vitest-environment jsdom
// Round B colours: the picker on the vehicle card, and the picked paint in the mini map and the top-down diagram.
import { afterEach, describe, expect, it, vi } from "vitest";
import { FACTORY_COLORS, contrastRatio, hexToRgb01, type Scene } from "@csd/core";
import { STORAGE_KEY, initialDoc, reducer, type Doc } from "../src/state/doc";
import { fakePlaceVehicles, fakeSimulate } from "../src/services/fakes";
import { Diagram } from "../src/components/Diagram";
import { CatalogColourChip, PaintChip } from "../src/components/PaintChip";
import { INK, inkVar, paintStyle } from "../src/lib/paint";
import { all, click, flush, get, key, mount, renderApp, setValue } from "./helpers";
import { makeServices, tbone, withAnswers } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); });

const located = (): Doc => withAnswers({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;
const stored = (): Doc => JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Doc;
const picker = (id: string) => card(id).querySelector<HTMLElement>(`[data-paint-picker="${id}"]`)!;

describe("the colour picker on the vehicle card", () => {
  it("is one labelled radio group: twelve factory colours, Custom and Not sure (picked), each a 44 px target", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(50);
    const group = get("radiogroup", undefined, picker("A"));
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Colour");
    const radios = all("radio", undefined, group);
    expect(radios.map((r) => r.textContent)).toEqual([...FACTORY_COLORS.map((c) => c.name), "Custom", "Not sure"]);
    // "Not sure" is also the speed field's button: the colour's says what it is about (its visible words stay in its name).
    expect(radios.at(-1)!.getAttribute("aria-label")).toBe("Not sure of the colour");
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.dataset.paint)).toEqual(["unsure"]);
    // One tab stop: the checked radio.
    expect(radios.filter((r) => r.tabIndex === 0).map((r) => r.dataset.paint)).toEqual(["unsure"]);
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("picking Red stores {name, hex} on that vehicle only; Not sure removes it again", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(50);
    click(get("radio", "Red", picker("B")));
    expect(stored().scene.vehicles[1]!.color).toEqual({ name: "Red", hex: FACTORY_COLORS[4]!.hex });
    expect(stored().scene.vehicles[0]!.color).toBeUndefined();
    expect(get("radio", "Red", picker("B")).getAttribute("aria-checked")).toBe("true");
    click(get("radio", "Not sure of the colour", picker("B")));
    expect(stored().scene.vehicles[1]!.color).toBeUndefined();
    expect(JSON.stringify(stored().scene)).not.toContain("\"color\"");
  });

  it("arrow keys move the choice; Custom opens the browser's colour input and stores the custom hex", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(50);
    click(get("radio", "White", picker("A")));
    key(get("radio", "White", picker("A")), "ArrowRight");
    expect(stored().scene.vehicles[0]!.color?.name).toBe("Black");
    click(get("radio", "Custom", picker("A")));
    const input = picker("A").querySelector<HTMLInputElement>("input[type=color]")!;
    expect(input).not.toBeNull();
    expect(input.closest("label")?.textContent).toContain("Pick the custom colour");
    setValue(input, "#12ab34");
    expect(stored().scene.vehicles[0]!.color).toEqual({ name: "Custom", hex: "#12ab34" });
    expect(get("radio", "Custom", picker("A")).getAttribute("aria-checked")).toBe("true");
  });

  it("the swatch fills are inline custom properties (the claimant's data), never classes or literals in CSS", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(50);
    const dot = get("radio", "Yellow", picker("A")).querySelector<HTMLElement>(".paint-dot")!;
    expect(dot.style.getPropertyValue("--swatch")).toBe(FACTORY_COLORS[11]!.hex);
    expect([INK.light, INK.dark]).toContain(dot.style.getPropertyValue("--paint-ink"));
  });
});

describe("the picked paint in the mini map and the diagram", () => {
  it("the mini map marker disc takes the paint; the ring and the letter keep the vehicle token", async () => {
    const { services } = makeServices();
    services.physics.placeVehicles = fakePlaceVehicles;
    const doc = located();
    doc.scene.vehicles[0]!.color = { name: "Red", hex: "#b3151b" };
    app = await renderApp(services, { hash: "#vehicles", storage: doc });
    await flush(900);
    const markers = all(".veh-marker");
    expect(markers.length).toBe(2);
    const a = markers.find((m) => m.classList.contains("v-a"))!;
    const b = markers.find((m) => m.classList.contains("v-b"))!;
    expect(a.style.getPropertyValue("--vehicle-paint")).toBe("#b3151b");
    expect(a.dataset.paint).toBe("#b3151b");
    expect(b.style.getPropertyValue("--vehicle-paint")).toBe("");
    expect(a.querySelector("b")?.textContent).toBe("A");
  });

  it("the diagram fills a painted body with the paint and outlines it in the token class; unpainted bodies are unchanged", () => {
    const scene: Scene = structuredClone(tbone);
    scene.vehicles[1]!.color = { name: "Custom", hex: "#ABCDEF" };
    const out = fakeSimulate(scene, null);
    if (!out.ok) throw new Error("fake sim failed");
    const sim = out.result;
    const m = mount(<Diagram scene={scene} roads={null} vb={{ x: -50, y: -50, w: 100, h: 100 }} sim={sim} poseAt={(_s, v) => v.track[0] ?? v.impactPose} timeS={0} showPaths={false} measure={false} tags />);
    try {
      const gb = m.host.querySelector<SVGGElement>('g.d-veh[data-veh="B"]')!;
      const ga = m.host.querySelector<SVGGElement>('g.d-veh[data-veh="A"]')!;
      expect(gb.classList.contains("is-painted")).toBe(true);
      expect(gb.classList.contains("v-b")).toBe(true);          // the outline and letter stay in B's token colour
      expect(gb.style.getPropertyValue("--vehicle-paint")).toBe("#abcdef");
      expect(ga.classList.contains("is-painted")).toBe(false);
      expect(ga.getAttribute("style")).toBeNull();
      expect(gb.querySelector(".d-tag-text")?.textContent).toBe("B");
    } finally { m.unmount(); }
  });

  it("the ink on paint: dark on near-white, light on near-black, at least 4.5:1 on every factory colour in both themes", () => {
    expect(inkVar("#fdfdfc")).toBe(INK.dark);
    expect(inkVar("#050506")).toBe(INK.light);
    expect(paintStyle({ id: "A" })).toEqual({});
    // The surface and text tokens (design/tokens.css), light / dark. INK.light is surface in light mode and text in dark mode.
    const THEMES = [{ light: "#FFFFFF", dark: "#0F172A" }, { light: "#F8FAFC", dark: "#0F172A" }];
    for (const hex of [...FACTORY_COLORS.map((c) => c.hex), "#fdfdfc", "#050506", "#ffffff", "#000000"]) {
      for (const t of THEMES) {
        const ink = inkVar(hex) === INK.light ? t.light : t.dark;
        expect(contrastRatio(hexToRgb01(hex), hexToRgb01(ink)), `${hex} on ${ink}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("the chip next to a catalog photo says what was picked, and nothing for Not sure", () => {
    const m = mount(<><PaintChip vehicle={{ id: "A", color: { name: "Red", hex: "#b3151b" } }} /><PaintChip vehicle={{ id: "B", color: null }} /></>);
    try {
      const chips = m.host.querySelectorAll(".paint-chip");
      expect(chips.length).toBe(1);
      expect(chips[0]!.textContent).toBe("Picked: Red");
    } finally { m.unmount(); }
  });

  it("a catalog photo's chip says it is the catalog's; an untinted catalog model's chip names its own paint, never the pick (roads and paths)", () => {
    const m = mount(<>
      <PaintChip vehicle={{ id: "A", color: { name: "Gray", hex: "#6b7075" } }} photo />
      <PaintChip vehicle={{ id: "B", color: null }} photo />
      <CatalogColourChip vehicleId="C" paint={{ name: "White", hex: "#f4f5f2" }} />
    </>);
    try {
      const chips = [...m.host.querySelectorAll(".paint-chip")].map((c) => c.textContent);
      expect(chips).toEqual(["Catalog photo · Picked: Gray", "Catalog photo", "Catalog colour: White"]);
    } finally { m.unmount(); }
  });
});
