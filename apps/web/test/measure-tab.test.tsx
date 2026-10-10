// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { all, click, flush, get, maybe, mockMatchMedia, renderApp, text } from "./helpers";
import { makeServices } from "./fakes";

let app: { unmount: () => void } | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const example = { search: "?example=t-bone-intersection", hash: "#review" };
const switchOf = (name: string) => get("label", name) .querySelector("input") as HTMLInputElement;

async function open() {
  const { services } = makeServices();
  app = await renderApp(services, example);
  await flush(900);
  click(get("tab", "Measure"));
}

describe("Measure tab (DESIGN.md section 7)", () => {
  it("has Distances at impact, Travel paths and Measure two points, all off by default", async () => {
    await open();
    const names = all("label", undefined, document.querySelector(".panel")!).map((l) => l.textContent?.trim());
    expect(names).toEqual(expect.arrayContaining(["Distances at impact", "Travel paths", "Measure two points"]));
    for (const n of ["Distances at impact", "Travel paths", "Measure two points"]) expect(switchOf(n).checked).toBe(false);
    expect(all(".mpill")).toHaveLength(0);
    expect(all(".d-ghost")).toHaveLength(0);
    expect(all(".d-travel-line")).toHaveLength(0);
  });

  it("Distances at impact draws the rest outlines and the numbers for moved and gap", async () => {
    await open();
    click(switchOf("Distances at impact"));
    expect(all(".d-ghost").length).toBeGreaterThan(0);
    expect(all(".d-travel-line")).toHaveLength(0);
    const pills = all(".mpill .num").map((p) => p.textContent);
    expect(pills.length).toBeGreaterThan(0);
    for (const p of pills) expect(p).toMatch(/^about /);
    // the list numbers exactly the rows drawn
    const numbered = all(".measure-list .mnum").length;
    expect(numbered).toBe(all(".mpill:not(.mpill-two)").length);
  });

  it("Travel paths draws a line along each approach and the distance travelled, without the rest outlines", async () => {
    await open();
    click(switchOf("Travel paths"));
    expect(all(".d-travel-line").length).toBe(2);
    expect(all(".d-ghost")).toHaveLength(0);
    const pills = all(".mpill:not(.mpill-two) .num");
    expect(pills).toHaveLength(2);
    for (const p of pills) expect(p.textContent).toMatch(/^about /);
    const rowText = text(get(".measure-list"));
    expect(rowText).toContain("A, last");
    click(switchOf("Travel paths"));
    expect(all(".d-travel-line")).toHaveLength(0);
  });

  it("with both on the numbers run 1, 2, 3 … in order", async () => {
    await open();
    click(switchOf("Distances at impact"));
    click(switchOf("Travel paths"));
    const nums = all(".mpill:not(.mpill-two) .mnum").map((n) => n.textContent);
    expect(nums).toEqual(nums.map((_, i) => String(i + 1)));
    expect(nums.length).toBeGreaterThan(2);
  });

  it("on a phone, turning any overlay on opens the Measure tab by itself", async () => {
    mockMatchMedia((q) => q.includes("max-width: 767px"));
    const { services } = makeServices();
    app = await renderApp(services, example);
    await flush(900);
    for (const name of ["Travel paths", "Measure two points", "Distances at impact"]) {
      click(get("tab", "Vehicles"));
      click(get("tab", "Measure"));
      click(get("tab", "View"));
      click(get("tab", "Measure"));
      click(switchOf(name));
      expect(get("tab", "Measure").getAttribute("aria-selected")).toBe("true");
      click(switchOf(name));
    }
    expect(all(".mpill")).toHaveLength(0);    // phones: values live in the tab, not pills
  });
});

describe("Measure two points", () => {
  const slotBox = { x: 0, y: 0, left: 0, top: 0, width: 800, height: 560, right: 800, bottom: 560, toJSON: () => ({}) } as DOMRect;
  const real = Element.prototype.getBoundingClientRect;

  async function measuring() {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("viewer-slot") ? slotBox : real.call(this);
    });
    await open();
    click(switchOf("Measure two points"));
  }
  const tap = (x: number, y: number) => {
    const slot = get(".viewer-slot");
    slot.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
  };
  const value = () => maybe("[data-testid=two-point-value]")?.textContent ?? null;

  it("guides the claimant, and shows the distance between two taps in the tab and on the picture", async () => {
    await measuring();
    expect(text(get(".two-point"))).toContain("Tap the first spot on the picture");
    expect(get(".viewer-slot").classList.contains("is-measuring")).toBe(true);
    const { act } = await import("react");
    act(() => tap(100, 300));
    expect(text(get(".two-point"))).toContain("Now tap the second spot.");
    expect(value()).toBeNull();
    act(() => tap(500, 300));
    expect(value()).toMatch(/^about \d+ ft$/);
    expect(get("[data-testid=two-point-pill]").textContent).toBe(value());
    expect(all(".measure-two-dot")).toHaveLength(2);
    expect(all(".measure-two-line")).toHaveLength(1);
  });

  it("measures farther for points farther apart, in the units on screen", async () => {
    await measuring();
    const { act } = await import("react");
    act(() => { tap(100, 300); tap(300, 300); });
    const near = Number(/\d+/.exec(value() ?? "")?.[0]);
    act(() => { tap(100, 300); });                        // a new measurement starts with the next tap
    expect(value()).toBeNull();
    act(() => { tap(700, 300); });
    const far = Number(/\d+/.exec(value() ?? "")?.[0]);
    expect(far).toBeGreaterThan(near);
    click(get("tab", "View"));
    click(get("radio", "m · km/h"));
    click(get("tab", "Measure"));
    expect(value()).toMatch(/^about [\d.]+ m$/);
  });

  it("a vehicle's label is a point too (keyboard friendly), and Clear starts over", async () => {
    await measuring();
    const labelA = get(".vlabel[data-id=A]");
    click(labelA);
    click(get(".vlabel[data-id=B]"));
    expect(value()).toMatch(/^about \d+ ft$/);
    // tapping a label while measuring does not select the vehicle in the panel
    expect(document.querySelector(".summary-item[data-selected]")).toBeNull();
    click(get("button", "Clear"));
    expect(value()).toBeNull();
    expect(all(".measure-two-dot")).toHaveLength(0);
  });

  it("turning it off removes the points and the crosshair", async () => {
    await measuring();
    const { act } = await import("react");
    act(() => { tap(100, 300); tap(500, 300); });
    click(switchOf("Measure two points"));
    expect(all(".measure-two-dot")).toHaveLength(0);
    expect(get(".viewer-slot").classList.contains("is-measuring")).toBe(false);
  });
});
