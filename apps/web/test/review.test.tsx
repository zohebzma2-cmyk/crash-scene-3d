// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialDoc, reducer, type Doc } from "../src/state/doc";
import { resetApproachPlayed } from "../src/review/ReviewStep";
import { Timeline, readout, togglePlay, useTimeline } from "../src/review/Timeline";
import { all, click, flush, get, key, maybe, mockMatchMedia, mount, renderApp, text } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | { unmount: () => void } | null = null;
beforeEach(() => {
  // Test browsers (and the e2e runs) don't autoplay the approach; one test turns it back on.
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
  resetApproachPlayed();
});
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); });

const T0 = -2;
const T1 = 3;

function Harness({ start = 0, onApi }: { start?: number; onApi?: (a: ReturnType<typeof useTimeline>) => void }) {
  const api = useTimeline(T0, T1, { startAtImpact: true });
  onApi?.(api);
  return <Timeline api={{ ...api, t: start === 0 ? api.t : start }} t0={T0} t1={T1} />;
}

describe("timeline", () => {
  it("restarts from the start when play is pressed at the end", () => {
    expect(togglePlay({ t: T1, playing: false, rate: 1 }, T0, T1)).toEqual({ t: T0, playing: true, rate: 1 });
    expect(togglePlay({ t: 0.5, playing: false, rate: 1 }, T0, T1)).toMatchObject({ t: 0.5, playing: true });
    expect(togglePlay({ t: 0.5, playing: true, rate: 1 }, T0, T1).playing).toBe(false);
  });

  it("reads out words for numbers: before, at impact, after, final rest", () => {
    expect(readout(-1.2, T1)).toMatchObject({ number: "1.2 s", words: "before impact", text: "1.2 seconds before impact" });
    expect(readout(0, T1).words).toBe("At impact");
    expect(readout(0.8, T1)).toMatchObject({ number: "0.8 s", words: "after impact" });
    expect(readout(T1, T1).words).toBe("Final rest");
  });

  it("is an ARIA slider that answers the keys in the design", () => {
    let api!: ReturnType<typeof useTimeline>;
    app = mount(<Harness onApi={(a) => { api = a; }} />);
    const slider = get("[role=slider]");
    expect(slider.getAttribute("aria-valuetext")).toBe("At impact");
    expect(slider.getAttribute("aria-valuemin")).toBe("-2");
    key(slider, "ArrowRight");
    expect(api.t).toBeCloseTo(0.1);
    expect(slider.getAttribute("aria-valuetext")).toBe("0.1 seconds after impact");
    key(slider, "ArrowLeft", { shiftKey: true });
    expect(api.t).toBeCloseTo(-0.9);
    key(slider, "Home");
    expect(api.t).toBe(T0);
    key(slider, "End");
    expect(api.t).toBe(T1);
    expect(slider.getAttribute("aria-valuetext")).toBe("Final rest");
    key(slider, "i");
    expect(api.t).toBe(0);
    key(slider, " ");
    expect(api.playing).toBe(true);
    key(slider, " ");
    expect(api.playing).toBe(false);
  });

  it("has one tab stop on the slider, and a play button that restarts at the end", () => {
    let api!: ReturnType<typeof useTimeline>;
    app = mount(<Harness onApi={(a) => { api = a; }} />);
    key(get("[role=slider]"), "End");
    expect(api.t).toBe(T1);
    click(get("button", "Play"));
    expect(api.t).toBe(T0);
    expect(api.playing).toBe(true);
    click(get("button", "Pause"));
    expect(api.playing).toBe(false);
    expect(all("[tabindex='0']")).toHaveLength(1);
  });
});

