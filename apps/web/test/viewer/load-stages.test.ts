import { describe, expect, it } from "vitest";
import {
  FAILURE_TEXT, HEADLINE, loadComplete, loadFailure, loadMessage, loadNotice, loadProgress, loadStages, stageChanges, type LoadInputs,
} from "../../src/viewer/load-stages";

const base: LoadInputs = { map: "loading", terrain: null, models: "idle", scene: "waiting" };
const statuses = (i: LoadInputs) => Object.fromEntries(loadStages(i).map((s) => [s.id, s.status]));

describe("load stages", () => {
  it("starts with the map data active and the rest waiting", () => {
    expect(statuses(base)).toEqual({ map: "active", terrain: "waiting", models: "waiting", scene: "waiting" });
    expect(loadProgress(loadStages(base))).toBe(0);
    expect(loadMessage(loadStages(base))).toBe(`${HEADLINE} Loading the map data.`);
    expect(loadComplete(loadStages(base))).toBe(false);
  });

  it("counts terrain tiles, in the message and in the progress", () => {
    const i: LoadInputs = { ...base, terrain: { done: 2, total: 4 }, models: "loading" };
    const stages = loadStages(i);
    expect(stages.find((s) => s.id === "terrain")).toMatchObject({ status: "active", count: { done: 2, total: 4 } });
    // map active (0) + terrain half (0.5) + models active (0) + scene waiting (0), over 4.
    expect(loadProgress(stages)).toBeCloseTo(0.5 / 4);
    expect(loadMessage(stages)).toBe(`${HEADLINE} Loading the map data.`);
  });

  it("never counts more tiles than there are", () => {
    const t = loadStages({ ...base, terrain: { done: 9, total: 4 } }).find((s) => s.id === "terrain");
    expect(t?.count).toEqual({ done: 4, total: 4 });
  });

  it("marks terrain done when the roads are in, or skipped when there was none (flat ground)", () => {
    expect(statuses({ ...base, map: "ready", terrain: { done: 4, total: 4, available: true } }).terrain).toBe("done");
    expect(statuses({ ...base, map: "ready", terrain: { done: 1, total: 4, available: false } }).terrain).toBe("skipped");
    expect(statuses({ ...base, map: "ready", terrain: null }).terrain).toBe("done");
  });

  it("moves through the models and the first frame to complete", () => {
    const loading = loadStages({ map: "ready", terrain: null, models: "loading", scene: "waiting" });
    expect(loadMessage(loading)).toBe(`${HEADLINE} Loading the 3D models.`);
    const building = loadStages({ map: "ready", terrain: null, models: "ready", scene: "building" });
    expect(loadMessage(building)).toBe(`${HEADLINE} Drawing the scene.`);
    expect(loadProgress(building)).toBe(0.75);
    const ready = loadStages({ map: "ready", terrain: null, models: "ready", scene: "ready" });
    expect(loadComplete(ready)).toBe(true);
    expect(loadProgress(ready)).toBe(1);
    expect(loadFailure(ready)).toBeNull();
  });

  it("with no WebGL, the models and the drawing are skipped (the diagram is the picture)", () => {
    const s = loadStages({ map: "ready", terrain: null, models: "none", scene: "waiting" });
    expect(statuses({ map: "ready", terrain: null, models: "none", scene: "waiting" })).toMatchObject({ models: "skipped", scene: "skipped" });
    expect(loadComplete(s)).toBe(true);
  });

  it("a place with nothing to load skips the map and terrain", () => {
    expect(statuses({ ...base, map: "none" })).toMatchObject({ map: "skipped", terrain: "skipped" });
  });

  it("a failed map is a notice the picture is drawn through, not a failure", () => {
    const s = loadStages({ map: "failed", terrain: null, models: "ready", scene: "ready" });
    expect(loadNotice(s)).toMatchObject({ id: "map", message: FAILURE_TEXT.map });
    expect(loadFailure(s)).toBeNull();
    expect(statuses({ map: "failed", terrain: null, models: "ready", scene: "ready" }).terrain).toBe("skipped");
    // Once the picture is drawn, the loading box goes; the notice stays.
    expect(loadComplete(s)).toBe(true);
    expect(loadComplete(loadStages({ map: "failed", terrain: null, models: "ready", scene: "building" }))).toBe(false);
  });

  it("a failed 3D chunk or 3D view is a failure, with its own words", () => {
    expect(loadFailure(loadStages({ ...base, map: "ready", models: "failed" }))).toMatchObject({ id: "models", message: FAILURE_TEXT.models });
    expect(loadFailure(loadStages({ ...base, map: "ready", models: "ready", scene: { failed: "webgl" } }))).toMatchObject({ id: "scene", message: FAILURE_TEXT.webgl });
    expect(loadFailure(loadStages({ ...base, map: "ready", models: "ready", scene: { failed: "lost" } }))).toMatchObject({ id: "scene", message: FAILURE_TEXT.lost });
    expect(loadComplete(loadStages({ ...base, map: "ready", models: "failed" }))).toBe(false);
  });

  it("reports only the stages whose status changed", () => {
    const a = loadStages(base);
    const b = loadStages({ ...base, map: "ready", models: "loading" });
    expect(stageChanges([], a).map((c) => c.id)).toEqual(["map", "terrain", "models", "scene"]);
    expect(stageChanges(a, a)).toEqual([]);
    expect(stageChanges(a, b)).toEqual([
      { id: "map", from: "active", to: "done" },
      { id: "terrain", from: "waiting", to: "done" },
      { id: "models", from: "waiting", to: "active" },
    ]);
  });
});
