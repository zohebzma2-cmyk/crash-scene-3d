// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUSY_MESSAGE, BUSY_MESSAGES, TIMEOUT_MESSAGE, TIMEOUT_MESSAGES, UPSTREAM_MESSAGES, type CrossStreetsResult, type PlaceResult as Suggestion } from "@csd/core";
import { ServiceError } from "../src/services/types";
import {
  MAX_QUERY_CHARS, MAX_STREET_CHARS, NO_AREA_TEXT, SEARCH_FAILED_TEXT, STREET_TOO_LONG_TEXT, SUGGEST_SLOW_TEXT, TOO_LONG_TEXT, splitIntersection, suggestFailureText,
} from "../src/components/SearchPanel";
import { all, click, flush, get, key, maybe, renderApp, setValue, text } from "./helpers";
import { MAIN_PARK, makeServices } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.restoreAllMocks(); });

const input = () => document.querySelector<HTMLTextAreaElement>("form[role=search] textarea")!;
const sug = (main: string, sub: string, extra: Partial<Suggestion> = {}): Suggestion => ({ label: `${main}, ${sub}`, main, sub, lat: 42.76, lon: -71.46, kind: "road", ...extra });
const options = () => all("option");
// The first keystroke looks up the claim's town; suggestions wait for it, so let that answer land (one more act) first.
const type = async (t: string, wait = 350) => { setValue(input(), t); await flush(0); await flush(wait); };

async function open(over: Parameters<typeof makeServices>[0] = {}) {
  const made = makeServices(over);
  app = await renderApp(made.services);
  return made;
}

