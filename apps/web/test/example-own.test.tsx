// @vitest-environment jsdom
// An example becomes the claimant's own at the first edit (DESIGN.md section 19): ?example= leaves the address, the
// made-up number and the example mark go, a reload keeps the work, files are named like any scene. Plus "Start my own",
// ?claim= applied once, the first-visit welcome over a ?claim= link, and a new visitor's date.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { exportBaseName } from "@csd/exports/names";
import { STORAGE_KEY, contentKey, docFromScene, initialDoc, looksLikeExample, reducer, todayLocal, type Doc } from "../src/state/doc";
import { resetWelcomeMemory } from "../src/welcome/storage";
import { click, flush, get, maybe, mount, renderApp, setValue } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: { unmount: () => void } | null = null;
beforeEach(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() }));
  window.localStorage.clear();
  resetWelcomeMemory();
});
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); });

const chip = () => document.querySelector("[data-testid=claim-chip]")?.textContent ?? "";
const stored = (): Doc => JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as Doc;
const params = () => new URLSearchParams(window.location.search);
/** A reload: the same tab's session storage and address, the app mounted again. */
async function reload(services: ReturnType<typeof makeServices>["services"]) {
  app?.unmount();
  app = mount(<App services={services} />);
  await flush(50);
}

describe("an example becomes the claimant's own at the first edit", () => {
  it("Try an example, then a claim number of their own: ?example= leaves the address, and a reload keeps MY-OWN-1", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?welcome=1", hash: "#location" });
    click(get("button", "Try an example"));
    await flush(50);
    expect(params().get("example")).toBe("t-bone-intersection");
    expect(chip()).toBe(`Claim ${tbone.claim.number} · 2021 Honda Accord`);
    expect(stored().example?.name).toBe("t-bone-intersection");
    // Back to step 1 and type their own claim number.
    window.location.hash = "#location";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush(50);
    setValue(document.getElementById("claim-number"), "MY-OWN-1");
    await flush(20);
    expect(params().has("example")).toBe(false);
    expect(stored().example).toBeUndefined();
    expect(stored().fromExample).toBe("t-bone-intersection");
    expect(chip()).toBe("Claim MY-OWN-1 · 2021 Honda Accord");
    // A reload: their work, not the example again.
    await reload(services);
    expect(chip()).toBe("Claim MY-OWN-1 · 2021 Honda Accord");
    // Even when the address still names that example (an older history entry), it is not reloaded over the work.
    window.history.replaceState(null, "", "/?example=t-bone-intersection#review");
    await reload(services);
    expect(chip()).toBe("Claim MY-OWN-1 · 2021 Honda Accord");
    expect(params().has("example")).toBe(false);
  });

  it("any other edit drops the made-up number too, so the files are named like any scene", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "" });
    await flush(50);
    expect(stored().example?.number).toBe(tbone.claim.number);
    window.location.hash = "#vehicles";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await flush(100);
    click(get("button", "Faster, vehicle A"));
    await flush(20);
    const doc = stored();
    expect(doc.example).toBeUndefined();
    expect(doc.scene.claim.number).toBe("");
    expect(chip()).toBe("2021 Honda Accord");
    expect(exportBaseName(doc.scene.claim.number, "2026-10-09T19:42:07Z")).toMatch(/^crash-scene-\d{4}-\d{2}-\d{2}-\d{6}$/);
    expect(params().has("example")).toBe(false);
  });

  it("the reducer: leave-example keeps a number the claimant typed and remembers the example", () => {
    const d0 = docFromScene(tbone, "", { example: "t-bone-intersection" });
    expect(d0.example).toEqual({ name: "t-bone-intersection", key: contentKey(d0), number: tbone.claim.number });
    // A type filled in by vPIC is not an edit.
    const typed = reducer(d0, { type: "vehicle", id: "A", patch: { typeSource: "vpic" } });
    expect(contentKey(typed)).toBe(d0.example!.key);
    const own = reducer(reducer(d0, { type: "claim-number", number: "MY-OWN-1" }), { type: "leave-example" });
    expect(own.scene.claim.number).toBe("MY-OWN-1");
    expect(own.example).toBeUndefined();
    expect(own.fromExample).toBe("t-bone-intersection");
    const edited = reducer(reducer(d0, { type: "speed", id: "A", speed: { kind: "known", mph: 40 } }), { type: "leave-example" });
    expect(edited.scene.claim.number).toBe("");
  });

  it("an untouched example's scene file reopens as an example; an edited one does not", () => {
    expect(looksLikeExample(tbone)).toBe(true);
    expect(docFromScene(tbone, "").example).toEqual(expect.objectContaining({ name: null, number: tbone.claim.number }));
    const mine = { ...tbone, claim: { ...tbone.claim, number: "" } };
    expect(docFromScene(mine, "").example).toBeUndefined();
  });

  it("Start my own: reopened over an example, it gives a new, empty scene on step 1", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection", hash: "" });
    await flush(50);
    click(get("button", "About this tool"));
    const start = get("button", "Start my own");
    // Reopened over an example: Try an example opens in a new tab, so the example here is not replaced either.
    expect(document.querySelector("dialog.welcome-dialog a.btn-primary")).not.toBeNull();
    click(start);
    await flush(50);
    expect(document.querySelector("dialog.welcome-dialog")).toBeNull();
    expect(document.querySelector("#app")?.getAttribute("data-step")).toBe("location");
    expect(chip()).toBe("Your car");
    expect(params().has("example")).toBe(false);
    expect(stored().scene.claim.number).toBe("");
    expect(stored().scene.vehicles[0]).toMatchObject({ make: "", model: "", year: null });
  });

  it("Start my own is not offered over the claimant's own scene", async () => {
    const { services } = makeServices();
    app = await renderApp(services);
    click(get("button", "About this tool"));
    expect(maybe("button", "Start my own")).toBeNull();
  });
});

