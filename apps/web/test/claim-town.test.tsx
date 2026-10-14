// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, PROXY_ROUTES, type PlaceResult } from "@csd/core";
import { BUSY_RETRY_TEXT, FAR_SUFFIX, NO_AREA_TEXT, SUGGEST_SLOW_TEXT, noTownText, rankForClaim, townAfterComma } from "../src/components/SearchPanel";
import { fakeSplitCrossingQuery } from "../src/services/fakes";
import { searchUrl } from "../src/services/geo";
import { ServiceError, type StreetInTown, type TownPlace } from "../src/services/types";
import { claimTown } from "../src/state/claimTown";
import { initialDoc } from "../src/state/doc";
import { all, click, flush, get, key, renderApp, setValue, text } from "./helpers";
import { makeServices } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); });

const input = () => document.querySelector<HTMLTextAreaElement>("form[role=search] textarea")!;
// The first keystroke looks up the claim's town; suggestions wait for it, so let that answer land (one more act) first.
const type = async (t: string, wait = 350) => { setValue(input(), t); await flush(0); await flush(wait); };
const nashua = { lat: 42.7654, lon: -71.4676 };
const NASHUA: TownPlace = { point: nashua, state: "NH", label: "Nashua, NH" };
const place = (main: string, sub: string, over: Partial<PlaceResult> = {}): PlaceResult => ({ label: `${main}, ${sub}`, main, sub, lat: 42.76, lon: -71.46, kind: "road", ...over });
const LYONS = place("Main Street", "Lyons, CO", { category: "street", state: "CO", lat: 40.2235, lon: -105.2663, osmWayIds: [9] });
const MAIN_NASHUA = place("Main Street", "Nashua, NH", { category: "street", state: "NH", lat: 42.7644, lon: -71.467, osmWayIds: [11, 12] });
const mainText = () => all("option").map((o) => text(o));

async function open(claimAddress?: string) {
  const made = makeServices();
  const geo = made.services.geo;
  const suggest = geo.suggest as ReturnType<typeof vi.fn>;
  const town = geo.town as ReturnType<typeof vi.fn>;
  town.mockImplementation(async (t: string) => (t === "Nashua, NH" ? NASHUA : null));
  const cross = geo.crossStreets as ReturnType<typeof vi.fn>;
  cross.mockResolvedValue({ street: "Main Street", crossings: [{ name: "Park Street", lat: 42.76, lon: -71.46, points: [{ lat: 42.76, lon: -71.46 }], osmWayIds: [] }] });
  app = await renderApp(made.services, claimAddress == null ? {} : { storage: { ...initialDoc(), claimAddress } });
  return { ...made, suggest, town, cross, streetIn: geo.streetIn as ReturnType<typeof vi.fn> };
}

