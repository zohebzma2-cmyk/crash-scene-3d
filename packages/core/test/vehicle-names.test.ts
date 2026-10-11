import { describe, expect, it } from "vitest";
import {
  MAKE_ALIASES, MODEL_ALIASES, POPULAR_MAKES, editDistance, maxTypos, modelYears, normName, rankNames, rankYears, resolveName, typeFromVpic,
} from "../src";

// Makes as the proxy serves them (vPIC names, title-cased), with some of the obscure ones that share prefixes.
const MAKES = [
  "Acura", "Audi", "BMW", "Buick", "Cadillac", "Champion Bus", "Chang Jiang", "Chevrolet", "Chrysler", "Dodge", "Ford", "GMC",
  "Harley-Davidson", "Honda", "Hyundai", "Jeep", "Kia", "Land Rover", "Land Rover Santana", "Landscape", "Mercedes-Benz",
  "Merch Motorcycle Co.", "Mercury", "Mini", "Mini Big Trucks", "Nissan", "Ram", "Ram Transcorp", "Subaru", "Tesla",
  "Toyo Motors", "Toyota", "Volkswagen", "Volvo", "Vw Kustoms",
];
const make = (q: string) => rankNames(q, MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES }).map((r) => r.name);
const CHEVY_2019 = ["Blazer", "Bolt EV", "Camaro", "Colorado", "Corvette", "Equinox", "Express", "Silverado", "Silverado HD", "Silverado LD", "Suburban", "Tahoe"];
const FORD = ["Escape", "Explorer", "F-150", "F-250", "Mustang", "Ranger"];
const HONDA = ["Accord", "Civic", "CR-V", "HR-V", "Odyssey", "Pilot"];
const model = (q: string, names: readonly string[], mk?: string) => rankNames(q, names, { aliases: MODEL_ALIASES, ...(mk ? { stripPrefix: mk } : {}) }).map((r) => r.name);

describe("normName", () => {
  it("keeps only letters and digits, lower case, without accents", () => {
    expect(normName("F-150")).toBe("f150");
    expect(normName(" cr v ")).toBe("crv");
    expect(normName("Citroën")).toBe("citroen");
    expect(normName("Mercedes-Benz")).toBe("mercedesbenz");
  });
});

describe("editDistance (optimal string alignment)", () => {
  it("counts swaps, inserts, deletes and changes as one edit each", () => {
    expect(editDistance("toyta", "toyota")).toBe(1);
    expect(editDistance("silverdo", "silverado")).toBe(1);
    expect(editDistance("hnoda", "honda")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
  });
  it("stops early past the limit", () => {
    expect(editDistance("chevrolet", "volkswagen", 2)).toBe(3);
    expect(editDistance("a", "abcdef", 2)).toBe(3);
  });
  it("allows more typos for longer text", () => {
    expect([3, 4, 5, 6, 9].map(maxTypos)).toEqual([0, 1, 1, 2, 2]);
  });
});

describe("makes: aliases and typos", () => {
  it("chevy, vw, merc, benz, beemer and harley are their makes, first", () => {
    expect(make("chevy")[0]).toBe("Chevrolet");
    expect(make("Chevy")[0]).toBe("Chevrolet");
    expect(make("vw")[0]).toBe("Volkswagen");
    expect(make("merc")[0]).toBe("Mercedes-Benz");
    expect(make("benz")[0]).toBe("Mercedes-Benz");
    expect(make("beemer")[0]).toBe("BMW");
    expect(make("bimmer")[0]).toBe("BMW");
    expect(make("harley")[0]).toBe("Harley-Davidson");
    expect(make("range rover")[0]).toBe("Land Rover");
  });
  it("toyta finds Toyota through a typo, and popular makes go before obscure ones", () => {
    expect(make("toyta")[0]).toBe("Toyota");
    expect(make("chevrolte")[0]).toBe("Chevrolet");
    expect(make("volkswagon")[0]).toBe("Volkswagen");
  });
  it("orders exact, prefix, later word, alias, then typos", () => {
    const r = rankNames("land", MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES });
    expect(r.map((x) => x.name)).toEqual(["Land Rover", "Landscape", "Land Rover Santana"]);
    expect(r.every((x) => x.kind === "prefix")).toBe(true);
    expect(rankNames("rover", MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES })[0]).toEqual({ name: "Land Rover", kind: "exact" });
    expect(rankNames("ch", MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES }).slice(0, 2).map((x) => x.name)).toEqual(["Chevrolet", "Chrysler"]);
    const ram = rankNames("ram", MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES });
    expect(ram[0]).toEqual({ name: "Ram", kind: "exact" });
    expect(ram[1]).toEqual({ name: "Ram Transcorp", kind: "prefix" });
    expect(rankNames("toyta", MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES })[0]?.kind).toBe("fuzzy");
    expect(rankNames("chevr", MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES })[0]).toEqual({ name: "Chevrolet", kind: "prefix" });
    expect(rankNames("bimm", MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES })[0]).toEqual({ name: "BMW", kind: "alias" });
  });
  it("lists every make for empty text, popular first", () => {
    const all = make("");
    expect(all).toHaveLength(MAKES.length);
    expect(all.slice(0, 3)).toEqual(["Toyota", "Ford", "Chevrolet"]);
  });
  it("finds nothing for text that is nothing like a make, and short text never matches by typo", () => {
    expect(make("zephyr")).toEqual([]);
    expect(make("xq")).toEqual([]);
  });
  it("resolves only exact names and full aliases", () => {
    expect(resolveName("chevy", MAKES, { aliases: MAKE_ALIASES })).toBe("Chevrolet");
    expect(resolveName("CHEVROLET", MAKES, { aliases: MAKE_ALIASES })).toBe("Chevrolet");
    expect(resolveName("vw", MAKES, { aliases: MAKE_ALIASES })).toBe("Volkswagen");
    expect(resolveName("chev", MAKES, { aliases: MAKE_ALIASES })).toBeNull();   // half a make
    expect(rankNames("chev", MAKES, { aliases: MAKE_ALIASES, popular: POPULAR_MAKES })[0]).toEqual({ name: "Chevrolet", kind: "prefix" });
    expect(resolveName("chevro", MAKES, { aliases: MAKE_ALIASES })).toBeNull();
    expect(resolveName("toyta", MAKES, { aliases: MAKE_ALIASES })).toBeNull();
    expect(resolveName("", MAKES, { aliases: MAKE_ALIASES })).toBeNull();
  });
});

