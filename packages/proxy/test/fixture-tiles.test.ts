import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { PROXY_ROUTES } from "@csd/core";
import { createProxy, memoryStore, NO_TILE_PNG } from "../src";
import { config } from "./helpers";


const fetchMustNotRun = (() => { throw new Error("fixtures mode must never reach a tile server"); }) as unknown as typeof globalThis.fetch;
const proxyWith = (lookup: Parameters<typeof createProxy>[1]["fixtureTiles"]) =>
  createProxy(config, { fetch: fetchMustNotRun, store: memoryStore(), now: () => Date.now(), userKey: () => "u", fixtureTiles: lookup });
const getTile = (proxy: ReturnType<typeof proxyWith>, z: number, x: number, y: number) =>
  proxy(new Request(`https://app.test${PROXY_ROUTES.tile}/${z}/${x}/${y}.png`));

describe("the neutral 'no tile' PNG", () => {
  it("is a 256 x 256 flat light-grey PNG", () => {
    expect(Array.from(NO_TILE_PNG.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const png = PNG.sync.read(Buffer.from(NO_TILE_PNG));
    expect([png.width, png.height]).toEqual([256, 256]);
    const first = [png.data[0], png.data[1], png.data[2], png.data[3]];
    expect(first).toEqual([0xe9, 0xe9, 0xe9, 0xff]);
    for (let i = 0; i < png.data.length; i += 4 * 997) expect([png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]]).toEqual(first);
  });
});

describe("fixtures mode in the proxy", () => {
  it("serves captured tiles and the grey tile elsewhere, without any network", async () => {
    const real = new Uint8Array([...NO_TILE_PNG.slice(0, 8), 7, 7, 7]);
    const proxy = proxyWith((z, x, y) => (z === 16 && x === 1 && y === 2 ? real : null));
    const hit = await getTile(proxy, 16, 1, 2);
    expect(hit.status).toBe(200);
    expect(hit.headers.get("content-type")).toBe("image/png");
    expect(hit.headers.get("x-proxy-cache")).toBe("fixture");
    expect(new Uint8Array(await hit.arrayBuffer())).toEqual(real);
    const miss = await getTile(proxy, 16, 1, 3);
    expect(new Uint8Array(await miss.arrayBuffer())).toEqual(NO_TILE_PNG);
  });

  it("still validates the tile address, and leaves terrain on its normal path", async () => {
    const proxy = proxyWith(() => null);
    expect((await getTile(proxy, 25, 1, 1)).status).toBe(400);
    expect((await getTile(proxy, 3, 9, 1)).status).toBe(400);
    const terrain = await proxy(new Request(`https://app.test${PROXY_ROUTES.terrain}/15/1/1.png`));
    // Terrain isn't faked: it would call the (here forbidden) upstream, which the proxy reports as an error response.
    expect(terrain.status).toBeGreaterThanOrEqual(500);
  });

  it("is off unless asked for", async () => {
    const proxy = createProxy(config, {
      fetch: (async () => new Response(new Uint8Array([...NO_TILE_PNG]), { headers: { "content-type": "image/png" } })) as unknown as typeof fetch,
      store: memoryStore(), now: () => Date.now(), userKey: () => "u",
    });
    const res = await getTile(proxy, 16, 1, 2);
    expect(res.headers.get("x-proxy-cache")).toBe("miss"); // fetched from "upstream"
  });
});
