// @vitest-environment jsdom
// The claim number and the header (DESIGN.md sections 4 and 5): no made-up claim for a new visitor, an optional
// "Claim number" field and ?claim= for InsurifyAI links (text only; junk is cut or ignored), the header following
// vehicle A, examples marked, and an older scene file with CLM-2419 still opening as saved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { canonicalJson } from "@csd/core";
import { CLAIM_NUMBER_MAX, claimFromSearch, sanitizeClaimNumber } from "../src/lib/claim";
import { docFromScene, reducer } from "../src/state/doc";
import { flush, renderApp, setValue } from "./helpers";
import { makeServices, tbone } from "./fakes";

let app: Awaited<ReturnType<typeof renderApp>> | null = null;
beforeEach(() => {
  Object.defineProperty(navigator, "webdriver", { value: true, configurable: true });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() }));
});
afterEach(() => { app?.unmount(); app = null; vi.unstubAllGlobals(); });

const chip = () => document.querySelector("[data-testid=claim-chip]")?.textContent ?? "";
const SCRIPT = "<script>alert(1)</script>";
const LONG = "A".repeat(500);
const UNICODE = "Ｃｌａｉｍ‐日本語-‮abc​";

describe("the claim number's rules", () => {
  it("the field keeps letters, digits and dashes only, at most 32", () => {
    expect(sanitizeClaimNumber("CLM-2419")).toBe("CLM-2419");
    expect(sanitizeClaimNumber(" clm 77 ")).toBe("clm77");
    expect(sanitizeClaimNumber(SCRIPT)).toBe("scriptalert1script");
    expect(sanitizeClaimNumber(LONG)).toBe("A".repeat(CLAIM_NUMBER_MAX));
    expect(sanitizeClaimNumber(UNICODE)).toBe("-abc");
    expect(sanitizeClaimNumber("")).toBe("");
  });

  it("a link's ?claim= is taken only when it is a plain claim number; anything else is ignored", () => {
    expect(claimFromSearch("?claim=CLM-77")).toBe("CLM-77");
    expect(claimFromSearch("?theme=dark&claim=abc123")).toBe("abc123");
    expect(claimFromSearch(`?claim=${encodeURIComponent("A".repeat(32))}`)).toBe("A".repeat(32));
    for (const junk of [SCRIPT, LONG, UNICODE, "", "CLM 77", "A".repeat(33), "../../etc", "CLM_77"]) {
      expect(claimFromSearch(`?claim=${encodeURIComponent(junk)}`), junk.slice(0, 20)).toBeNull();
    }
    expect(claimFromSearch("")).toBeNull();
  });
});

