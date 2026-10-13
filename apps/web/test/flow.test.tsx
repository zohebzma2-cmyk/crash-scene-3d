// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlainMessage } from "@csd/core";
import { initialDoc, reducer, type Doc } from "../src/state/doc";
import { all, click, flush, get, key, maybe, renderApp, text } from "./helpers";
import { makeServices, tbone, withAnswers } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); });

const placed = (): Doc => withAnswers(reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }));
/** A located scene whose directions have been picked. */
const located = (mutate: (d: Doc) => Doc = (d) => d): Doc => mutate({ ...placed(), directionSet: [true, true] });
const hash = () => window.location.hash;
const MISMATCH: PlainMessage = { code: "zone-mismatch", vehicleIds: ["A", "B"], text: "Vehicle B would have come at your car (A) head-on, from the front, but your car (A) is marked as hit on the rear." };

describe("the stepper can't skip validation", () => {
  it("won't go to Review without a place; the warning has Fix the details and no 'See it anyway'", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles" });          // not located
    click(get("button", /See the recreation/));
    await flush();
    expect(hash()).toBe("#vehicles");
    expect(get("alert").textContent).toContain("Tell us where it happened first");
    expect(maybe("button", "Fix the details")).not.toBeNull();
    expect(maybe("button", "See it anyway")).toBeNull();
    // Fix the details goes to the step that can fix it
    click(get("button", "Fix the details"));
    await flush(10);
    expect(hash()).toBe("#location");
  });

  it("runs parseScene: a scene that can't be drawn is a plain warning, not a silent skip", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("radio", "Parked", document.getElementById("vehicle-A")!));
    click(get("radio", "Parked", document.getElementById("vehicle-B")!));
    click(get("button", /See the recreation/));
    await flush();
    expect(hash()).toBe("#vehicles");
    expect(text(get("alert"))).toContain("At least one vehicle has to be moving.");
    expect(maybe("button", "See it anyway")).toBeNull();
  });

  it("runs checkScene: mismatches show with both buttons, 'See it anyway' continues, and Review lists them", async () => {
    const { services, checkScene } = makeServices();
    checkScene.mockReturnValue([MISMATCH]);
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush();
    expect(hash()).toBe("#vehicles");
    expect(text(get("alert"))).toContain(MISMATCH.text);
    expect(get("button", "Fix the details")).toBeTruthy();
    click(get("button", "See it anyway"));
    await flush(50);
    expect(hash()).toBe("#review");
    expect(get("heading", /Does this match/)).toBeTruthy();
    expect(document.querySelector("[data-testid=review-warnings]")?.textContent).toContain(MISMATCH.text);
  });

  it("keeps the warnings live: they disappear once the details fit", async () => {
    const { services, checkScene } = makeServices();
    checkScene.mockReturnValue([MISMATCH]);
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush();
    expect(document.querySelector("[data-testid=gate-panel]")).not.toBeNull();
    checkScene.mockReturnValue([]);
    click(get("radio", "Hit on the front left", document.getElementById("vehicle-B")!));   // any change re-runs the checks
    await flush();
    expect(document.querySelector("[data-testid=gate-panel]")).toBeNull();
  });

  it("guards Review and Save when the address bar asks for them directly", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#export" });             // nothing set up
    await flush(20);
    expect(hash()).toBe("#location");
    expect(document.querySelector("[data-testid=gate-panel]")).not.toBeNull();
    expect(maybe("heading", "What do you want to save?")).toBeNull();
  });

  it("goes straight through when everything fits (and Back never needs a check)", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush(20);
    expect(hash()).toBe("#review");
    click(get("button", "Edit details"));
    await flush(10);
    expect(hash()).toBe("#vehicles");
  });
});

