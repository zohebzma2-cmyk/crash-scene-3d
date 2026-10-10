// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROXY_ROUTES, type PlaceResult } from "@csd/core";
import { NO_AREA_TEXT } from "../src/components/SearchPanel";
import { fakeSplitCrossingQuery } from "../src/services/fakes";
import { searchUrl } from "../src/services/geo";
import { claimTown } from "../src/state/claimTown";
import { initialDoc } from "../src/state/doc";
import { all, flush, get, key, renderApp, setValue, text } from "./helpers";
import { makeServices } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); });

const input = () => document.querySelector<HTMLTextAreaElement>("form[role=search] textarea")!;
const type = async (t: string, wait = 350) => { setValue(input(), t); await flush(wait); };
const nashua = { lat: 42.7654, lon: -71.4676 };
const place = (main: string, over: Partial<PlaceResult> = {}): PlaceResult => ({ label: `${main}, NH`, main, sub: "NH", lat: 42.76, lon: -71.46, kind: "road", ...over });

async function open(claimAddress?: string) {
  const made = makeServices();
  const suggest = made.services.geo.suggest as ReturnType<typeof vi.fn>;
  suggest.mockImplementation(async (q: string) => (q === "Nashua, NH" ? [place("Nashua", { category: "place", ...nashua })] : []));
  const cross = made.services.geo.crossStreets as ReturnType<typeof vi.fn>;
  cross.mockResolvedValue({ street: "Main Street", crossings: [{ name: "Park Street", lat: 42.76, lon: -71.46, points: [{ lat: 42.76, lon: -71.46 }], osmWayIds: [] }] });
  app = await renderApp(made.services, claimAddress == null ? {} : { storage: { ...initialDoc(), claimAddress } });
  return { ...made, suggest, cross };
}

describe("the claim's town stands in for the area", () => {
  it("sends nothing before anything is typed, even though the claim has a town", async () => {
    const { suggest, cross } = await open();
    await flush(600);
    expect(suggest).not.toHaveBeenCalled();
    expect(cross).not.toHaveBeenCalled();
  });

  it("'Main St and Park' with no pin finds the crossing near the claim's town, looking the town up once", async () => {
    const { suggest, cross } = await open();
    await type("Main Street and Park");
    await flush(400);
    expect(suggest.mock.calls.map((c) => c[0])).toEqual(["Nashua, NH"]);
    expect(cross).toHaveBeenCalledWith("Main Street", nashua, expect.anything());
    expect(all("option").map((o) => o.querySelector(".r-main")?.textContent)).toEqual(["Park Street"]);
    expect(text(get("[role=listbox]").parentElement!)).not.toContain(NO_AREA_TEXT);
    await type("Main Street and Pa");
    await flush(400);
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it("an Enter search with no pin sends the claim's town as the near text", async () => {
    const { services } = await open();
    setValue(input(), "Main Street and Park");
    key(input(), "Enter");
    await flush();
    expect((services.geo.search as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toMatchObject({ town: "Nashua, NH" });
  });

  it("with no town on the claim either, it asks for the place, and sends nothing", async () => {
    const { suggest, cross } = await open("Main Street");
    await type("Main Street and Park");
    await flush(400);
    expect(text(get("[role=listbox]").parentElement!)).toContain(NO_AREA_TEXT);
    expect(suggest).not.toHaveBeenCalled();
    expect(cross).not.toHaveBeenCalled();
  });

  it("a town that can't be found gives the same message", async () => {
    const { suggest, cross } = await open("Main Street and Park Street, Atlantis, ZZ");
    await type("Main Street and Park");
    await flush(400);
    expect(suggest.mock.calls.map((c) => c[0])).toEqual(["Atlantis, ZZ"]);
    expect(text(get("[role=listbox]").parentElement!)).toContain(NO_AREA_TEXT);
    expect(cross).not.toHaveBeenCalled();
  });
});

describe("claimTown", () => {
  it.each([
    ["Main Street and Park Street, Nashua, NH", "Nashua, NH"],
    ["123 Main St, Nashua, NH 03060", "Nashua, NH 03060"],
    ["Main Street and Park Street", null],
    ["", null],
    ["Main Street,", null],
  ])("%j", (address, want) => {
    expect(claimTown(address)).toBe(want);
  });
});

describe("the claim's town as the crossing's near text", () => {
  const split = fakeSplitCrossingQuery;
  const near = (url: string) => new URL(url, "http://x").searchParams.get("near");
  it("fills in near when the text names no town and there is no bias", () => {
    const url = new URL(searchUrl("Main Street and Park Street", split, null, "Nashua, NH"), "http://x");
    expect(url.pathname).toBe(PROXY_ROUTES.crossing);
    expect(url.searchParams.get("a")).toBe("Main Street");
    expect(url.searchParams.get("b")).toBe("Park Street");
    expect(url.searchParams.get("near")).toBe("Nashua, NH");
  });
  it("a town typed in the text wins, and a known point makes the town unnecessary", () => {
    expect(near(searchUrl("Main Street and Park Street, Derry, NH", split, null, "Nashua, NH"))).toBe("Derry, NH");
    expect(near(searchUrl("Main Street and Park Street", split, { lat: 42.7, lon: -71.4 }, "Nashua, NH"))).toBe("");
    expect(near(searchUrl("Main Street and Park Street", split, null, null))).toBe("");
  });
});
