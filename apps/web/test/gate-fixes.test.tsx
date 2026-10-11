// @vitest-environment jsdom
// The Vehicles step's warnings offer the same one-tap fixes as the Review refusal (owner's polish list 5a; DESIGN.md
// section 18): the same fixer service and buttons, only fixes that clear the warning, "See it anyway" and "Fix the
// details" kept, and "Clear remembered fixes". Tapping a fix changes the scene and the warning goes away.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FixOptions, PlainMessage, Scene } from "@csd/core";
import { initialDoc, reducer, type Doc } from "../src/state/doc";
import { FIX_MEMORY_KEY } from "../src/fixer/memory";
import { CLEARED_TEXT, GATE_APPLIED_TEXT, REMEMBERED_TEXT, gateFoundText } from "../src/review/RefusalFixes";
import { CONFLICT_TITLE, MISSING_TITLE } from "../src/components/Warnings";
import { click, flush, get, maybe, renderApp, text } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); window.localStorage.removeItem(FIX_MEMORY_KEY); });

/** The default claim, located, both directions picked: A is marked hit on the left. */
const located = (): Doc => ({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
const MISMATCH: PlainMessage = { code: "zone-mismatch", vehicleIds: ["A", "B"], text: "Vehicle B would have come at your car (A) from the front right, but your car (A) is marked as hit on the left side." };
const withZone = (scene: Scene, zone: "right"): Scene => ({ ...scene, vehicles: scene.vehicles.map((v, i) => (i === 0 ? { ...v, zone } : v)) });

/** Services whose plain checks warn while A is hit on the left, and whose fixer offers "Right side" in gate mode. */
function setup() {
  const { services } = makeServices();
  services.physics.checkScene = (scene) => (scene.vehicles[0]?.zone === "left" ? [MISMATCH] : []);
  const calls: Array<FixOptions | undefined> = [];
  services.physics.suggestFixes = (scene, _roads, opts) => {
    calls.push(opts);
    return {
      why: "Vehicle A is marked hit on the left side and vehicle B on the front, but those two parts can't be touching at the same spot.",
      fixes: opts?.gate && scene.vehicles[0]?.zone === "left"
        ? [{ id: "A.zone=right", label: "Change A's hit side to Right side", cost: 0.5, size: 1, kind: "zone:struck", notes: false, changes: [], scene: withZone(scene, "right") }]
        : [],
      focus: { step: "vehicles", vehicleId: "A", field: "zone" }, trials: 3,
    };
  };
  return { services, calls };
}

const panel = () => document.querySelector<HTMLElement>("[data-testid=gate-panel]");

describe("the Vehicles step's one-tap fixes", () => {
  it("shows the fixes under 'don't fit together', keeps 'Fix the details' and 'See it anyway', and a tap clears the warning", async () => {
    const { services, calls } = setup();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush(900);
    await flush(50);
    const gate = panel()!;
    expect(gate).not.toBeNull();
    expect(text(get("alert", undefined, gate))).toContain(CONFLICT_TITLE);
    expect(text(get("alert", undefined, gate))).not.toContain(MISSING_TITLE);
    // The same service as Review, asked for fixes that clear the warning.
    expect(calls.at(-1)?.gate).toBe(true);
    const fixes = gate.querySelector("[data-testid=gate-fixes]")!;
    expect(fixes.getAttribute("data-fixer")).toBe("main");   // jsdom has no Worker
    expect(text(fixes.querySelector("[role=status]")!)).toBe(gateFoundText(1));
    expect(maybe("button", "Fix the details", gate)).not.toBeNull();
    expect(maybe("button", "See it anyway", gate)).not.toBeNull();
    expect(maybe("button", "Clear remembered fixes")).toBeNull();

    click(get("button", "Change A's hit side to Right side", gate));
    await flush(50);
    // The scene changed, the warning is gone, and the claimant is still on the Vehicles step, at "See the recreation".
    expect(panel()).toBeNull();
    expect(window.location.hash).toBe("#vehicles");
    expect(get("radio", "Hit on the right side", document.getElementById("vehicle-A")!).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement?.id).toBe("to-review");
    expect(text()).toContain(GATE_APPLIED_TEXT);
    // Only the kind is remembered, as on Review.
    expect(JSON.parse(window.localStorage.getItem(FIX_MEMORY_KEY)!)).toEqual({ v: 1, kinds: { "zone:struck": 1 } });

    // The gate now passes with no warning.
    click(get("button", /See the recreation/));
    await flush(50);
    expect(window.location.hash).toBe("#review");
  });

  it("offers 'Clear remembered fixes' once a kind is remembered, as on Review", async () => {
    window.localStorage.setItem(FIX_MEMORY_KEY, JSON.stringify({ v: 1, kinds: { "zone:struck": 2 } }));
    const { services, calls } = setup();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush(900);
    await flush(50);
    expect(calls.at(-1)?.prefer).toEqual({ "zone:struck": 2 });
    const gate = panel()!;
    expect(text(gate)).toContain(REMEMBERED_TEXT);
    click(get("button", "Clear remembered fixes", gate));
    await flush(50);
    expect(window.localStorage.getItem(FIX_MEMORY_KEY)).toBeNull();
    expect(text(gate)).toContain(CLEARED_TEXT);
  });

  it("offers no fixes for missing details: an unpicked direction reads as missing", async () => {
    const { services, calls } = setup();
    app = await renderApp(services, { hash: "#vehicles", storage: { ...located(), directionSet: [false, true] } });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush(900);
    const gate = panel()!;
    expect(text(get("alert", undefined, gate))).toContain(MISSING_TITLE);
    expect(text(get("alert", undefined, gate))).not.toContain(CONFLICT_TITLE);
    expect(text(gate)).toContain("Pick which way your car was going.");
    expect(gate.querySelector("[data-testid=gate-fixes]")).toBeNull();
    expect(maybe("button", "See it anyway", gate)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