describe("models: spelling variants, nicknames and typos", () => {
  it("f150 is F-150, crv is CR-V, hrv is HR-V", () => {
    expect(model("f150", FORD)[0]).toBe("F-150");
    expect(model("F 150", FORD)[0]).toBe("F-150");
    expect(model("crv", HONDA)[0]).toBe("CR-V");
    expect(model("hrv", HONDA)[0]).toBe("HR-V");
    expect(resolveName("f150", FORD, { aliases: MODEL_ALIASES })).toBe("F-150");
    expect(resolveName("crv", HONDA, { aliases: MODEL_ALIASES })).toBe("CR-V");
  });
  it("silverado is Silverado, then its HD and LD; silverdo still finds it", () => {
    expect(model("silverado", CHEVY_2019).slice(0, 3)).toEqual(["Silverado", "Silverado HD", "Silverado LD"]);
    expect(model("silverdo", CHEVY_2019)[0]).toBe("Silverado");
    expect(model("silv", CHEVY_2019)[0]).toBe("Silverado");
  });
  it("text that starts with the model (civic si, silverado 1500, mustang gt) finds it", () => {
    expect(model("civic si", HONDA)[0]).toBe("Civic");
    expect(model("silverado 1500", CHEVY_2019)[0]).toBe("Silverado");
    expect(model("mustang gt", FORD)[0]).toBe("Mustang");
    expect(resolveName("silverado 1500", CHEVY_2019, { aliases: MODEL_ALIASES })).toBe("Silverado");
  });
  it("nicknames: vette is Corvette", () => {
    expect(model("vette", CHEVY_2019)[0]).toBe("Corvette");
  });
  it("the make in front of the model is ignored (ram 1500, chevy-free 'chevrolet tahoe')", () => {
    expect(model("ram 1500", ["1500", "2500", "ProMaster"], "Ram")[0]).toBe("1500");
    expect(resolveName("ram 1500", ["1500", "2500"], { aliases: MODEL_ALIASES, stripPrefix: "Ram" })).toBe("1500");
    expect(model("chevrolet tahoe", CHEVY_2019, "Chevrolet")[0]).toBe("Tahoe");
  });
});

describe("years", () => {
  it("offers next model year down to 1981", () => {
    const ys = modelYears(new Date(2026, 9, 11));
    expect(ys[0]).toBe(2027);
    expect(ys.at(-1)).toBe(1981);
    expect(ys).toHaveLength(47);
  });
  it("2019 is 2019; 19 is 2019 first, then the 1980s and 1990s; 201 is the 2010s", () => {
    const ys = modelYears(new Date(2026, 9, 11));
    expect(rankYears("2019", ys)).toEqual([2019]);
    expect(rankYears("19", ys)[0]).toBe(2019);
    expect(rankYears("19", ys).slice(1)).toEqual(ys.filter((y) => y < 2000));
    expect(rankYears("201", ys)).toEqual([2019, 2018, 2017, 2016, 2015, 2014, 2013, 2012, 2011, 2010]);
    expect(rankYears("", ys)).toEqual(ys);
    expect(rankYears("1975", ys)).toEqual([]);
  });
});

describe("typeFromVpic", () => {
  it("treats heavy-duty chassis numbers with HD/XD as trucks, light-duty pickups as pickups", () => {
    expect(typeFromVpic("Truck", "4500HD")).toBe("truck");
    expect(typeFromVpic("Truck", "5500XD")).toBe("truck");
    expect(typeFromVpic("Truck", "Silverado")).toBe("pickup");
    expect(typeFromVpic("Truck", "Silverado HD")).toBe("pickup");
  });
});
