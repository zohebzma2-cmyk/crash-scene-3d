import { describe, expect, it, vi } from "vitest";
import type { RoadNetwork } from "@csd/core";
import { countingTiles, shareRoadLoads, tilesCovering, TERRAIN_ZOOM } from "../src/services/roads";
import { loadTerrain } from "../src/services/terrain";
import type { RoadsProgress, RoadsService } from "../src/services/types";

const PIN = { lat: 42.7627, lon: -71.4661 };
const net = { frame: { origin: PIN } } as unknown as RoadNetwork;

describe("shared road loads", () => {
  it("joins a running load of the same point and replays its progress", async () => {
    let finish: (n: RoadNetwork) => void = () => undefined;
    const inner: RoadsService = {
      load: vi.fn((_c, _r, onProgress?: (p: RoadsProgress) => void) => {
        onProgress?.({ terrainDone: 1, terrainTotal: 4 });
        return new Promise<RoadNetwork>((r) => { finish = r; });
      }),
    };
    const roads = shareRoadLoads(inner);
    expect(roads.inFlight?.(PIN)).toBe(false);
    const a = roads.load(PIN);
    expect(roads.inFlight?.(PIN)).toBe(true);
    const seen: RoadsProgress[] = [];
    const b = roads.load(PIN, undefined, (p) => seen.push(p));
    expect(inner.load).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ terrainDone: 1, terrainTotal: 4 }]);
    finish(net);
    await expect(a).resolves.toBe(net);
    await expect(b).resolves.toBe(net);
  });

  it("hands a just-finished load to a late asker, without a second request, for a while", async () => {
    let t = 0;
    const inner: RoadsService = { load: vi.fn(async () => net) };
    const roads = shareRoadLoads(inner, 1000, () => t);
    await roads.load(PIN);
    t = 900;
    expect(roads.inFlight?.(PIN)).toBe(true);
    await expect(roads.load(PIN)).resolves.toBe(net);
    expect(inner.load).toHaveBeenCalledTimes(1);
    t = 2000;
    expect(roads.inFlight?.(PIN)).toBe(false);
    await roads.load(PIN);
    expect(inner.load).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh load after a failure (so Retry really retries)", async () => {
    const inner: RoadsService = { load: vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(net) };
    const roads = shareRoadLoads(inner);
    await expect(roads.load(PIN)).rejects.toThrow("down");
    expect(roads.inFlight?.(PIN)).toBe(false);
    await expect(roads.load(PIN)).resolves.toBe(net);
    expect(inner.load).toHaveBeenCalledTimes(2);
  });

  it("keeps different places apart", () => {
    const inner: RoadsService = { load: vi.fn(() => new Promise<RoadNetwork>(() => undefined)) };
    const roads = shareRoadLoads(inner);
    void roads.load(PIN);
    void roads.load({ lat: PIN.lat + 0.01, lon: PIN.lon });
    expect(inner.load).toHaveBeenCalledTimes(2);
  });
});

describe("terrain tiles", () => {
  it("counts tiles as they arrive, starting from 0 of the real total", async () => {
    const seen: RoadsProgress[] = [];
    const tile = countingTiles(PIN, 250, async () => new Uint8Array(1), (p) => seen.push(p));
    const total = tilesCovering(PIN, 250, TERRAIN_ZOOM).length;
    expect(seen).toEqual([{ terrainDone: 0, terrainTotal: total }]);
    await tile(15, 1, 2);
    expect(seen.at(-1)).toEqual({ terrainDone: 1, terrainTotal: total });
  });

  it("asks for every tile at once, not one after another", async () => {
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const tile = (z: number, x: number, y: number) => {
      started.push(`${z}/${x}/${y}`);
      return new Promise<Uint8Array>((_r, reject) => { gates.push(() => reject(new Error("no tile"))); });
    };
    const done = loadTerrain({ origin: PIN }, 250, tile);
    await Promise.resolve();
    expect(started.length).toBe(tilesCovering(PIN, 250, TERRAIN_ZOOM).length);
    gates.forEach((g) => g());
    await expect(done).resolves.toBeNull();
  });
});