describe("the header and the claim number in the app", () => {
  it("a new visitor: no 'Claim' part, 'Your car', and an empty optional field on Location", async () => {
    const { services } = makeServices();
    app = await renderApp(services);
    expect(chip()).toBe("Your car");
    expect(chip()).not.toMatch(/Claim|CLM|Accord/);
    const field = document.getElementById("claim-number") as HTMLInputElement;
    expect(field.value).toBe("");
    expect(document.querySelector("label[for=claim-number]")?.textContent).toBe("Claim number (optional)");
    expect(field.maxLength).toBe(CLAIM_NUMBER_MAX);
  });

  it("typing a claim number updates the header live, and junk is cut as it is typed, shown as text only", async () => {
    const { services } = makeServices();
    app = await renderApp(services);
    const field = () => document.getElementById("claim-number") as HTMLInputElement;
    setValue(field(), "CLM-77");
    expect(chip()).toBe("Claim CLM-77 · Your car");
    setValue(field(), SCRIPT);
    expect(field().value).toBe("scriptalert1script");
    expect(chip()).toBe("Claim scriptalert1script · Your car");
    expect(document.querySelector("header script, main script")).toBeNull();
    setValue(field(), LONG);
    expect(field().value).toHaveLength(CLAIM_NUMBER_MAX);
    setValue(field(), UNICODE);
    expect(field().value).toBe("-abc");
    setValue(field(), "");
    expect(chip()).toBe("Your car");
  });

  it("?claim= fills it from an InsurifyAI link; a junk ?claim= is ignored", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?claim=CLM-2026-0042" });
    await flush(10);
    expect(chip()).toBe("Claim CLM-2026-0042 · Your car");
    expect((document.getElementById("claim-number") as HTMLInputElement).value).toBe("CLM-2026-0042");
    app.unmount();
    for (const junk of [SCRIPT, LONG, UNICODE]) {
      app = await renderApp(services, { search: `?claim=${encodeURIComponent(junk)}` });
      await flush(10);
      expect(chip(), junk.slice(0, 20)).toBe("Your car");
      expect(document.querySelector("header script")).toBeNull();
      app.unmount();
    }
    app = null;
  });

  it("an example keeps its own made-up number, marked as example data, whatever ?claim= says", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { search: "?example=t-bone-intersection&claim=CLM-77", hash: "" });
    await flush(50);
    expect(chip()).toBe(`Claim ${tbone.claim.number} · 2021 Honda Accord`);
    expect(document.querySelector(".mode-chip")?.textContent).toBe("Example data");
  });

  it("an older scene file with CLM-2419 and its claim vehicle opens as saved, and the header shows what is in it", async () => {
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#export", storage: docFromScene(tbone, tbone.location.label) });
    await flush(900);
    const old = { ...tbone, claim: { number: "CLM-2419", vehicle: { year: 2021, make: "Honda", model: "Accord" } }, createdAt: "2026-10-05T12:00:00Z", disclaimer: "x" };
    const input = document.getElementById("open-scene") as HTMLInputElement;
    const file = new File([new TextEncoder().encode(canonicalJson(old)) as BlobPart], "crash-scene-CLM-2419.json", { type: "application/json" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    act(() => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush(900);
    expect(window.location.hash).toBe("#review");
    expect(chip()).toBe("Claim CLM-2419 · 2021 Honda Accord");
    // An opened file is not an example.
    expect(document.querySelector(".mode-chip")?.getAttribute("title")).toMatch(/Fixtures mode/);
  });

  it("a stored session's claim vehicle that disagrees with A: the header shows A (the file's own claim value is kept)", async () => {
    const d = docFromScene({ ...tbone, claim: { number: "CLM-1", vehicle: { year: 2000, make: "Old", model: "Value" } } }, "");
    const { services } = makeServices();
    app = await renderApp(services, { hash: "#review", storage: d });
    await flush(50);
    expect(chip()).toBe("Claim CLM-1 · 2021 Honda Accord");
    // Editing A brings the claim's vehicle in line.
    const next = reducer(d, { type: "vehicle", id: "A", patch: { model: "Civic" } });
    expect(next.scene.claim.vehicle).toEqual({ year: 2021, make: "Honda", model: "Civic" });
  });
});

describe("the ZIP's name follows the scene file's", () => {
  it("crash-scene-<date>-<time>.zip with no claim number, crash-scene-<number>.zip with one", async () => {
    const { bundleDownload } = await import("../src/lib/download");
    const { exportBaseName } = await import("@csd/exports/names");
    const createdAt = "2026-10-09T19:42:07Z";
    for (const number of ["", "CLM-77"]) {
      const base = exportBaseName(number, createdAt);
      const files = [
        { name: `${base}.json`, mime: "application/json" as const, bytes: new TextEncoder().encode("{}") },
        { name: `${base}.pdf`, mime: "application/pdf" as const, bytes: new Uint8Array([37, 80, 68, 70]) },
      ];
      const item = bundleDownload({ stamp: { createdAt, fingerprintHex: "0".repeat(64), fingerprintShort: "0000 0000 0000 0000" }, files, skipped: [], notes: [] });
      expect(item?.name).toBe(`${base}.zip`);
      expect(item?.name).toMatch(number ? /^crash-scene-CLM-77\.zip$/ : /^crash-scene-\d{4}-\d{2}-\d{2}-\d{6}\.zip$/);
    }
  });
});