describe("type-ahead combobox", () => {
  it("sends nothing for the prefilled claim address, nothing under 3 characters, and one request after a 300 ms pause", async () => {
    const { services } = await open();
    const suggest = services.geo.suggest as ReturnType<typeof vi.fn>;
    await flush(400);
    expect(suggest).not.toHaveBeenCalled();
    await type("Ma", 400);
    expect(suggest).not.toHaveBeenCalled();
    // four quick keystrokes: only the last text is asked for, once, after the pause
    setValue(input(), "Mai");
    setValue(input(), "Main");
    await flush(200);
    expect(suggest).not.toHaveBeenCalled();
    setValue(input(), "Main S");
    await flush(150);
    expect(suggest).not.toHaveBeenCalled();
    await flush(250);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0]?.[0]).toBe("Main S");
  });

  it("shows each suggestion's name with 'Town, State', and the attribution under the list", async () => {
    const { services } = await open();
    (services.geo.suggest as ReturnType<typeof vi.fn>).mockResolvedValue([sug("Main Street", "Nashua, NH", { category: "street" }), sug("Nashua City Hall", "Nashua, NH", { category: "place" })]);
    await type("Nashua");
    expect(get("listbox").getAttribute("aria-labelledby")).toBeTruthy();
    expect(text(get("[role=listbox]").previousElementSibling!)).toBe("Suggestions");
    expect(options().map((o) => text(o))).toEqual(["Main StreetNashua, NH", "Nashua City HallNashua, NH"]);
    expect(options()[0]?.querySelector(".r-sub")?.textContent).toBe("Nashua, NH");
    expect(text(document.querySelector(".combo-attrib")!)).toBe("Search by Photon · Nominatim · © OpenStreetMap contributors");
  });

  it("is a combobox: roles, aria-expanded, arrow keys with aria-activedescendant, wrap, Enter picks, Escape closes", async () => {
    const { services } = await open();
    (services.geo.suggest as ReturnType<typeof vi.fn>).mockResolvedValue([sug("Elm Street", "Nashua, NH", { category: "place" }), sug("Elm Avenue", "Hudson, NH", { category: "place", lat: 42.8, lon: -71.4 })]);
    expect(input().getAttribute("role")).toBe("combobox");
    expect(input().getAttribute("aria-autocomplete")).toBe("list");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    await type("Elm");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(input().getAttribute("aria-controls")).toBe(get("listbox").id);
    expect(options().map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "false"]);
    key(input(), "ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    key(input(), "ArrowDown");
    key(input(), "ArrowDown");                         // wraps to the first
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    key(input(), "ArrowUp");                           // and back to the last
    expect(input().getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    key(input(), "Escape");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(maybe("listbox")).toBeNull();
    key(input(), "ArrowDown");                         // opens again
    expect(input().getAttribute("aria-expanded")).toBe("true");
    key(input(), "ArrowDown");
    key(input(), "Enter");                             // picks the highlighted one
    await flush();
    expect(text()).toContain("42.80000, -71.40000");
    expect(input().value).toBe("Elm Avenue, Hudson, NH");
    expect(maybe("listbox")).toBeNull();
  });

  it("Enter with nothing highlighted runs the on-submit Nominatim search, as before", async () => {
    const { services, search } = await open();
    (services.geo.suggest as ReturnType<typeof vi.fn>).mockResolvedValue([sug("Elm Street", "Nashua, NH", { category: "place" })]);
    await type("Elm Street");
    expect(search).not.toHaveBeenCalled();
    key(input(), "Enter");
    await flush();
    expect(search).toHaveBeenCalledWith("Elm Street", expect.anything());
    expect(text()).toContain(MAIN_PARK.main);
  });

  it("ignores a stale answer and aborts the request it replaced", async () => {
    const { services } = await open();
    const suggest = services.geo.suggest as ReturnType<typeof vi.fn>;
    const calls: Array<{ q: string; signal: AbortSignal; resolve: (r: Suggestion[]) => void }> = [];
    suggest.mockImplementation((q: string, o: { signal: AbortSignal }) => new Promise<Suggestion[]>((resolve) => { calls.push({ q, signal: o.signal, resolve }); }));
    await type("Jackm");
    expect(calls).toHaveLength(1);
    await type("Birchwood");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);
    await act(async () => { calls[0]!.resolve([sug("Old answer", "Nowhere, NH")]); await Promise.resolve(); });
    expect(text()).not.toContain("Old answer");
    await act(async () => { calls[1]!.resolve([sug("Birchwood Lane", "Fairview, NH")]); await Promise.resolve(); });
    await flush();
    expect(options().map((o) => o.querySelector(".r-main")?.textContent)).toEqual(["Birchwood Lane"]);
  });

  it("biases the search to the pin when there is one, else leaves it off", async () => {
    const { services } = await open();
    const suggest = services.geo.suggest as ReturnType<typeof vi.fn>;
    await type("Main Street");
    expect(suggest.mock.calls.at(-1)?.[1]?.bias).toBeNull();
    // pick a place to put the pin, then search again: the bias is the pin
    suggest.mockResolvedValueOnce([sug("Nashua City Hall", "Nashua, NH", { category: "place", lat: 42.7654, lon: -71.4676 })]);
    await type("City Hall");
    key(input(), "ArrowDown");
    key(input(), "Enter");
    await flush();
    await type("Park Street");
    expect(suggest.mock.calls.at(-1)?.[1]?.bias).toEqual({ lat: 42.7654, lon: -71.4676 });
  });

  it("shows a failed suggestion request as text, and says so when nothing matches", async () => {
    const { services } = await open();
    const suggest = services.geo.suggest as ReturnType<typeof vi.fn>;
    suggest.mockRejectedValueOnce(new ServiceError(UPSTREAM_MESSAGES.search, "upstream"));
    await type("Broken");
    expect(text(get("[role=listbox]").parentElement!)).toContain(UPSTREAM_MESSAGES.search);
    suggest.mockRejectedValueOnce(new Error("no idea"));
    await type("Stranger");
    expect(text(get("[role=listbox]").parentElement!)).toContain(SEARCH_FAILED_TEXT);
    suggest.mockResolvedValueOnce([]);
    await type("Nothing here");
    expect(text(get("[role=listbox]").parentElement!)).toContain("No matches yet. Press Enter to search, or tap the map where it happened.");
  });

  it.each([
    ["timed out at the proxy", new ServiceError(TIMEOUT_MESSAGES.search, "timeout", 5)],
    ["timed out in the browser", new ServiceError(TIMEOUT_MESSAGE, "timeout")],
    ["still busy after its retry", new ServiceError(BUSY_MESSAGES.search, "busy", 1)],
  ])("type-ahead that %s says it is slow and points to Search, which still works", async (_how, failure) => {
    const { services, search } = await open();
    const suggest = services.geo.suggest as ReturnType<typeof vi.fn>;
    suggest.mockRejectedValue(failure);
    await type("Elm St");
    const list = get("[role=listbox]").parentElement!;
    expect(text(list)).toContain(SUGGEST_SLOW_TEXT);
    expect(text(list)).not.toContain(failure.message);
    expect(list.querySelector(".combo-note[role=status]")?.textContent).toBe(SUGGEST_SLOW_TEXT);
    expect(options()).toHaveLength(0);
    // Nothing else is asked while typing: the on-submit (Nominatim) search runs only when the claimant asks for it.
    expect(search).not.toHaveBeenCalled();
    key(input(), "Enter");
    await flush();
    expect(search).toHaveBeenCalledWith("Elm St", expect.anything());
    expect(text()).toContain(MAIN_PARK.main);
  });

  it("words the failures: slow or busy points to Search, anything else keeps its own message", () => {
    expect(suggestFailureText(new ServiceError(TIMEOUT_MESSAGES.search, "timeout"))).toBe(SUGGEST_SLOW_TEXT);
    expect(suggestFailureText(new ServiceError(BUSY_MESSAGES.search, "busy"))).toBe(SUGGEST_SLOW_TEXT);
    expect(suggestFailureText(new ServiceError("We couldn't reach the map service.", "network"))).toBe("We couldn't reach the map service.");
    expect(suggestFailureText(new ServiceError(UPSTREAM_MESSAGES.search, "upstream"))).toBe(UPSTREAM_MESSAGES.search);
    expect(suggestFailureText(new TypeError("x"))).toBe(SEARCH_FAILED_TEXT);
  });

  it("shows a spinner while it searches", async () => {
    const { services } = await open();
    (services.geo.suggest as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => undefined));
    await type("Slow street");
    expect(input().getAttribute("aria-busy")).toBe("true");
    expect(text(get("[role=listbox]").parentElement!)).toContain("Searching…");
  });

  it("renders suggestion text as text, never as HTML", async () => {
    const { services } = await open();
    (services.geo.suggest as ReturnType<typeof vi.fn>).mockResolvedValue([sug("<img src=x onerror=window.__p=1>", "<b>Town</b>, NH")]);
    await type("Weird");
    expect(text(options()[0]!)).toContain("<img src=x onerror=window.__p=1>");
    expect(document.querySelector("img[src=x]")).toBeNull();
    expect(options()[0]!.querySelector("b")).toBeNull();
  });
});

