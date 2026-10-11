// Car and motorcycle makers (as vPIC and claimants spell them) to the web domain logo.dev knows them by.
// Keys are normalized: lower case, letters and digits only ("Mercedes-Benz" -> "mercedesbenz").
// A make missing here is looked up once with logo.dev's search (secret key) and only accepted when the
// result's name is the make itself; that answer is cached for a year.
// Only domains that are the maker's own and still live are listed. Left out on purpose (2026-10-11 review): Mercury
// (mercury.com is a bank), Saab (saab.com is the defence company), and makes that no longer exist or whose domain we
// can't vouch for (Hummer, Plymouth, Pontiac, Oldsmobile, Saturn, Scion, Fisker): CarImages, then logo.dev's search
// (top result, exact name) or the fallback icon cover them.

/** Lower case, letters and digits only: how makes are compared everywhere in the media routes. */
export const normMake = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** What people type for a make (normalized), to the name the catalogs use. */
export const MAKE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  chevy: "Chevrolet",
  vw: "Volkswagen",
  mercedes: "Mercedes-Benz",
  benz: "Mercedes-Benz",
  mb: "Mercedes-Benz",
  rangerover: "Land Rover",
  alfa: "Alfa Romeo",
  harley: "Harley-Davidson",
  hd: "Harley-Davidson",
  minicooper: "MINI",
});

/** The make as the catalogs name it: an alias resolved, else the typed text trimmed. */
export const canonicalMake = (typed: string): string => MAKE_ALIASES[normMake(typed)] ?? typed.replace(/\s+/g, " ").trim();

/** A URL slug for a make or model name ("Land Rover" -> "land-rover", "Mercedes-Benz" -> "mercedes-benz"). */
export const slugOf = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const MAKE_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  acura: "acura.com",
  alfaromeo: "alfaromeo.com",
  astonmartin: "astonmartin.com",
  audi: "audi.com",
  bentley: "bentleymotors.com",
  bmw: "bmw.com",
  buick: "buick.com",
  cadillac: "cadillac.com",
  chevrolet: "chevrolet.com",
  chrysler: "chrysler.com",
  dodge: "dodge.com",
  ferrari: "ferrari.com",
  fiat: "fiat.com",
  ford: "ford.com",
  genesis: "genesis.com",
  gmc: "gmc.com",
  honda: "honda.com",
  hyundai: "hyundai.com",
  infiniti: "infiniti.com",
  isuzu: "isuzu.com",
  jaguar: "jaguar.com",
  jeep: "jeep.com",
  kia: "kia.com",
  lamborghini: "lamborghini.com",
  landrover: "landrover.com",
  lexus: "lexus.com",
  lincoln: "lincoln.com",
  lotus: "lotuscars.com",
  lucid: "lucidmotors.com",
  maserati: "maserati.com",
  mazda: "mazda.com",
  mclaren: "mclaren.com",
  mercedesbenz: "mercedes-benz.com",
  mini: "mini.com",
  mitsubishi: "mitsubishi-motors.com",
  nissan: "nissanusa.com",
  polestar: "polestar.com",
  porsche: "porsche.com",
  ram: "ramtrucks.com",
  rivian: "rivian.com",
  rollsroyce: "rolls-roycemotorcars.com",
  smart: "smart.com",
  subaru: "subaru.com",
  suzuki: "suzuki.com",
  tesla: "tesla.com",
  toyota: "toyota.com",
  volkswagen: "vw.com",
  volvo: "volvocars.com",
  freightliner: "freightliner.com",
  kenworth: "kenworth.com",
  peterbilt: "peterbilt.com",
  mack: "macktrucks.com",
  international: "internationaltrucks.com",
  harleydavidson: "harley-davidson.com",
  yamaha: "yamaha-motor.com",
  kawasaki: "kawasaki.com",
  ducati: "ducati.com",
  triumph: "triumphmotorcycles.com",
  ktm: "ktm.com",
  indian: "indianmotorcycle.com",
  vespa: "vespa.com",
});