describe("?claim= is applied once", () => {
  it("fills an empty number, then leaves the address, so a reload keeps the claimant's own edit", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?claim=CLM-LINK-1" });
    await flush(20);
    expect(chip()).toBe("Claim CLM-LINK-1 · Your car");
    expect(params().has("claim")).toBe(false);
    setValue(document.getElementById("claim-number"), "MINE-2");
    // The same link again (a reload of an old entry): the number typed since is kept.
    window.history.replaceState(null, "", "/?claim=CLM-LINK-1#location");
    await reload(services);
    expect(chip()).toBe("Claim MINE-2 · Your car");
    expect(params().has("claim")).toBe(false);
  });

  it("never over an opened file's number", async () => {
    const { services } = makeServices();
    const file = docFromScene({ ...tbone, claim: { ...tbone.claim, number: "FILE-9" } }, "");
    app = await renderApp(services, { search: "?claim=CLM-LINK-1", hash: "#review", storage: file });
    await flush(20);
    expect(chip()).toBe("Claim FILE-9 · 2021 Honda Accord");
  });

  it("a first visit from a ?claim= link gets the first-visit welcome (Try an example is a button, not the new-tab link)", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?claim=CLM-LINK-1&welcome=1" });
    await flush(20);
    expect(document.querySelector("dialog.welcome-dialog")).not.toBeNull();
    expect(get("button", "Try an example").tagName).toBe("BUTTON");
    expect(document.querySelector("dialog.welcome-dialog a")).toBeNull();
  });
});

describe("a new visitor's date", () => {
  it("is today on this device with no time, and there is no 'From your claim' hint", async () => {
    expect(initialDoc().scene.occurred).toEqual({ date: todayLocal(), time: null });
    expect(todayLocal(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    const { services } = makeServices();
    app = await renderApp(services);
    expect((document.getElementById("date") as HTMLInputElement).value).toBe(todayLocal());
    expect((document.getElementById("time") as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain("From your claim");
  });
});
