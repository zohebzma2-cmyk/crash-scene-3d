// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS, parseScene, type Scene } from "@csd/core";
import { SPEED_BELOW_TEXT, SPEED_EMPTY_TEXT, SPEED_NAN_TEXT, SPEED_TENTHS_TEXT, SPEED_TOO_FAST_TEXT, parseSpeedText } from "../src/components/SpeedInput";
import { STORAGE_KEY, initialDoc, reducer, type Doc } from "../src/state/doc";
import { click, flush, get, renderApp, setValue, text } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); });

const located = (): Doc => ({ ...reducer(initialDoc(), { type: "pin", lat: tbone.location.lat, lon: tbone.location.lon, how: "tap" }), directionSet: [true, true] });
const card = (id: string) => document.getElementById(`vehicle-${id}`) as HTMLElement;
const field = () => card("A").querySelector<HTMLInputElement>("input[inputmode=decimal]")!;
const stored = () => (JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Doc).scene.vehicles[0]?.speed;
const hash = () => window.location.hash;

async function open() {
  const { services } = makeServices();
  app = await renderApp(services, { hash: "#vehicles", storage: located() });
  await flush(100);
}

describe("parseSpeedText", () => {
  it.each([
    ["25", 25], ["25.5", 25.5], [" 30 ", 30], ["0", 0], ["150", 150], ["149.9", 149.9], [".5", 0.5], ["25.", 25],
  ])("takes %j", (raw, mph) => {
    expect(parseSpeedText(raw)).toEqual({ ok: true, mph });
  });

  it.each([
    ["", SPEED_EMPTY_TEXT], ["   ", SPEED_EMPTY_TEXT],
    ["fast", SPEED_NAN_TEXT], ["25 mph", SPEED_NAN_TEXT], ["1e3", SPEED_NAN_TEXT], ["2,5", SPEED_NAN_TEXT], ["-", SPEED_NAN_TEXT], [".", SPEED_NAN_TEXT],
    ["-5", SPEED_BELOW_TEXT],
    ["150.1", SPEED_TOO_FAST_TEXT], ["300", SPEED_TOO_FAST_TEXT],
    ["25.55", SPEED_TENTHS_TEXT], ["30.01", SPEED_TENTHS_TEXT],
  ])("refuses %j in plain words", (raw, why) => {
    expect(parseSpeedText(raw)).toEqual({ ok: false, text: why });
  });

  it("uses the scene file's own words, so the two can't drift apart", () => {
    const scene = (mph: number): Scene => ({ ...tbone, vehicles: [{ ...tbone.vehicles[0]!, speed: { kind: "known", mph } }, tbone.vehicles[1]!] });
    const msg = (mph: number) => {
      const r = parseScene(scene(mph));
      return r.ok ? null : r.errors.map((e) => e.replace(/^Vehicle A: /, ""));
    };
    expect(msg(300)).toContain(SPEED_TOO_FAST_TEXT);
    expect(msg(25.55)).toContain(SPEED_TENTHS_TEXT);
    expect(msg(-5)).toContain(SPEED_BELOW_TEXT);
    expect(SPEED_TOO_FAST_TEXT).toContain(`${LIMITS.maxSpeedMph} mph or less`);
  });
});

describe("the speed field", () => {
  it("is a typed input with the decimal keypad, named for the speed, and keeps the plus and minus buttons", async () => {
    await open();
    expect(field().inputMode).toBe("decimal");
    // the one box the end-to-end test looks for: a text box named for the speed, and only one
    const named = [...card("A").querySelectorAll<HTMLInputElement>("input[type=text]")].filter((i) => /speed|how fast|mph/i.test(i.getAttribute("aria-label") ?? ""));
    expect(named).toHaveLength(1);
    expect(field().getAttribute("aria-label")).toBe("Speed at impact in mph, vehicle A");
    expect(field().value).toBe("25");
    click(get("button", "Faster, vehicle A", card("A")));
    expect(field().value).toBe("30");
    click(get("button", "Slower, vehicle A", card("A")));
    click(get("button", "Slower, vehicle A", card("A")));
    expect(field().value).toBe("20");
  });

  it("takes whole numbers and tenths into the scene as you type", async () => {
    await open();
    setValue(field(), "42");
    expect(stored()).toEqual({ kind: "known", mph: 42 });
    setValue(field(), "42.5");
    expect(stored()).toEqual({ kind: "known", mph: 42.5 });
    expect(card("A").querySelector(".field-error")).toBeNull();
    expect(field().getAttribute("aria-invalid")).toBe("false");
  });

  it("above 150 it says so, keeps what was typed, and does not clamp or save it", async () => {
    await open();
    setValue(field(), "300");
    expect(field().value).toBe("300");
    expect(text(card("A").querySelector(".field-error")!)).toBe("That's faster than we can illustrate. Enter 150 mph or less.");
    expect(card("A").querySelector("[data-speed-group]")?.textContent).toMatch(/150 mph/);
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toBe(card("A").querySelector(".field-error")!.id);
    expect(stored()).toEqual({ kind: "known", mph: 25 });
    field().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await flush(50);
    expect(field().value).toBe("300");
  });

  it("explains finer than tenths, empty, and not-a-number, each in plain words", async () => {
    await open();
    const msg = () => text(card("A").querySelector(".field-error")!);
    setValue(field(), "25.55");
    expect(msg()).toBe("Use whole or tenths of a mile per hour, like 25 or 25.5.");
    setValue(field(), "");
    expect(msg()).toBe(SPEED_EMPTY_TEXT);
    setValue(field(), "fast");
    expect(msg()).toBe(SPEED_NAN_TEXT);
    setValue(field(), "-3");
    expect(msg()).toBe(SPEED_BELOW_TEXT);
    expect(stored()).toEqual({ kind: "known", mph: 25 });
  });

  it("fixing the value clears the message and saves the speed; a plus or minus press drops a bad entry", async () => {
    await open();
    setValue(field(), "300");
    setValue(field(), "80");
    expect(card("A").querySelector(".field-error")).toBeNull();
    expect(stored()).toEqual({ kind: "known", mph: 80 });
    setValue(field(), "");
    click(get("button", "Faster, vehicle A", card("A")));
    expect(card("A").querySelector(".field-error")).toBeNull();
    expect(field().value).toBe("85");
  });

  it("a speed that can't be used blocks Review, names the vehicle, and lets go once fixed", async () => {
    await open();
    setValue(field(), "300");
    click(get("button", /See the recreation/));
    await flush(50);
    expect(hash()).toBe("#vehicles");
    expect(text(document.body)).toContain("Vehicle A: That's faster than we can illustrate. Enter 150 mph or less.");
    setValue(field(), "60");
    await flush(50);
    click(get("button", /See the recreation/));
    await flush(50);
    expect(hash()).toBe("#review");
  });

  it("an empty field blocks too, and 'Not sure' takes the field away without leaving a block behind", async () => {
    await open();
    setValue(field(), "");
    click(get("button", "Not sure", card("A")));
    await flush(50);
    expect(card("A").querySelector("input[inputmode=decimal]")).toBeNull();
    expect(card("A").querySelector(".field-error")).toBeNull();
    click(get("button", /See the recreation/));
    await flush(50);
    expect(hash()).toBe("#review");
  });
});
