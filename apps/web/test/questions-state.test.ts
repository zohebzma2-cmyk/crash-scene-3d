import { describe, expect, it } from "vitest";
import { initialDoc, loadDoc, reducer } from "../src/state/doc";
import { environment } from "../src/viewer/Environment";
import { accountItems } from "@csd/core";

describe("optional answers and illustration state", () => {
  it("migrates the previous main branch's session without losing paint or required-direction state", () => {
    const old = initialDoc(); old.scene.vehicles[0]!.color = { name: "Blue", hex: "#123456" };
    const json = JSON.stringify({ ...old, scene: { ...old.scene, schemaVersion: 3 } });
    const loaded = loadDoc({ getItem: (key) => key === "crash-scene-3d/doc/v4" ? json : null });
    expect(loaded.scene.schemaVersion).toBe(4);
    expect(loaded.scene.vehicles).toEqual(old.scene.vehicles);
    expect(loaded.directionSet).toEqual(old.directionSet);
    expect(loaded.scene.conditions).toBeUndefined();
  });
  it("does not fill a missing required direction when a lane answer is skipped or selected", () => {
    const doc = initialDoc();
    for (const lane of [null, 1]) {
      const changed = reducer(doc, { type: "lane-answer", id: "A", lane });
      expect(changed.directionSet).toEqual(doc.directionSet);
      expect(changed.scene.vehicles[0]!.account?.lane).toBe(lane === null ? "not-sure" : "entered");
    }
  });
  it("keeps the braking recollection through parked/moving edits and synchronizes both controls", () => {
    let doc = initialDoc();
    doc = reducer(doc, { type: "vehicle", id: "A", patch: { account: { braking: "yes" } } });
    expect(doc.scene.vehicles[0]!.braking).toBe(true);
    doc = reducer(doc, { type: "vehicle", id: "A", patch: { action: "parked" } });
    expect(doc.scene.vehicles[0]).toMatchObject({ braking: false, account: { braking: "yes" } });
    doc = reducer(doc, { type: "vehicle", id: "A", patch: { action: "straight" } });
    expect(doc.scene.vehicles[0]!.braking).toBe(true);
    doc = reducer(doc, { type: "vehicle", id: "A", patch: { braking: false, account: { braking: "no" } } });
    expect(doc.scene.vehicles[0]!.account?.braking).toBe("no");
    doc = reducer(doc, { type: "vehicle", id: "A", patch: { account: { braking: "not-sure" } } });
    expect(doc.scene.vehicles[0]).toMatchObject({ braking: false, account: { braking: "not-sure" } });
  });
  it("never attributes default or generic physics braking patches to the claimant", () => {
    let doc = initialDoc();
    for (const braking of [false, true, false]) {
      doc = reducer(doc, { type: "vehicle", id: "A", patch: { braking } });
      expect(doc.scene.vehicles[0]!.account?.braking).toBeUndefined();
      expect(accountItems(doc.scene).filter(a => a.key.endsWith("-braking"))).toEqual([]);
    }
  });
  it("changes appearance without changing road friction or inventing lit lamps", () => {
    const doc = initialDoc();
    for (const weather of ["clear", "rain", "snow", "fog", "not-sure"] as const) {
      const changed = reducer(doc, { type: "conditions", conditions: { lighting: "dark-unlit", weather } });
      expect(changed.scene.road).toEqual(doc.scene.road);
      expect(environment(changed.scene)).toMatchObject({ night: true, lit: false, wet: weather === "rain", snow: weather === "snow", fog: weather === "fog" });
    }
    expect(environment({ ...doc.scene, conditions: { lighting: "dark-lit" } })).toMatchObject({ night: true, lit: true });
    expect(environment({ ...doc.scene, conditions: { lighting: "dusk-dawn" } })).toMatchObject({ night: false, dusk: true });
    expect(environment({ ...doc.scene, conditions: { lighting: "daylight" } })).toMatchObject({ night: false, dusk: false });
  });
  it("preserves imported physics on unrelated edits even if an old answer disagrees", () => {
    const doc = initialDoc(); doc.scene.vehicles[0]!.account = { braking: "yes" };
    const edited = reducer(doc, { type: "vehicle", id: "A", patch: { account: { braking: "yes", towed: "no" } } });
    expect(edited.scene.vehicles[0]!.braking).toBe(false);
    const confirmed = reducer(edited, { type: "vehicle", id: "A", patch: { braking: true, account: { braking: "yes", towed: "no" } } });
    expect(confirmed.scene.vehicles[0]!.braking).toBe(true);
  });
});