describe("the claim's town stands in for the area", () => {
  it("sends nothing before anything is typed, even though the claim has a town", async () => {
    const { suggest, cross, town } = await open();
    await flush(600);
    expect(town).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
    expect(cross).not.toHaveBeenCalled();
  });

  it("'Main St' on a fresh page: the claim's town is looked up first and the very first suggestions are biased to it", async () => {
    const { suggest, town } = await open();
    let release: (t: TownPlace) => void = () => undefined;
    town.mockImplementation(() => new Promise<TownPlace>((r) => { release = r; }));
    suggest.mockResolvedValue([LYONS, MAIN_NASHUA]);
    await type("Main St", 600);
    // Still finding Nashua: nothing unbiased goes out meanwhile.
    expect(town.mock.calls.map((c) => c[0])).toEqual(["Nashua, NH"]);
    expect(suggest).not.toHaveBeenCalled();
    expect(text(get("[role=listbox]").parentElement!)).toContain("Searching…");
    await act(async () => { release(NASHUA); await Promise.resolve(); });
    await flush(350);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0]?.[0]).toBe("Main St");
    expect(suggest.mock.calls[0]?.[1]?.bias).toEqual(nashua);
    // The Colorado street goes last and says it is far from the claim.
    expect(mainText()).toEqual(["Main StreetNashua, NH", `Main StreetLyons, CO${FAR_SUFFIX}`]);
    await type("Main Str");
    expect(town).toHaveBeenCalledTimes(1);
  });

  it("with a pin, the pin is the bias; the claim's town still labels far results", async () => {
    const { suggest } = await open();
    suggest.mockResolvedValueOnce([place("Nashua City Hall", "Nashua, NH", { category: "place", lat: 42.7591, lon: -71.4636 })]);
    await type("City Hall");
    key(input(), "ArrowDown");
    key(input(), "Enter");
    await flush();
    suggest.mockResolvedValue([LYONS, MAIN_NASHUA]);
    await type("Main St");
    expect(suggest.mock.calls.at(-1)?.[1]?.bias).toEqual({ lat: 42.7591, lon: -71.4636 });
    expect(mainText()).toEqual(["Main StreetNashua, NH", `Main StreetLyons, CO${FAR_SUFFIX}`]);
  });

  it("never sends the claim's town once a pin exists (the pin is the bias)", async () => {
    const { suggest, town, search } = await open();
    // Tap Search on the prefilled claim address without typing, pick the result: a pin, and nothing typed yet.
    key(input(), "Enter");
    await flush();
    click(document.querySelector<HTMLButtonElement>(".results button"));
    await flush();
    expect(search).toHaveBeenCalledTimes(1);
    await type("Main St");
    expect(town).not.toHaveBeenCalled();
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0]?.[1]?.bias).not.toBeNull();
    expect(suggest.mock.calls[0]?.[1]?.bias).not.toEqual(nashua);
  });

  it("'Main St and Park' with no pin finds the crossing near the claim's town, looking the town up once", async () => {
    const { suggest, cross, town } = await open();
    await type("Main Street and Park");
    await flush(400);
    expect(town.mock.calls.map((c) => c[0])).toEqual(["Nashua, NH"]);
    expect(suggest).not.toHaveBeenCalled();
    expect(cross).toHaveBeenCalledWith("Main Street", nashua, expect.anything());
    expect(all("option").map((o) => o.querySelector(".r-main")?.textContent)).toEqual(["Park Street"]);
    expect(text(get("[role=listbox]").parentElement!)).not.toContain(NO_AREA_TEXT);
    await type("Main Street and Pa");
    await flush(400);
    expect(town).toHaveBeenCalledTimes(1);
  });

  it("an Enter search with no pin sends the claim's town as the near text", async () => {
    const { services } = await open();
    setValue(input(), "Main Street and Park");
    key(input(), "Enter");
    await flush();
    expect((services.geo.search as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toMatchObject({ town: "Nashua, NH" });
  });

  it("with no town on the claim either, it asks for the place, and sends nothing", async () => {
    const { suggest, cross, town } = await open("Main Street");
    await type("Main Street and Park");
    await flush(400);
    expect(text(get("[role=listbox]").parentElement!)).toContain(NO_AREA_TEXT);
    expect(town).not.toHaveBeenCalled();
    expect(suggest).not.toHaveBeenCalled();
    expect(cross).not.toHaveBeenCalled();
  });

  it("a town that can't be found gives the same message", async () => {
    const { cross, town } = await open("Main Street and Park Street, Atlantis, ZZ");
    await type("Main Street and Park");
    await flush(400);
    expect(town.mock.calls.map((c) => c[0])).toEqual(["Atlantis, ZZ"]);
    expect(text(get("[role=listbox]").parentElement!)).toContain(NO_AREA_TEXT);
    expect(cross).not.toHaveBeenCalled();
  });

  it("typing ' and' after a picked street asks for no suggestions: its crossings stay up", async () => {
    const { suggest, cross } = await open();
    suggest.mockResolvedValue([MAIN_NASHUA]);
    await type("Main St");
    click(all("option")[0]!);
    await flush(400);
    suggest.mockClear();
    for (const t of ["Main Street ", "Main Street a", "Main Street an", "Main Street and", "Main Street and ", "Main Street and Pa"]) await type(t);
    expect(suggest).not.toHaveBeenCalled();
    expect(cross).toHaveBeenCalledTimes(1);
    expect(cross.mock.calls[0]?.[2]).toMatchObject({ ways: [11, 12] });
    expect(all("option").map((o) => o.querySelector(".r-main")?.textContent)).toEqual(["Park Street"]);
  });
});

describe("a town typed after the comma ('Elm St and Hanover St, Manchester NH')", () => {
  const ELM: StreetInTown = { name: "Elm Street", at: { lat: 42.9869, lon: -71.4631 }, ways: [480861315, 5593117], place: "Manchester, NH" };
  const elmCrossings = { street: "Elm Street", crossings: [
    { name: "Lake Avenue", lat: 42.9872, lon: -71.463, points: [{ lat: 42.9872, lon: -71.463 }], osmWayIds: [] },
    { name: "Hanover Street", lat: 42.99091, lon: -71.46312, points: [{ lat: 42.99091, lon: -71.46312 }], osmWayIds: [] },
  ] };

  it("finds the first street in that town, not near the claim, and offers the crossing with the second", async () => {
    const { streetIn, cross, suggest } = await open();
    streetIn.mockResolvedValue(ELM);
    cross.mockResolvedValue(elmCrossings);
    await type("Elm St and Hanover St, Manchester NH");  // the street-in-town lookup after the pause
    await flush(400);                                       // then the cross streets after theirs
    expect(streetIn.mock.calls.map((c) => [c[0], c[1]])).toEqual([["Elm St", "Manchester NH"]]);
    expect(cross).toHaveBeenCalledTimes(1);
    expect(cross.mock.calls[0]?.[0]).toBe("Elm Street");
    expect(cross.mock.calls[0]?.[1]).toEqual(ELM.at);
    expect(cross.mock.calls[0]?.[2]).toMatchObject({ ways: ELM.ways });
    expect(suggest).not.toHaveBeenCalled();
    expect(mainText()).toEqual(["Hanover StreetManchester, NH"]);
    click(all("option")[0]!);
    await flush();
    expect(text()).toContain("42.99091, -71.46312");
    expect(input().value).toBe("Elm Street & Hanover Street, Manchester, NH");
  });

  it("says so plainly when the street or the town can't be found, and asks nothing else", async () => {
    const { streetIn, cross } = await open();
    await type("Elm St and Hanover St, Atlantis ZZ");
    await flush(400);
    expect(streetIn).toHaveBeenCalledTimes(1);
    expect(cross).not.toHaveBeenCalled();
    expect(text(get("[role=listbox]").parentElement!)).toContain(noTownText("Elm St", "Atlantis ZZ"));
  });

  it("townAfterComma: only text after a comma, 3 characters or more", () => {
    expect(townAfterComma("Hanover St, Manchester NH")).toBe("Manchester NH");
    expect(townAfterComma("Hanover St,  Ma")).toBeNull();
    expect(townAfterComma("Hanover St")).toBeNull();
  });
});