describe("crossing streets", () => {
  /** The crossing list needs somewhere to look: put the pin down first (the map will pass its centre too). */
  async function openPinned() {
    const made = await open();
    (made.services.geo.suggest as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sug("Nashua City Hall", "Nashua, NH", { category: "place", lat: 42.7654, lon: -71.4676 })]);
    await type("City Hall");
    key(input(), "ArrowDown");
    key(input(), "Enter");
    await flush();
    (made.services.geo.suggest as ReturnType<typeof vi.fn>).mockClear();
    return made;
  }
  const crossings = (over: Partial<CrossStreetsResult> = {}): CrossStreetsResult => ({
    street: "Birchwood Lane",
    crossings: [
      { name: "Quarry Hill Road", lat: 44.2011, lon: -72.6011, points: [{ lat: 44.2011, lon: -72.6011 }], osmWayIds: [], place: "Fairview, NH" },
      { name: "Sawmill Court", lat: 44.2022, lon: -72.6022, osmWayIds: [], points: [{ lat: 44.2022, lon: -72.6022 }, { lat: 44.2033, lon: -72.6033 }], place: "Fairview, NH" },
      { name: "Pine Street", lat: 44.2044, lon: -72.6044, points: [{ lat: 44.2044, lon: -72.6044 }], osmWayIds: [] },
    ],
    ...over,
  });

  it("after 'and', '&' or 'at', lists only the streets that cross, filtered by what is typed after it", async () => {
    const { services } = await openPinned();
    const cross = services.geo.crossStreets as ReturnType<typeof vi.fn>;
    cross.mockResolvedValue(crossings());
    for (const sep of ["and", "&", "at", "AND"]) {
      await type(`Birchwood Lane ${sep} `);
      expect(cross.mock.calls.at(-1)?.[0]).toBe("Birchwood Lane");
      expect(text(get("[role=listbox]").previousElementSibling!)).toBe("Crossing streets");
    }
    // nothing typed after the separator: every crossing street, "Sawmill Court" once per place
    expect(options().map((o) => text(o))).toEqual(["Quarry Hill RoadFairview, NH", "Sawmill CourtFairview, NH · crossing 1 of 2", "Sawmill CourtFairview, NH · crossing 2 of 2", "Pine Street"]);
    await type("Birchwood Lane & qu");
    expect(options().map((o) => o.querySelector(".r-main")?.textContent)).toEqual(["Quarry Hill Road"]);
    await type("Birchwood Lane & pi");
    expect(options().map((o) => o.querySelector(".r-main")?.textContent)).toEqual(["Pine Street"]);
  });

  it("does not ask for suggestions of the whole text while it is an intersection", async () => {
    const { services } = await openPinned();
    (services.geo.crossStreets as ReturnType<typeof vi.fn>).mockResolvedValue(crossings());
    await type("Birchwood Lane and Qua");
    expect(services.geo.suggest).not.toHaveBeenCalled();
  });

  it("drops the pin exactly on the crossing point that was picked, and names the intersection", async () => {
    const { services } = await openPinned();
    (services.geo.crossStreets as ReturnType<typeof vi.fn>).mockResolvedValue(crossings());
    await type("Birchwood Lane and ");
    click(options().find((o) => text(o).includes("crossing 2 of 2"))!);
    await flush();
    expect(text()).toContain("44.20330, -72.60330");        // the second crossing of Sawmill Court, to the digit
    expect(input().value).toBe("Birchwood Lane & Sawmill Court, Fairview, NH");
    expect(text()).toContain("From search: Birchwood Lane & Sawmill Court");
    expect(maybe("listbox")).toBeNull();
    const stored = JSON.parse(window.sessionStorage.getItem("crash-scene-3d/doc/v4") ?? "{}") as { scene: { location: { lat: number; lon: number; label: string } } };
    expect(stored.scene.location).toMatchObject({ lat: 44.2033, lon: -72.6033 });
  });

  it("says plainly when nothing crosses, and what to do", async () => {
    const { services } = await openPinned();
    (services.geo.crossStreets as ReturnType<typeof vi.fn>).mockResolvedValue({ street: "Birchwood Lane", crossings: [] });
    await type("Birchwood Lane and ");
    expect(options()).toHaveLength(0);
    expect(text(get("[role=listbox]").parentElement!)).toContain("No streets cross Birchwood Lane near here. Try the other street first, or drop the pin on the map.");
  });

  it("filters to nothing: the same message names the street", async () => {
    const { services } = await openPinned();
    (services.geo.crossStreets as ReturnType<typeof vi.fn>).mockResolvedValue(crossings());
    await type("Birchwood Lane & zzz");
    expect(text(get("[role=listbox]").parentElement!)).toContain("No streets cross Birchwood Lane near here.");
  });

  it("after a street is picked from the suggestions, the crossing list shows without typing a separator, asking about those exact ways", async () => {
    const { services } = await open();
    const cross = services.geo.crossStreets as ReturnType<typeof vi.fn>;
    cross.mockResolvedValue(crossings());
    (services.geo.suggest as ReturnType<typeof vi.fn>).mockResolvedValue([sug("Birchwood Lane", "Fairview, NH", { category: "street", osmWayIds: [11, 22], lat: 44.2, lon: -72.6 })]);
    await type("Birchwood");
    key(input(), "ArrowDown");
    key(input(), "Enter");
    await flush(350);
    expect(input().value).toBe("Birchwood Lane");
    expect(cross).toHaveBeenCalledWith("Birchwood Lane", { lat: 44.2, lon: -72.6 }, expect.objectContaining({ ways: [11, 22] }));
    expect(text(get("[role=listbox]").previousElementSibling!)).toBe("Crossing streets");
    // the street alone is not a place: no pin yet
    expect(text()).toContain("No pin yet");
    click(options()[0]!);
    await flush();
    expect(text()).toContain("44.20110, -72.60110");
  });

  it("a crossing street shows its error as text", async () => {
    const { services } = await openPinned();
    (services.geo.crossStreets as ReturnType<typeof vi.fn>).mockRejectedValue(new ServiceError(BUSY_MESSAGE, "busy"));
    await type("Birchwood Lane and ");
    expect(text(get("[role=listbox]").parentElement!)).toContain(BUSY_MESSAGE);
  });
});