describe("directions are the claimant's to pick", () => {
  it("asks which way a parked or backing vehicle was facing, not going", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: placed() });
    await flush(900);
    click(get("radio", "Parked", document.getElementById("vehicle-B")!));
    click(get("radio", "Backing up", document.getElementById("vehicle-A")!));
    click(get("button", /See the recreation/));
    await flush();
    expect(text(get("alert"))).toContain("Pick which way your car was facing.");
    expect(text(get("alert"))).toContain("Pick which way vehicle B was facing.");
  });

  it("pre-fills no direction, and blocks Review (no 'See it anyway') until each vehicle has one", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#vehicles", storage: placed() });
    await flush(900);
    for (const id of ["A", "B"]) {
      const card = document.getElementById(`vehicle-${id}`)!;
      expect(all("radiogroup", undefined, card).some((g) => all("radio", undefined, g).some((r) => /bound|^North$|^East$|^South$|^West$/.test(r.getAttribute("aria-label") ?? r.textContent ?? "") && r.getAttribute("aria-checked") === "true"))).toBe(false);
      expect(card.querySelector(".dir-caption")?.textContent).toBe("Not picked yet");
    }
    click(get("button", /See the recreation/));
    await flush();
    expect(hash()).toBe("#vehicles");
    // An unpicked direction is a missing detail, never "don't fit together" (owner's polish list 5b).
    expect(text(get("alert"))).toContain("Some details are missing");
    expect(text(get("alert"))).not.toContain("don't fit together");
    expect(text(get("alert"))).toContain("Pick which way your car was going.");
    expect(text(get("alert"))).toContain("Pick which way vehicle B was going.");
    expect(maybe("button", "See it anyway")).toBeNull();
    expect(document.querySelector("[data-testid=gate-fixes]")).toBeNull();
    // picking one each clears it
    click(get("radio", "Northbound on Main Street", document.getElementById("vehicle-A")!));
    click(get("radio", "Westbound on Park Street", document.getElementById("vehicle-B")!));
    await flush();
    expect(document.querySelector("[data-testid=gate-panel]")?.textContent ?? "").not.toContain("Pick which way");
    click(get("button", /See the recreation/));
    await flush(20);
    if (hash() !== "#review") click(get("button", "See it anyway"));   // the plain checks may still have something to say
    await flush(20);
    expect(hash()).toBe("#review");
  });

  it("stays on Review when the roads finish loading after the claimant accepted the warnings", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const net = (await import("./fakes")).tboneNet();
    const { services, checkScene } = makeServices({ roads: { load: async () => { await gate; return net; } } });
    checkScene.mockReturnValue([MISMATCH]);
    // directions named but without a road id, as they would be picked before the roads arrive
    const doc = located((d) => ({ ...d, scene: { ...d.scene, vehicles: d.scene.vehicles.map((v, i) => ({ ...v, travel: { ...v.travel, roadName: i === 0 ? "Main Street" : "Park Street", bearingDeg: i === 0 ? 342 : 252 } })) } }));
    app = await renderApp(services, { hash: "#vehicles", storage: doc });
    await flush(900);                       // the debounce has passed; roads are still loading
    click(get("button", /See the recreation/));
    await flush();
    click(get("button", "See it anyway"));
    await flush(20);
    expect(hash()).toBe("#review");
    release();
    await flush(100);
    await flush(100);
    expect(hash()).toBe("#review");
    expect(get("heading", /Does this match/)).toBeTruthy();
  });
});

describe("review warnings are compact", () => {
  const many: PlainMessage[] = [MISMATCH, { ...MISMATCH, code: "b", text: "Second thing that does not fit." }, { ...MISMATCH, code: "c", text: "Third thing that does not fit." }];

  it("shows the first warning on one line, with Show all (N) that opens the rest in place", async () => {
    const { services, checkScene } = makeServices();
    checkScene.mockReturnValue(many);
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush();
    click(get("button", "See it anyway"));
    await flush(50);
    const card = document.querySelector("[data-testid=review-warnings]") as HTMLElement;
    expect(card.querySelector(".warnings-first")?.textContent).toBe(MISMATCH.text);
    expect(card.querySelector(".warnings-first")?.classList.contains("is-clamped")).toBe(true);
    expect(card.querySelectorAll("li")).toHaveLength(0);
    const toggle = get("button", "Show all (3)", card);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    click(toggle);
    expect(card.querySelectorAll("li")).toHaveLength(3);
    expect(get("button", "Show fewer", card).getAttribute("aria-expanded")).toBe("true");
    click(get("button", "Show fewer", card));
    expect(card.querySelectorAll("li")).toHaveLength(0);
    expect(maybe("button", "Edit the details", card)).not.toBeNull();
  });

  it("has no toggle for a single warning", async () => {
    const { services, checkScene } = makeServices();
    checkScene.mockReturnValue([MISMATCH]);
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    click(get("button", /See the recreation/));
    await flush();
    click(get("button", "See it anyway"));
    await flush(50);
    const card = document.querySelector("[data-testid=review-warnings]") as HTMLElement;
    expect(maybe("button", /Show all/, card)).toBeNull();
    expect(card.querySelector(".warnings-first")?.classList.contains("is-clamped")).toBe(false);
  });
});

