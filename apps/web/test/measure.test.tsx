// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { Scene, SimulationResult } from "@csd/core";
import { Diagram } from "../src/components/Diagram";
import { fitViewBox, sceneBounds } from "../src/lib/diagramView";
import { distanceText, markerRows, measureRows } from "../src/lib/measure";
import { newVehicle } from "../src/state/doc";
import { fakePoseAt, fakeSimulate } from "../src/services/fakes";
import { all, click, flush, get, mount, renderApp, text } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; });

const three: Scene = { ...tbone, vehicles: [...tbone.vehicles, newVehicle("C", { travel: { bearingDeg: 180, roadId: null, roadName: null, lane: null }, speed: { kind: "known", mph: 10 }, zone: "rear" })] };
const simOf = (scene: Scene, gaps?: SimulationResult["gaps"]): SimulationResult => {
  const o = fakeSimulate(scene, null);
  if (!o.ok) throw new Error("sim failed");
  return gaps ? { ...o.result, gaps } : o.result;
};
const range = (m: number) => ({ lo: m, mid: m, hi: m });

function draw(scene: Scene, sim: SimulationResult) {
  const vb = fitViewBox(sceneBounds(sim, fakePoseAt, "near"), 4 / 3);
  app = mount(<Diagram scene={scene} roads={null} vb={vb} sim={sim} poseAt={fakePoseAt} timeS={sim.restTimeS} showPaths measure />);
  return all(".d-gap-line");
}

describe("measurement gaps", () => {
  it("draws no gap line and lists no gap row when sim.gaps is empty", () => {
    const sim = simOf(tbone, []);
    expect(measureRows(sim).filter((r) => r.key.startsWith("gap-"))).toHaveLength(0);
    expect(draw(tbone, sim)).toHaveLength(0);
  });

  it("draws one line and lists one row for each entry, between that entry's own vehicles", () => {
    const sim = simOf(three, [{ a: "A", b: "C", restGapM: range(5) }, { a: "B", b: "C", restGapM: range(7) }]);
    const gapRows = measureRows(sim).filter((r) => r.key.startsWith("gap-"));
    expect(gapRows.map((r) => r.label)).toEqual(["A to C at final rest, center to center", "B to C at final rest, center to center"]);
    const lines = draw(three, sim);
    expect(lines).toHaveLength(2);
    // each line runs between the rest poses of its own pair, not between the first two vehicles
    const rest = (id: string) => sim.vehicles.find((v) => v.id === id)!.restPose;
    const ends = (d: string) => d.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const [ax, ay, cx, cy] = ends(lines[0]!.getAttribute("d")!) as [number, number, number, number];
    expect([ax, -ay, cx, -cy]).toEqual([rest("A").xM, rest("A").yM, rest("C").xM, rest("C").yM].map((n) => Number(n)));
    expect(gapRows[0]!.between).toEqual([{ x: rest("A").xM, y: rest("A").yM }, { x: rest("C").xM, y: rest("C").yM }]);
  });

  it("a gap with no entry for the first two vehicles gets no line between them", () => {
    const sim = simOf(three, [{ a: "B", b: "C", restGapM: range(7) }]);
    expect(draw(three, sim)).toHaveLength(1);
    expect(measureRows(sim).some((r) => r.key === "gap-AB")).toBe(false);
  });

  it("marks only rows that sit on the picture, and numbers values with 'about'", () => {
    const sim = simOf(tbone);
    const rows = measureRows(sim);
    expect(markerRows(rows).every((r) => r.anchor != null)).toBe(true);
    for (const r of rows) expect(distanceText(r, "us")).toMatch(/^about \d/);
    expect(distanceText(rows[0]!, "metric")).toMatch(/^about [\d.]+ m$/);
  });
});

describe("estimated numbers say 'about', and the picture's window is the simulation's", () => {
  it("shows 'about' on every value in the Measure tab and on the pills", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush(900);
    click(get("tab", "Measure"));
    const values = all(".measure-list dd").map((d) => d.textContent ?? "");
    expect(values.length).toBeGreaterThan(0);
    for (const v of values) expect(v).toMatch(/^about /);
    click(document.querySelector<HTMLInputElement>("input.switch")!);
    for (const p of all(".mpill .num")) expect(p.textContent).toMatch(/^about /);
    click(get("tab", "Vehicles"));
    expect(text(get(".summary-list"))).toMatch(/about \d+ mph/);
  });

  it("reads the timeline window and the 'before impact' wording from sim.startTimeS, never a fixed 2 s", async () => {
    const { services } = makeServices();
    const base = services.physics.simulate;
    services.physics.simulate = (scene, roads) => {
      const o = base(scene, roads);
      return o.ok ? { ok: true, result: { ...o.result, startTimeS: -5 } } : o;
    };
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush(900);
    const slider = get("[role=slider]");
    expect(slider.getAttribute("aria-valuemin")).toBe("-5");
    click(get("tab", "Measure"));
    expect(text(get(".measure-list"))).toContain("A, last 5 s before impact");
    expect(text(get(".measure-list"))).not.toContain("last 2 s");
    slider.focus();
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    await flush();
    expect(get("[role=slider]").getAttribute("aria-valuetext")).toBe("5.0 seconds before impact");
  });
});
