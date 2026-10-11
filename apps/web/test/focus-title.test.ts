// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusStepTitle } from "../src/lib/focusTitle";

const tick = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

function page(): { header: HTMLButtonElement; main: HTMLElement } {
  const header = document.createElement("button");
  header.textContent = "Learn more";
  const main = document.createElement("main");
  document.body.append(header, main);
  return { header, main };
}
const title = (text: string) => Object.assign(document.createElement("h1"), { textContent: text });

describe("focusing the step's title", () => {
  it("focuses the shown title, not the last step's hidden one", () => {
    const { main } = page();
    const old = title("Does this match what happened?");
    const wrap = document.createElement("div");
    wrap.style.display = "none";
    wrap.append(old);
    const shown = title("What do you want to save?");
    main.append(wrap, shown);
    focusStepTitle(document, 1000);
    expect(document.activeElement).toBe(shown);
  });

  it("waits for a lazy step's title, then focuses it", async () => {
    const { main } = page();
    focusStepTitle(document, 1000);
    const later = title("Where did it happen?");
    main.append(later);
    await tick();
    expect(document.activeElement).toBe(later);
  });

  it("never takes focus from something the person moved to meanwhile (the About dialog, a header control)", async () => {
    const { header, main } = page();
    focusStepTitle(document, 1000);
    header.focus();
    main.append(title("Where did it happen?"));
    await tick();
    expect(document.activeElement).toBe(header);
  });

  it("stops waiting after the time limit", async () => {
    vi.useFakeTimers();
    const { main } = page();
    focusStepTitle(document, 1000);
    vi.advanceTimersByTime(1001);
    vi.useRealTimers();
    const late = title("Where did it happen?");
    main.append(late);
    await tick();
    expect(document.activeElement).not.toBe(late);
  });
});