describe("input limits and the area to look in", () => {
  const cross = (s: Awaited<ReturnType<typeof open>>) => s.services.geo.crossStreets as ReturnType<typeof vi.fn>;

  it("stops the field at 120 characters", async () => {
    await open();
    expect(input().maxLength).toBe(MAX_QUERY_CHARS);
  });

  it("always sends where to look: the pin, never a request with no area", async () => {
    const made = await open();
    // no pin, no map centre, no street picked: say so plainly and send nothing
    await type("Birchwood Lane and ");
    expect(cross(made)).not.toHaveBeenCalled();
    expect(text(get("[role=listbox]").parentElement!)).toContain(NO_AREA_TEXT);
    (made.services.geo.suggest as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sug("Nashua City Hall", "Nashua, NH", { category: "place", lat: 42.7654, lon: -71.4676 })]);
    await type("City Hall");
    key(input(), "ArrowDown");
    key(input(), "Enter");
    await flush();
    cross(made).mockResolvedValue({ street: "Birchwood Lane", crossings: [] });
    await type("Birchwood Lane and ");
    expect(cross(made)).toHaveBeenCalledWith("Birchwood Lane", { lat: 42.7654, lon: -71.4676 }, expect.anything());
  });

  it("explains an over-long street instead of sending a request the proxy would refuse", async () => {
    const made = await open();
    const long = "A".repeat(MAX_STREET_CHARS + 1);
    await type(`${long} and `);
    expect(cross(made)).not.toHaveBeenCalled();
    expect(text(get("[role=listbox]").parentElement!)).toContain(STREET_TOO_LONG_TEXT);
  });

  it("explains over-long type-ahead text (a paste) and sends nothing", async () => {
    const made = await open();
    setValue(input(), "Main Street ".repeat(12));
    await flush(400);
    expect(made.services.geo.suggest).not.toHaveBeenCalled();
    expect(text(get("[role=listbox]").parentElement!)).toContain(TOO_LONG_TEXT);
  });

  it("sends the pin as the bias of an Enter search", async () => {
    const made = await open();
    (made.services.geo.suggest as ReturnType<typeof vi.fn>).mockResolvedValueOnce([sug("Nashua City Hall", "Nashua, NH", { category: "place", lat: 42.7654, lon: -71.4676 })]);
    await type("City Hall");
    key(input(), "ArrowDown");
    key(input(), "Enter");
    await flush();
    setValue(input(), "Main Street and Park Street");
    key(input(), "Enter");
    await flush();
    expect((made.services.geo.search as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]?.bias).toEqual({ lat: 42.7654, lon: -71.4676 });
  });
});

describe("splitIntersection", () => {
  it.each([
    ["Main St and Park St", { first: "Main St", rest: "Park St" }],
    ["Main St & Park", { first: "Main St", rest: "Park" }],
    ["Main St AT ", { first: "Main St", rest: "" }],
    ["Birchwood Lane and Quarry Hill Road", { first: "Birchwood Lane", rest: "Quarry Hill Road" }],
    ["  Main St and Park St", { first: "Main St", rest: "Park St" }],
    ["Main St", null],
    ["Main St and", null],
    ["and Park St", null],
    ["Sandy Lane", null],
    ["Atlantic Ave", null],
  ])("%j", (typedText, want) => {
    expect(splitIntersection(typedText)).toEqual(want);
  });

  it("takes a pasted run of spaces in linear time", () => {
    const t0 = performance.now();
    for (const t of [" ".repeat(40_000), "a" + " ".repeat(40_000) + "b", "a ".repeat(20_000), "and ".repeat(10_000)]) splitIntersection(t);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