describe("far from the claim", () => {
  it("ranks results more than 300 km away, or in another state more than 50 km away, last, in their order", () => {
    const fitchburg = place("Main Street", "Fitchburg, MA", { state: "MA", lat: 42.58, lon: -71.80 });   // ~33 km, another state: near
    const boston = place("Main Street", "Boston, MA", { state: "MA", lat: 42.36, lon: -71.06 });     // ~56 km, another state: far
    const hanover = place("Main Street", "Hanover, NH", { state: "NH", lat: 43.70, lon: -72.29 });   // ~125 km, same state: near
    const ranked = rankForClaim([LYONS, boston, fitchburg, hanover, MAIN_NASHUA], nashua, "NH");
    expect(ranked.map((r) => [r.place.sub, r.far])).toEqual([
      ["Fitchburg, MA", false], ["Hanover, NH", false], ["Nashua, NH", false], ["Lyons, CO", true], ["Boston, MA", true],
    ]);
    expect(rankForClaim([LYONS], null, null)).toEqual([{ place: LYONS, far: false }]);
  });
});

describe("busy: tried once more, never an empty list", () => {
  it("shows 'Busy, trying again…' while the retry runs, then the suggestions", async () => {
    const { suggest } = await open();
    let release: (r: PlaceResult[]) => void = () => undefined;
    suggest.mockImplementation((_q: string, o: { onBusy?: () => void }) => new Promise<PlaceResult[]>((r) => { o.onBusy?.(); release = r; }));
    await type("Main St");
    expect(text(get("[role=listbox]").parentElement!)).toContain(BUSY_RETRY_TEXT);
    await act(async () => { release([MAIN_NASHUA]); await Promise.resolve(); });
    await flush();
    expect(mainText()).toEqual(["Main StreetNashua, NH"]);
  });

  it("'Busy, trying again…' never outlives its load: the same text asked again doesn't say it", async () => {
    const { suggest } = await open();
    suggest.mockImplementationOnce((_q: string, o: { onBusy?: () => void }) => { o.onBusy?.(); return Promise.reject(new ServiceError(BUSY_MESSAGE, "busy", 1)); });
    await type("Main St");
    // Still busy after the retry: the suggestion list points to Search (the crossing list keeps the busy message, below).
    expect(text(get("[role=listbox]").parentElement!)).toContain(SUGGEST_SLOW_TEXT);
    suggest.mockImplementation(() => new Promise<PlaceResult[]>(() => undefined));
    await type("Main S");
    await type("Main St");
    expect(text(get("[role=listbox]").parentElement!)).not.toContain(BUSY_RETRY_TEXT);
  });

  it("the crossing list says 'Busy, trying again…', and if that fails too, a plain message", async () => {
    const { suggest, cross } = await open();
    suggest.mockResolvedValue([MAIN_NASHUA]);
    let fail: (e: unknown) => void = () => undefined;
    cross.mockImplementation((_s: string, _n: unknown, o: { onBusy?: () => void }) => new Promise((_r, rej) => { o.onBusy?.(); fail = rej; }));
    await type("Main St");
    click(all("option")[0]!);
    await flush(400);
    expect(text(get("[role=listbox]").parentElement!)).toContain(BUSY_RETRY_TEXT);
    await act(async () => { fail(new ServiceError(BUSY_MESSAGE, "busy", 1)); await Promise.resolve(); });
    await flush();
    const pop = text(get("[role=listbox]").parentElement!);
    expect(pop).toContain(BUSY_MESSAGE);
    expect(pop).not.toContain(BUSY_RETRY_TEXT);
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
