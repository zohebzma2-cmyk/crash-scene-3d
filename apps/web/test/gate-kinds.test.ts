// The gate's problems say what kind they are, so a missing detail reads as missing and never as "don't fit together"
// (owner's polish list 5b; DESIGN.md section 18).
import { describe, expect, it } from "vitest";
import type { PlainMessage, Scene } from "@csd/core";
import { CHECK_FAILED_TEXT, NOT_LOCATED_TEXT, pickDirectionText, runGate } from "../src/state/Flow";
import { initialDoc, reducer } from "../src/state/doc";
import { SPEED_EMPTY_TEXT, SPEED_NAN_TEXT } from "../src/components/SpeedInput";
import { tbone } from "./fakes";

const MISMATCH: PlainMessage = { code: "zone-mismatch", vehicleIds: ["A", "B"], text: "Vehicle B would have come at your car (A) from the front right, but your car (A) is marked as hit on the left side." };
const scene = (): Scene => reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }).scene;
const four = (): Scene => {
  let d = reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" });
  d = reducer(d, { type: "add-vehicle" });
  d = reducer(d, { type: "add-vehicle" });
  return d.scene;
};
const checks = (msgs: readonly PlainMessage[]) => () => msgs;

describe("missing details versus details that don't fit together", () => {
  it("a direction not picked yet is a missing detail, in plain words for each vehicle", () => {
    const s = four();
    const out = runGate(s, true, [false, false, false, false], checks([MISMATCH]));
    expect(out.map((p) => p.kind)).toEqual(["missing", "missing", "missing", "missing"]);
    expect(out.map((p) => p.text)).toEqual([
      "Pick which way your car was going.",
      "Pick which way vehicle B was going.",
      "Pick which way vehicle C was going.",
      "Pick which way vehicle D was going.",
    ]);
    expect(out.every((p) => p.blocking && p.focus === "direction" && p.step === "vehicles")).toBe(true);
    // The checks that compare directions wait for every direction, so nothing is called a contradiction yet.
    expect(out.some((p) => p.kind === "conflict")).toBe(false);
  });

  it("a parked or backing vehicle is asked which way it was facing", () => {
    expect(pickDirectionText({ id: "A", action: "parked" })).toBe("Pick which way your car was facing.");
    expect(pickDirectionText({ id: "B", action: "backing" })).toBe("Pick which way vehicle B was facing.");
    expect(pickDirectionText({ id: "C", action: "turn-left" })).toBe("Pick which way vehicle C was going.");
  });

  it("no place yet is a missing detail on the Location step", () => {
    const out = runGate(scene(), false, [true, true], checks([]));
    expect(out).toEqual([{ kind: "missing", text: NOT_LOCATED_TEXT, step: "location", blocking: true, vehicleIds: [] }]);
  });

  it("an empty speed is missing; a speed that can't be used as typed needs changing", () => {
    const out = runGate(scene(), true, [true, true], checks([]), [
      { text: SPEED_EMPTY_TEXT, vehicleId: "A", missing: true },
      { text: SPEED_NAN_TEXT, vehicleId: "B" },
    ]);
    expect(out.map((p) => [p.kind, p.text])).toEqual([
      ["missing", `Vehicle A: ${SPEED_EMPTY_TEXT}`],
      ["unusable", `Vehicle B: ${SPEED_NAN_TEXT}`],
    ]);
    expect(out.every((p) => p.blocking)).toBe(true);
  });

  it("details the physics can't read need changing, and block", () => {
    const s = scene();
    const bad = { ...s, vehicles: [{ ...s.vehicles[0]!, travel: { ...s.vehicles[0]!.travel, bearingDeg: Number.NaN } }, s.vehicles[1]!] } as Scene;
    const out = runGate(bad, true, [true, true], checks([MISMATCH]));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => p.kind === "unusable" && p.blocking)).toBe(true);
  });

  it("only the plain checks' notes are conflicts: they don't block, and 'See it anyway' stays", () => {
    const out = runGate(scene(), true, [true, true], checks([MISMATCH]));
    expect(out).toEqual([{ kind: "conflict", text: MISMATCH.text, step: "vehicles", blocking: false, vehicleIds: ["A", "B"] }]);
    const failed = runGate(scene(), true, [true, true], () => { throw new Error("boom"); });
    expect(failed).toEqual([{ kind: "conflict", text: CHECK_FAILED_TEXT, step: "vehicles", blocking: false, vehicleIds: [] }]);
  });

  it("a missing detail and a conflict can show together, each as what it is", () => {
    const out = runGate(scene(), false, [true, true], checks([MISMATCH]));
    expect(out.map((p) => p.kind)).toEqual(["missing", "conflict"]);
  });

  it("a direction that follows no road at the pin blocks (no 'See it anyway'), but is a detail that doesn't fit, with its one-tap fixes (roads and paths, 2026-10-11)", () => {
    const OFF: PlainMessage = { code: "off-road-direction", vehicleIds: ["B"], text: "Vehicle B's direction doesn't follow any road at the pin. Pick the road it was on and the way it was going, or pick a driveway or parking lot if it came out of one." };
    const out = runGate(scene(), true, [true, true], checks([MISMATCH]), [], () => [OFF]);
    expect(out[0]).toEqual({ kind: "conflict", text: OFF.text, step: "vehicles", blocking: true, vehicleIds: ["B"], focus: "direction" });
    expect(out.map((p) => p.kind)).toEqual(["conflict", "conflict"]);
    // Not until every direction is picked, and a failing road check never blocks.
    expect(runGate(scene(), true, [true, false], checks([]), [], () => [OFF]).some((p) => p.text === OFF.text)).toBe(false);
    expect(runGate(scene(), true, [true, true], checks([]), [], () => { throw new Error("boom"); })).toEqual([]);
  });
});