describe("a review that passed stays put", () => {
  it("stays on Review, and shows the warning, when roads arrive late and add one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const net = (await import("./fakes")).tboneNet();
    const { services, checkScene } = makeServices({ roads: { load: async () => { await gate; return net; } } });
    checkScene.mockReturnValue([]);
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);                      // roads are still loading
    click(get("button", /See the recreation/));
    await flush(20);
    expect(hash()).toBe("#review");        // passed with no problems
    checkScene.mockReturnValue([MISMATCH]);
    release();
    await flush(100);
    await flush(100);
    expect(hash()).toBe("#review");
    expect(document.querySelector("[data-testid=review-warnings]")?.textContent).toContain(MISMATCH.text);
  });

  it("also holds when the address bar went straight to Review", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const net = (await import("./fakes")).tboneNet();
    const { services, checkScene } = makeServices({ roads: { load: async () => { await gate; return net; } } });
    checkScene.mockReturnValue([]);
    app = await renderApp(services, { hash: "#review", storage: located() });
    await flush(900);
    checkScene.mockReturnValue([MISMATCH]);
    release();
    await flush(100);
    await flush(100);
    expect(hash()).toBe("#review");
  });
});

describe("focus and keyboard", () => {
  it("moves focus to the step's h1 on navigation", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#location" });
    click(get("button", /Next: vehicles/));
    await flush(20);
    expect(document.activeElement?.tagName).toBe("H1");
    expect(document.activeElement?.textContent).toBe("Which vehicles were involved?");
    click(get("button", "Back"));
    await flush(20);
    expect(document.activeElement?.textContent).toBe("Where did it happen?");
  });

  it("every radio group has one tab stop and answers arrow keys", async () => {
    const { services } = makeServices({ roads: "none" });
    app = await renderApp(services, { hash: "#vehicles", storage: located() });
    await flush(900);
    for (const group of all("radiogroup")) {
      const radios = all("radio", undefined, group);
      expect(radios.filter((r) => r.tabIndex === 0), group.className).toHaveLength(1);
      const stop = radios.find((r) => r.tabIndex === 0)!;
      stop.focus();
      const ev = key(stop, "ArrowRight");
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(radios[(radios.indexOf(stop) + 1) % radios.length]);
      expect(document.activeElement?.getAttribute("aria-checked")).toBe("true");   // selection follows focus
      expect(all("radio", undefined, group).filter((r) => r.tabIndex === 0)).toHaveLength(1);
    }
  });

  it("arrows wrap in both directions, and Home/End jump", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#location" });
    const group = get("radiogroup", undefined, document.querySelector(".tiles-4")!.parentElement!);
    const radios = all("radio", undefined, group);
    radios[0]!.focus();
    key(radios[0]!, "ArrowLeft");
    expect(document.activeElement).toBe(radios[3]);
    key(radios[3]!, "ArrowDown");
    expect(document.activeElement).toBe(radios[0]);
    key(radios[0]!, "End");
    expect(document.activeElement).toBe(radios[3]);
    key(radios[3]!, "Home");
    expect(document.activeElement).toBe(radios[0]);
  });

  it("tabs on the review step are one tab stop and answer arrow keys", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "#review" });
    await flush(900);
    const tabs = all("tab", undefined, document.querySelector(".tabs")!);
    expect(tabs.map((t) => t.textContent)).toEqual(["Vehicles", "Measure", "View"]);
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    tabs[0]!.focus();
    key(tabs[0]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs.filter((t) => t.tabIndex === 0)).toHaveLength(1);
    key(tabs[1]!, "ArrowRight");
    key(tabs[2]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
  });
});

describe("shell", () => {
  it("shows the claim chip, the disclaimer on every step, and opens About this illustration", async () => {
    const { services } = makeServices();
    app = await renderApp(services);
    // A new visitor: no claim number (no "Claim" part at all) and no vehicle yet.
    expect(document.querySelector("[data-testid=claim-chip]")?.textContent).toBe("Your car");
    expect(text(document.querySelector(".disclaimer-bar")!)).toContain("Illustration only.");
    click(get("button", "Learn more"));
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
    expect(text(document.querySelector("dialog")!)).toContain("It is not an expert accident reconstruction");
  });

  it("toggles light and dark on the root element", async () => {
    const { services } = makeServices();
    document.documentElement.classList.remove("dark", "light");
    app = await renderApp(services);
    click(get("button", /Switch to the dark theme/));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    click(get("button", /Switch to the light theme/));
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("opens an example straight on the review step", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "" });
    await flush(900);
    expect(hash()).toBe("#review");
    expect(get("heading", /Does this match/)).toBeTruthy();
    expect(document.querySelector("[data-testid=claim-chip]")?.textContent).toContain("CLM-EX-1001");
  });
});
