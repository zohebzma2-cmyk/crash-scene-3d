import { describe, expect, it } from "vitest";
import { isStateText, stateAbbreviation, stateOfText } from "../src";

describe("US states in typed place text", () => {
  it.each([
    ["Nashua, NH", "NH"], ["Manchester NH", "NH"], ["Nashua, NH 03060", "NH"], ["Concord, New Hampshire", "NH"],
    ["Lyons, CO", "CO"], ["manchester nh", "NH"], ["Nashua", null], ["Atlantis, ZZ", null], ["Main Street", null],
  ])("stateOfText(%j) = %j", (text, want) => {
    expect(stateOfText(text)).toBe(want);
  });

  it("isStateText is exact; stateAbbreviation keeps unknown names", () => {
    expect(isStateText("NH")).toBe(true);
    expect(isStateText("new hampshire")).toBe(true);
    expect(isStateText("Hampshire")).toBe(false);
    expect(isStateText("ZZ")).toBe(false);
    expect(stateAbbreviation("Colorado")).toBe("CO");
    expect(stateAbbreviation("Ontario")).toBe("Ontario");
  });
});
