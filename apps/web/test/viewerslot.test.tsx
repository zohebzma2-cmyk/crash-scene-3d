// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Scene, SimulationResult } from "@csd/core";
import { ServicesProvider } from "../src/services/context";
import { fakeSimulate } from "../src/services/fakes";
import { ViewerSlot } from "../src/review/ViewerSlot";
import * as streets from "../src/lib/streets";
import { all, click, flush, get, mockMatchMedia, mount, renderApp } from "./helpers";
import { makeServices, tbone, tboneNet } from "./fakes";

vi.mock("../src/lib/streets", async (orig) => {
  const real = await orig<typeof import("../src/lib/streets")>();
  return { ...real, streetNames: vi.fn(real.streetNames) };
});

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const sim = (scene: Scene): SimulationResult => {
  const o = fakeSimulate(scene, null);
  if (!o.ok) throw new Error("sim failed");
  return o.result;
};

let setTime: (t: number) => void = () => undefined;
function Harness({ withControls = false, scene = tbone }: { withControls?: boolean; scene?: Scene }) {
  const [t, set] = useState(0);
  setTime = set;
  // Stable across renders, as they are in the app (a new sim or services would be a real change).
  const [{ s, services, roads }] = useState(() => ({ s: sim(scene), services: makeServices().services, roads: tboneNet() }));
  return (
    <ServicesProvider services={services}>
      <div className="viewer-canvas">
        <ViewerSlot scene={scene} roads={roads} sim={s} timeS={t} view="top" showLabels showMeasurements={false} showPaths units="us" reducedMotion={false} />
        {withControls ? <div className="view-controls" /> : null}
      </div>
    </ServicesProvider>
  );
}

describe("viewer slot: street labels are placed once, not per tick", () => {
  it("does not recompute the street names when only the time changes", () => {
    const spy = vi.mocked(streets.streetNames);
    spy.mockClear();
    app = mount(<Harness />);
    const first = spy.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    const places = all(".street-label").map((e) => `${e.textContent}@${e.style.left},${e.style.top}`);
    expect(places.length).toBeGreaterThan(0);
    for (const t of [-1.5, -1, -0.5, 0.1, 0.4, 0.9]) act(() => setTime(t));
    expect(spy.mock.calls.length).toBe(first);                      // no recomputation per timeline tick
    expect(all(".street-label").map((e) => `${e.textContent}@${e.style.left},${e.style.top}`)).toEqual(places);   // and none of them moved
  });

  it("does not probe the DOM for token sizes per tick", () => {
    const probe = vi.spyOn(document, "createElement");
    app = mount(<Harness />);
    const spans = () => probe.mock.calls.filter(([tag]) => tag === "span").length;
    const before = spans();
    for (const t of [-1, -0.5, 0, 0.5]) act(() => setTime(t));
    expect(spans()).toBe(before);
  });

  it("still moves the vehicle labels with the time", () => {
    app = mount(<Harness />);
    const at = () => all(".vlabel").map((l) => `${l.style.left},${l.style.top},${l.textContent}`);
    const start = at();
    act(() => setTime(-1.5));
    expect(at()).not.toEqual(start);
  });
});

describe("the view controls are an obstacle in the label pass", () => {
  it("moves a label that would sit under the controls, and keeps it clear of them", () => {
    app = mount(<Harness />);
    const base = all(".vlabel").map((l) => ({ id: l.dataset.id!, x: parseFloat(l.style.left), y: parseFloat(l.style.top) }));
    app.unmount();
    const target = base[0]!;
    const controls = { left: target.x - 4, top: target.y - 4, width: 150, height: 40 };
    const real = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("view-controls")) return { ...controls, x: controls.left, y: controls.top, right: controls.left + controls.width, bottom: controls.top + controls.height, toJSON: () => ({}) } as DOMRect;
      if (this.classList.contains("viewer-slot")) return { x: 0, y: 0, left: 0, top: 0, width: 800, height: 560, right: 800, bottom: 560, toJSON: () => ({}) } as DOMRect;
      return real.call(this);
    });
    app = mount(<Harness withControls />);
    const moved = all(".vlabel").find((l) => l.dataset.id === target.id)!;
    const x = parseFloat(moved.style.left);
    const y = parseFloat(moved.style.top);
    expect([x, y]).not.toEqual([target.x, target.y]);
    // the label's own box (an estimate from its text) doesn't overlap the controls
    const w = (moved.textContent?.length ?? 0) * 7;
    const overlaps = x < controls.left + controls.width && x + w > controls.left && y < controls.top + controls.height && y + 32 > controls.top;
    expect(overlaps).toBe(false);
  });
});

describe("view controls at phone width", () => {
  it("shows only Top and Wide on a phone, as the prototype does, and all four presets on desktop", async () => {
    const { services } = makeServices();
    mockMatchMedia((q) => q.includes("max-width: 767px"));
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush(900);
    expect(all("radio", undefined, document.querySelector(".view-controls")!).map((r) => r.textContent)).toEqual(["Top", "Wide"]);
    click(get("radio", "Wide"));
    expect(get("radio", "Wide").getAttribute("aria-checked")).toBe("true");
    app.unmount();
    vi.unstubAllGlobals();
    mockMatchMedia(() => false);
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush(900);
    expect(all("radio", undefined, document.querySelector(".view-controls")!).map((r) => r.textContent)).toEqual(["Top", "Wide", "Driver A", "Driver B"]);
  });
});
