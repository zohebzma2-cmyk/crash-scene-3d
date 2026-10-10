// @vitest-environment jsdom
import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Compass, COMPASS_LABEL } from "../src/viewer/Compass";
import { NorthArrow } from "../src/components/NorthArrow";
import { ICON_NAMES } from "../src/icons/Icon";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null; });
function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe("3D compass button", () => {
  it("is a button named “Compass: reset to north up” with the north icon", () => {
    const el = mount(<Compass driver={false} onReset={() => undefined} />);
    const b = el.querySelector("button")!;
    expect(b.getAttribute("aria-label")).toBe("Compass: reset to north up");
    expect(COMPASS_LABEL).toBe("Compass: reset to north up");
    expect(b.type).toBe("button");
    expect(b.querySelector("svg.icon")).toBeTruthy();
    expect(b.textContent).toBe("N");
    expect(b.getAttribute("aria-disabled")).toBeNull();
    expect(ICON_NAMES).toContain("north");
  });
  it("resets on a click (a keyboard Enter or Space press on a button is a click)", () => {
    const onReset = vi.fn();
    const el = mount(<Compass driver={false} onReset={onReset} />);
    act(() => el.querySelector("button")!.click());
    expect(onReset).toHaveBeenCalledTimes(1);
  });
  it("hands its element to the viewer through a ref, and does nothing in the driver views (aria-disabled)", () => {
    const ref = createRef<HTMLButtonElement>();
    const onReset = vi.fn();
    const el = mount(<Compass ref={ref} driver onReset={onReset} />);
    expect(ref.current).toBe(el.querySelector("button"));
    expect(ref.current!.getAttribute("aria-disabled")).toBe("true");
    act(() => ref.current!.click());
    expect(onReset).not.toHaveBeenCalled();
  });
});

describe("map north arrow", () => {
  it("is a labelled picture with the north icon and an N, not a control", () => {
    const el = mount(<NorthArrow />);
    const n = el.querySelector(".map-north")!;
    expect(n.getAttribute("role")).toBe("img");
    expect(n.getAttribute("aria-label")).toBe("North is up");
    expect(n.querySelector("svg.icon")).toBeTruthy();
    expect(n.querySelector("button, a, [tabindex]")).toBeNull();
  });
});