describe("step 3: review", () => {
  const example = { search: "?example=t-bone-intersection", hash: "#review" };

  it("opens at the moment of impact with labels for every vehicle and the speeds from the simulation", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    expect(get("[role=slider]").getAttribute("aria-valuetext")).toBe("At impact");
    const labels = all(".vlabel");
    expect(labels.map((l) => l.dataset.id)).toEqual(["A", "B"]);
    expect(text(labels[0]!)).toContain("Your car");
    expect(text(labels[0]!)).toMatch(/25 mph/);
    expect(text(labels[1]!)).toMatch(/~20 mph|~25 mph|~30 mph/);
    expect(document.querySelector(".diagram")).not.toBeNull();
  });

  it("plays the approach once on the first visit, unless motion is reduced", async () => {
    Object.defineProperty(navigator, "webdriver", { value: false, configurable: true });
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    expect(get("button", /Pause|Play/).getAttribute("aria-label")).toBe("Pause");
    expect(get("[role=slider]").getAttribute("aria-valuetext")).toMatch(/before impact|At impact/);
    app.unmount();
    resetApproachPlayed();
    mockMatchMedia((q) => q.includes("prefers-reduced-motion"));
    app = await renderApp(services, example);
    await flush(900);
    expect(get("button", "Play")).toBeTruthy();
    expect(get("[role=slider]").getAttribute("aria-valuetext")).toBe("At impact");
  });

  it("keeps vehicle labels apart (no pile-ups) even when both vehicles are at the same spot", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const boxes = all(".vlabel").map((l) => ({ x: parseFloat(l.style.left), y: parseFloat(l.style.top) }));
    expect(boxes).toHaveLength(2);
    // two labels never share a position
    expect(Math.hypot(boxes[0]!.x - boxes[1]!.x, boxes[0]!.y - boxes[1]!.y)).toBeGreaterThan(20);
  });

  it("paints street names as text on the road, through the same label pass", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const names = all(".street-label").map((s) => s.textContent);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => /Street|Avenue|Road|Drive/.test(n ?? ""))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    // a street name never shares a spot with a vehicle label
    const spots = [...all(".street-label"), ...all(".vlabel")].map((e) => `${Math.round(parseFloat(e.style.left))},${Math.round(parseFloat(e.style.top))}`);
    expect(new Set(spots).size).toBe(spots.length);
  });

  it("tapping a label selects that vehicle in the Vehicles tab", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    click(get("tab", "View"));
    click(get(".vlabel[data-id=B]"));
    expect(get("tab", "Vehicles").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector(".summary-item[data-selected]")?.textContent).toContain("Vehicle B");
  });

  it("says braking in the vehicle rows and in the summary (the highway example has both vehicles braking)", async () => {
    const { tboneNet } = await import("./fakes");
    // roads that sit wherever the pin is, so the highway example's pin finds them
    const { services } = makeServices({ examples: { names: () => ["highway-rear-end"], load: async () => (await import("./fakes")).highway }, roads: { load: async (center) => ({ ...tboneNet(), frame: { origin: center } }) } });
    app = await renderApp(services, { search: "?example=highway-rear-end", hash: "#review" });
    await flush(900);
    const rows = all(".summary-item").map((x) => text(x));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toContain("braking");
    expect(document.querySelector("[data-testid=scene-summary]")?.textContent?.match(/and braking/g)).toHaveLength(2);
  });

  it("writes a summary with street names in their own case and no repeated words", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const summary = document.querySelector("[data-testid=scene-summary]")!.textContent ?? "";
    expect(summary).toContain("Main Street");
    expect(summary).toContain("Park Street");
    expect(summary).not.toMatch(/main street|park street/);
    expect(summary).not.toMatch(/\b(\w+)\s+\1\b/i);
  });

  it("lists measurements from the simulation, with ranges from an uncertain speed and a note about it", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    click(get("tab", "Measure"));
    const rows = all(".measure-list > div").map((r) => text(r));
    expect(rows.some((r) => /A moved after impact/.test(r) && / ft \/ |ft/.test(r))).toBe(true);
    expect(text(document.querySelector(".panel-body:not([hidden])")!)).toContain("Ranges come from the speeds you weren't sure of");
  });

  it("shows measurement pills on desktop; on a phone the numbers move into the Measure tab, which opens by itself", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    click(get("tab", "Measure"));
    click(document.querySelector<HTMLInputElement>("input.switch")!);
    expect(all(".mpill").length).toBeGreaterThan(0);
    expect(all(".mpill .mnum").map((n) => n.textContent)[0]).toBe("1");
    app.unmount();

    mockMatchMedia((q) => q.includes("max-width: 767px"));
    app = await renderApp(services, example);
    await flush(900);
    click(get("tab", "View"));
    click(get("tab", "Measure"));
    click(get("tab", "Vehicles"));
    click(get("tab", "Measure"));
    click(document.querySelector<HTMLInputElement>("input.switch")!);
    expect(all(".mpill")).toHaveLength(0);
    expect(get("tab", "Measure").getAttribute("aria-selected")).toBe("true");
  });

  it("switches units on screen between ft/mph and m/km/h", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    click(get("tab", "View"));
    click(get("radio", "m · km/h"));
    expect(text(get(".vlabel[data-id=A]"))).toMatch(/km\/h/);
    click(get("radio", "ft · mph"));
    expect(text(get(".vlabel[data-id=A]"))).toMatch(/mph/);
  });

  it("toggles labels and paths", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    expect(document.querySelectorAll(".d-path").length).toBeGreaterThan(0);
    click(get("tab", "View"));
    const [labels, paths] = all("input.switch") as HTMLInputElement[];
    click(labels!);
    expect(all(".vlabel")).toHaveLength(0);
    click(paths!);
    expect(document.querySelectorAll(".d-path")).toHaveLength(0);
  });

  it("shows why it can't draw in one sentence, with up to three one-tap fixes and 'Edit the details myself'", async () => {
    const { services } = makeServices();
    const real = services.physics.simulate;
    // Refused while B is marked hit on the front (as in the example); any other zone draws.
    services.physics.simulate = (scene, roads) => (scene.vehicles[1]?.zone === "front"
      ? { ok: false, errors: [{ code: "moving-apart", vehicleIds: ["A", "B"], text: "Vehicle A and vehicle B would already have been moving apart before they touched. Check the directions." }] }
      : real(scene, roads));
    const fixScene = (zone: "rear" | "front-right" | "right" | "left", scene: Parameters<typeof real>[0]) => ({ ...scene, vehicles: scene.vehicles.map((v, i) => (i === 1 ? { ...v, zone } : v)) });
    services.physics.suggestFixes = (scene) => ({
      why: "Vehicle A and vehicle B would already have been moving apart before they touched.",
      fixes: (["front-right", "right", "left", "rear"] as const).map((z, i) => ({ id: `B.zone=${z}`, label: `Change B's hit side to ${z}`, cost: i, changes: [], scene: fixScene(z, scene) })).slice(0, 3),
      focus: { step: "vehicles", vehicleId: "B", field: "zone" }, trials: 4,
    });
    app = await renderApp(services, example);
    await flush(900);
    await flush(50);
    expect(text(get("alert"))).toContain("We can't draw this yet");
    const alert = document.querySelector("[data-testid=refusal]")!;
    expect(text(alert.querySelector(".refusal-status")!)).toContain("3 small changes would draw.");
    expect(text(document.querySelector("[data-testid=refusal-why]")!)).toMatch(/^Vehicle A and vehicle B/);
    expect(text(alert)).toContain("would already have been moving apart before they touched.");
    expect(text(alert)).not.toContain("Check the directions");
    expect(document.querySelector(".viewer")).toBeNull();
    const fixes = all("button", /^Change B's hit side to /, alert);
    expect(fixes).toHaveLength(3);
    expect(maybe("button", "Edit the details myself", alert)).not.toBeNull();
    // Applying a fix redraws the review with it.
    click(fixes[0]!);
    await flush(900);
    expect(document.querySelector("[data-testid=refusal]")).toBeNull();
    expect(document.querySelector(".viewer")).not.toBeNull();
    expect(window.location.hash).toBe("#review");
    expect(document.activeElement?.id).toBe("h-review");
  });

  it("'Edit the details myself' goes to the vehicles step at the detail to change", async () => {
    const { services } = makeServices();
    services.physics.simulate = () => ({ ok: false, errors: [{ code: "zones-cannot-touch", vehicleIds: ["B"], text: "Those two parts can't be touching at the same spot." }] });
    services.physics.suggestFixes = () => ({ why: "Those two parts can't be touching at the same spot.", fixes: [], focus: { step: "vehicles", vehicleId: "B", field: "zone" }, trials: 1 });
    app = await renderApp(services, example);
    await flush(900);
    await flush(50);
    expect(text(document.querySelector(".refusal-status")!)).toContain("We couldn't find a small change that draws.");
    click(get("button", "Edit the details myself"));
    await flush(50);
    expect(window.location.hash).toBe("#vehicles");
  });

  it("never lets scene text become HTML", async () => {
    const { services } = makeServices();
    const evil = "<script>window.__pwned=1</script>";
    const evilModel = "<img src=x onerror=window.__pwned=1>";
    const doc: Doc = { ...reducer(reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), { type: "vehicle", id: "B", patch: { make: evil, model: evilModel } }), directionSet: [true, true] };
    app = await renderApp(services, { hash: "#review", storage: doc });
    await flush(900);
    expect(text()).toContain(evil);
    expect(text()).toContain(evilModel);
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("img[src=x]")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("puts the primary action in the panel foot, which is fixed at the bottom on phones", async () => {
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    const foot = document.querySelector(".panel-foot")!;
    expect(foot.querySelector(".btn-primary")?.textContent).toBe("Looks right: save it");
    click(foot.querySelector(".btn-primary"));
    await flush(20);
    expect(window.location.hash).toBe("#export");
  });
});
