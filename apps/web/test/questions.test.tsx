// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountItems, type Scene } from "@csd/core";
import { DocProvider, useDoc } from "../src/state/DocProvider";
import { docFromScene } from "../src/state/doc";
import { SceneQuestions } from "../src/components/questions/SceneQuestions";
import { VehicleQuestions } from "../src/components/questions/VehicleQuestions";
import { AccountNotes } from "../src/components/AccountNotes";
import { sampleScene } from "../../../packages/core/test/fixtures";
import { mount } from "./helpers";

let app: ReturnType<typeof mount> | undefined;
let state: ReturnType<typeof useDoc>;
function Questions() {
  state = useDoc();
  return <><SceneQuestions /><VehicleQuestions vehicle={state.doc.scene.vehicles[0]!} /><AccountNotes scene={state.doc.scene} compact /></>;
}
function render(scene: Scene = sampleScene()) { app = mount(<DocProvider initial={docFromScene(scene, "")}><Questions /></DocProvider>); }
function choice(label: string) {
  const el = [...document.querySelectorAll("label")].find((x) => x.textContent?.trim() === label);
  if (!el) throw new Error(`Missing question: ${label}`);
  return document.getElementById(el.htmlFor) as HTMLSelectElement;
}
/** Opens the scene panel: the sun estimate loads the first time it opens. */
async function openScenePanel() {
  const panel = [...document.querySelectorAll<HTMLDetailsElement>("details.optional-questions")].find((d) => d.querySelector("summary")?.textContent?.startsWith("Light, weather"))!;
  act(() => panel.querySelector("summary")!.click());
  await vi.waitFor(() => expect(panel.open).toBe(true));
}
function select(el: HTMLSelectElement, value: string) { act(() => { el.value = value; el.dispatchEvent(new Event("change", { bubbles: true })); }); }
afterEach(() => { app?.unmount(); app = undefined; sessionStorage.clear(); });

describe("standalone optional question components", () => {
  it("offers Not sure everywhere, has no required controls and never confirms an estimate automatically", async () => {
    render();
    expect(accountItems(state.doc.scene)).toEqual([]);
    await openScenePanel();
    await vi.waitFor(() => expect(choice("What was the light like?").value).toBe("auto"));
    expect(accountItems(state.doc.scene)).toEqual([]);
    for (const el of document.querySelectorAll("select")) {
      expect([...el.options].some((x) => x.value === "not-sure")).toBe(true);
      expect(el.required).toBe(false);
      select(el, "not-sure");
    }
    expect(state.doc.scene.conditions).toMatchObject({ lighting: "not-sure", weather: "not-sure" });
    expect(state.doc.scene.vehicles[0]!.account).toMatchObject({ control: "not-sure", lane: "not-sure", signaled: "not-sure", braking: "not-sure", swerving: "not-sure", airbags: "not-sure", towed: "not-sure" });
  });
  it("refreshes the estimate with the time, keeps manual answers and never assumes street lights", async () => {
    const scene = sampleScene(); scene.occurred = { date: "2026-06-21", time: "12:00" }; render(scene);
    const light = choice("What was the light like?");
    // The estimate (and its zone table) loads when the panel first opens.
    await openScenePanel();
    await vi.waitFor(() => expect(light.selectedOptions[0]!.textContent).toContain("Daylight (estimated)"));
    act(() => state.dispatch({ type: "time", time: "00:00" }));
    expect(light.selectedOptions[0]!.textContent).toContain("street lighting unknown");
    expect(accountItems(state.doc.scene)).toEqual([]);
    select(light, "dark-lit");
    act(() => state.dispatch({ type: "time", time: "12:00" }));
    expect(light.value).toBe("dark-lit");
    expect(accountItems(state.doc.scene)[0]!.text).toContain("Claimant said: lighting");
    select(light, "not-sure");
    act(() => state.dispatch({ type: "time", time: "00:00" }));
    expect(light.value).toBe("not-sure");
  });
  it("keeps visibility choices exclusive of None and Not sure and renders every selected glyph", () => {
    render();
    const tick = (label: string) => {
      const row = [...document.querySelectorAll("label")].find((x) => x.textContent?.trim() === label)!;
      act(() => row.querySelector("input")!.click());
    };
    tick("Sun glare"); tick("Parked cars"); tick("Hedges");
    expect(state.doc.scene.conditions?.visibility).toEqual(["sun-glare", "parked-cars", "hedges"]);
    expect(document.querySelectorAll('.account-note svg')).toHaveLength(3);
    tick("None"); expect(state.doc.scene.conditions?.visibility).toEqual(["none"]);
    tick("Not sure"); expect(state.doc.scene.conditions?.visibility).toEqual(["not-sure"]);
  });
  it("shows short answer states and full claimant labels for every vehicle question", () => {
    render();
    for (const [label, answer] of [["What did the traffic control show?", "stop"], ["Was the turn signal on?", "no"], ["Was it braking?", "yes"], ["Was it swerving?", "no"], ["Did the airbags deploy?", "not-sure"], ["Was it towed?", "yes"]]) select(choice(label!), answer!);
    const notes = [...document.querySelectorAll(".account-note")];
    expect(notes).toHaveLength(6);
    expect(notes.every((el) => el.getAttribute("aria-label")?.startsWith("Claimant said, vehicle A:"))).toBe(true);
    expect(notes.map((el) => el.textContent)).toEqual(["A: Stop sign", "A: No", "A: Yes", "A: No", "A: Not sure", "A: Yes"]);
    const disclosure = document.querySelector<HTMLDetailsElement>(".account-icons")!;
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector("summary")?.textContent).toBe("Claimant said · 6 answers");
    act(() => disclosure.querySelector("summary")!.click());
    expect(disclosure.open).toBe(true);
    expect(disclosure.querySelector(".account-chips")?.getAttribute("tabindex")).toBe("0");
  });
});
