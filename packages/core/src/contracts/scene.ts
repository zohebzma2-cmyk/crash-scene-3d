// The scene: everything the claimant enters. This is the shared contract for
// the app, the physics, the exports and (later) the server. Validation lives
// here with messages a normal person can read. Nothing from a scene is ever
// rendered as HTML: the app shows these strings as text only.
import { z } from "zod";
import { MAX_PAINT_NAME, PAINT_HEX } from "../vehicle-color";

// zod compiles a faster parser with `new Function` and probes for it first. Under a strict CSP (no
// 'unsafe-eval') that probe is blocked and reported as a violation even though zod catches it. Our
// scenes are tiny, so the faster parser buys nothing: switch it off before any schema is built (this
// runs first in the module, so no consumer can build a schema ahead of it).
z.config({ jitless: true });

export const SCHEMA_VERSION = 4 as const;

export const LIGHTING = ["daylight", "dusk-dawn", "dark-lit", "dark-unlit", "not-sure"] as const;
export const WEATHER = ["clear", "rain", "snow", "fog", "not-sure"] as const;
export const CONTROL = ["green", "yellow", "red", "flashing", "stop", "yield", "none", "not-sure"] as const;
export const YES_NO = ["yes", "no", "not-sure"] as const;
export const VISIBILITY = ["sun-glare", "parked-cars", "hedges", "none", "not-sure"] as const;
export const ConditionsSchema = z.object({
  lighting: z.enum(LIGHTING).optional(),
  weather: z.enum(WEATHER).optional(),
  visibility: z.array(z.enum(VISIBILITY)).max(5).optional(),
});
export const VehicleAccountSchema = z.object({
  /** Separates an answer to the new question from a legacy placement lane. */
  lane: z.enum(["entered", "not-sure"]).optional(),
  control: z.enum(CONTROL).optional(),
  signaled: z.enum(YES_NO).optional(),
  braking: z.enum(YES_NO).optional(),
  swerving: z.enum(YES_NO).optional(),
  airbags: z.enum(YES_NO).optional(),
  towed: z.enum(YES_NO).optional(),
});

/** Largest scene file we'll read. Checked on the raw bytes before parsing. */
export const MAX_SCENE_BYTES = 1_000_000;

/** Limits used in messages and the UI. Display units here; physics converts at its boundary. */
export const LIMITS = Object.freeze({
  maxSpeedMph: 150,
  minLimitMph: 5,
  maxLimitMph: 85,
  minYear: 1950,
  maxYear: new Date().getFullYear() + 2,
  maxTextChars: 300,
  minVehicles: 2,
  maxVehicles: 4,
});

export const VEHICLE_IDS = ["A", "B", "C", "D"] as const;
export const VEHICLE_TYPES = ["car", "suv", "pickup", "van", "motorcycle", "truck"] as const;
export const ACTIONS = ["straight", "turn-left", "turn-right", "backing", "parked"] as const;
export const ZONES = ["front", "front-right", "right", "rear-right", "rear", "rear-left", "left", "front-left"] as const;
export const ROAD_CONDITIONS = ["dry", "wet", "snow", "ice"] as const;
export const PLACE_KINDS = ["intersection", "road", "parking"] as const;

export type VehicleId = (typeof VEHICLE_IDS)[number];
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export type Action = (typeof ACTIONS)[number];
export type Zone = (typeof ZONES)[number];
export type RoadCondition = (typeof ROAD_CONDITIONS)[number];
export type PlaceKind = (typeof PLACE_KINDS)[number];

const text = (what: string, max: number = LIMITS.maxTextChars) =>
  z.string({ error: `${what} should be text.` }).max(max, { error: `${what} is too long (${max} characters at most).` });

/** A whole section of the scene: one sentence when it is absent (or null), another when something is there but is the wrong kind of thing. */
const section = (missing: string, unreadable: string) => ({ error: (iss: { input?: unknown }) => (iss.input == null ? missing : unreadable) });

/** "Missing" vs "not a usable number": null, undefined, text, NaN and Infinity each get a sentence that is true for them. */
const coordinate = (what: "latitude" | "longitude", range: number) =>
  z.number({
    error: (iss) => (iss.input === undefined || iss.input === null
      ? `The location is missing its ${what}.`
      : `The ${what} has to be a number between −${range} and ${range}.`),
  });

const LatLonSchema = z.object({
  lat: coordinate("latitude", 90)
    .min(-90, { error: "The latitude has to be between −90 and 90." })
    .max(90, { error: "The latitude has to be between −90 and 90." }),
  lon: coordinate("longitude", 180)
    .min(-180, { error: "The longitude has to be between −180 and 180." })
    .max(180, { error: "The longitude has to be between −180 and 180." }),
}, section("The scene is missing its location.", "The scene's location isn't readable."));

/** Speeds are whole or tenths of a mile per hour: finer values would be rounded when printed, and the saved file must match what was entered. */
/** Only a finite value inside the allowed range is judged for tenths: anything else already has its own single message. */
const isTenths = (min: number, max: number) => (x: number) =>
  !Number.isFinite(x) || x < min || x > max || Math.abs(x * 10 - Math.round(x * 10)) < 1e-9;
const TENTHS_MESSAGE = "Use whole or tenths of a mile per hour, like 25 or 25.5.";

const SpeedSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("known"),
    mph: z.number({ error: "The speed should be a number of mph." })
      .min(0, { error: "The speed can't be below 0 mph." })
      .max(LIMITS.maxSpeedMph, { error: `That's faster than we can illustrate. Enter ${LIMITS.maxSpeedMph} mph or less.` })
      .refine(isTenths(0, LIMITS.maxSpeedMph), { error: TENTHS_MESSAGE }),
  }),
  z.object({
    kind: z.literal("unsure"),
    /** Posted limit the claimant gave; null = they don't know it (the physics then assumes a typical city limit). */
    limitMph: z.number({ error: "The speed limit should be a number of mph." })
      .min(LIMITS.minLimitMph, { error: `The speed limit can't be below ${LIMITS.minLimitMph} mph.` })
      .max(LIMITS.maxLimitMph, { error: `The speed limit can't be above ${LIMITS.maxLimitMph} mph.` })
      .refine(isTenths(LIMITS.minLimitMph, LIMITS.maxLimitMph), { error: TENTHS_MESSAGE })
      .nullable(),
  }),
], { error: "Each moving vehicle needs a speed, or 'not sure'." });

const TravelSchema = z.object({
  /** Compass bearing the vehicle was facing at impact, degrees [0, 360). From the real road when known. */
  bearingDeg: z.number({ error: "Pick which way the vehicle was going." })
    .min(0, { error: "The direction has to be between 0° and 360°." })
    .lt(360, { error: "The direction has to be between 0° and 360°." }),
  /** RoadNetwork way id the vehicle travelled on, when the road is known. */
  roadId: text("The road id", 80).nullable(),
  /** Road name for captions ("northbound on Main St"). */
  roadName: text("The road name", 120).nullable(),
  /**
   * An unnamed road's description for captions, from the roads at the pin ("the parking aisle (west one)"); never a
   * name, never painted on the road. Additive: absent (or null) in older v3 files, and left out of the canonical JSON
   * then, so their fingerprints don't change.
   */
  roadDesc: text("The road description", 120).nullable().transform((d) => d ?? undefined).optional(),
  /** Lane for its direction, 0 = rightmost. null = choose automatically. */
  lane: z.number({ error: "The lane should be a number from 0 to 19." }).int({ error: "The lane should be a whole number from 0 to 19." })
    .min(0, { error: "The lane should be a number from 0 to 19." }).max(19, { error: "The lane should be a number from 0 to 19." }).nullable(),
  /**
   * The vehicle came out of a driveway or parking lot beside the road (`roadId`) rather than along it: its path starts a
   * short way off the road, from a stop. Additive: absent (or false, or null) in older v3 files and left out of the
   * canonical JSON then, so their fingerprints don't change.
   */
  fromDriveway: z.boolean({ error: "Say whether the vehicle came out of a driveway or parking lot." }).nullable()
    .transform((d) => (d === true ? true : undefined)).optional(),
}, { error: "Each vehicle needs a direction of travel." });

const VehicleSchema = z.object({
  account: VehicleAccountSchema.optional(),
  id: z.enum(VEHICLE_IDS, { error: "Vehicles are lettered A to D." }),
  role: z.enum(["claimant", "other"], { error: "Say whether this is the claimant's vehicle or the other one." }),
  year: z.number({ error: "The year should be a number." }).int({ error: "The year should be a whole number." })
    .min(LIMITS.minYear, { error: `The year should be ${LIMITS.minYear} or later.` })
    .max(LIMITS.maxYear, { error: `The year can't be after ${LIMITS.maxYear}.` }).nullable(),
  make: text("The make", 60),
  model: text("The model", 80),
  type: z.enum(VEHICLE_TYPES, { error: "Pick the kind of vehicle." }),
  typeSource: z.enum(["claim", "vpic", "manual"], { error: "The scene doesn't say where the vehicle type came from." }),
  action: z.enum(ACTIONS, { error: "Pick what the vehicle was doing." }),
  travel: TravelSchema,
  speed: SpeedSchema,
  /** Braking before impact entered by the claimant. Default no braking (an assumption). */
  braking: z.boolean({ error: "Braking should be yes or no." }).default(false),
  zone: z.enum(ZONES, { error: "Pick where the vehicle was hit." }),
  /**
   * The paint the claimant picked (round B; additive, so older v3 files still load). Absent or null =
   * "Not sure": the body is drawn in the vehicle's token colour. Never part of the vehicle's identity:
   * letters and outlines stay in the token colour. Absent keys are left out of the canonical JSON, so
   * a scene without a paint keeps the fingerprint it always had.
   */
  // Normalised as it is read: name trimmed, hex lower case, null the same as absent, so equal paints give equal canonical bytes.
  color: z.object({
    name: text("The colour name", MAX_PAINT_NAME).trim().min(1, { error: "The colour needs a name." }),
    hex: z.string({ error: "The colour should look like #b3151b." }).regex(PAINT_HEX, { error: "The colour should look like #b3151b." }).toLowerCase(),
  }, { error: "The colour isn't readable." }).nullable().transform((c) => c ?? undefined).optional(),
}, { error: "Each vehicle needs its details filled in." });

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day (month 1-12, day within that month, leap years included). */
function isRealDate(d: string): boolean {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  if (m < 1 || m > 12 || day < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
  return day <= days;
}

/** The latest date accepted: tomorrow in UTC, so a claimant ahead of UTC can enter their own today. */
function latestAllowedDate(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

const NOT_A_SCENE ="That doesn't look like a crash scene.";

export const SceneSchema = z.object({
  conditions: ConditionsSchema.optional(),
  schemaVersion: z.literal(SCHEMA_VERSION, {
    error: (iss) => (iss.input == null
      ? "This file doesn't say which version of the tool saved it, so it can't be opened."
      : "This scene file is from a different version of the tool and can't be opened."),
  }),
  claim: z.object({
    number: text("The claim number", 40),
    /** Vehicle on the claim. Editing vehicle A never changes this. */
    vehicle: z.object({
      year: z.number({ error: "The claim year should be a number." }).int({ error: "The claim year should be a whole number." }).nullable(),
      make: text("The claim make", 60),
      model: text("The claim model", 80),
    }, section("The claim is missing its vehicle details.", "The claim's vehicle details aren't readable.")),
  }, section("The scene is missing its claim details.", "The scene's claim details aren't readable.")),
  location: LatLonSchema.extend({
    /** Place name from search, or empty when the pin was placed by hand. */
    label: text("The place name"),
    /** The searched place the pin was moved from, for "near …". */
    nearLabel: text("The nearby place name"),
    source: z.enum(["search", "pin", "example", "file"], { error: "The scene doesn't say how the location was chosen." }),
    place: z.enum(PLACE_KINDS, { error: "Pick the kind of place." }),
  }),
  occurred: z.object({
    date: z.string({ error: "The date should look like 2026-10-02." })
      .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "The date should look like 2026-10-02." })
      .refine((d) => !DATE_SHAPE.test(d) || isRealDate(d), { error: "The date isn't a real date. Use the date the crash happened." })
      .refine((d) => !DATE_SHAPE.test(d) || !isRealDate(d) || d <= latestAllowedDate(), { error: "The date is in the future. Use the date the crash happened." }),
    time: z.string({ error: "The time should look like 17:15." }).regex(/^\d{2}:\d{2}$/, { error: "The time should look like 17:15." }).nullable(),
  }, section("The scene is missing the date of the crash.", "The scene's date of the crash isn't readable.")),
  road: z.object({
    condition: z.enum(ROAD_CONDITIONS, { error: "Pick what the road was like." }),
    /**
     * The claimant didn't say what the road was like (a new visitor starts with nothing prefilled; owner, 2026-10-14).
     * `condition` then holds a placeholder the physics runs on (dry) that is never shown as an answer: the summary, the
     * PDF and the assumptions say the road surface was not given. Additive: absent (or false, or null) means the
     * condition was entered, as in every older file, and is left out of the canonical JSON then, so their fingerprints
     * don't change.
     */
    conditionNotGiven: z.boolean({ error: "Say whether the road condition was given." }).nullable()
      .transform((d) => (d === true ? true : undefined)).optional(),
  }, section("The scene is missing the road condition.", "The scene's road condition isn't readable.")),
  vehicles: z.array(VehicleSchema, section("The scene is missing its vehicles.", "The scene's vehicles aren't readable."))
    .min(LIMITS.minVehicles, { error: "Add at least two vehicles." })
    .max(LIMITS.maxVehicles, { error: `A scene can have ${LIMITS.maxVehicles} vehicles at most.` }),
}, { error: NOT_A_SCENE }).superRefine((s, ctx) => {
  s.vehicles.forEach((v, i) => {
    if (v.id !== VEHICLE_IDS[i]) ctx.addIssue({ code: "custom", path: ["vehicles", i, "id"], message: "Vehicles have to be lettered A, B, C, D in order." });
  });
  if (!s.vehicles.some((v) => v.action !== "parked")) ctx.addIssue({ code: "custom", path: ["vehicles"], message: "At least one vehicle has to be moving." });
});

export type Scene = z.infer<typeof SceneSchema>;
export type SceneVehicle = Scene["vehicles"][number];
export type SceneSpeed = SceneVehicle["speed"];

/** The saved scene file: the scene plus the export stamp and derived values. Canonical JSON of this is hashed. */
export const SceneFileSchema = SceneSchema.and(z.object({
  createdAt: z.string({ error: "The save time is missing or malformed." }).datetime({ error: "The save time is missing or malformed." }),
  disclaimer: z.string({ error: "This file is missing the illustration notice." }).min(1, { error: "This file is missing the illustration notice." }),
  derived: z.unknown().optional(),
}, { error: NOT_A_SCENE }));
export type SceneFile = z.infer<typeof SceneFileSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Turn zod issues into short sentences, prefixed with the vehicle letter when relevant. */
export function plainErrors(issues: readonly z.core.$ZodIssue[], input: unknown): string[] {
  const out = new Set<string>();
  for (const issue of issues) {
    const p = issue.path;
    let prefix = "";
    if (p[0] === "vehicles" && typeof p[1] === "number") {
      const raw = (input as { vehicles?: Array<{ id?: unknown }> })?.vehicles?.[p[1]];
      const letter = typeof raw?.id === "string" && /^[A-D]$/.test(raw.id) ? raw.id : VEHICLE_IDS[p[1]] ?? `#${p[1] + 1}`;
      prefix = `Vehicle ${letter}: `;
    }
    out.add(`${prefix}${plainMessage(issue, input)}`);
  }
  return [...out];
}

/** Said when a validation message would otherwise be zod's own wording (never shown raw). */
const FALLBACK_MESSAGE = "Something in the scene isn't in the form we expect.";

/** The value at an issue's path in the raw input (undefined when any step is absent). */
function valueAt(input: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur = input;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

function plainMessage(issue: z.core.$ZodIssue, input: unknown): string {
  const msg = issue.message;
  // zod's own default wording ("Invalid input: expected …", "Too small: …") is never shown.
  if (/^(Invalid input|Too (small|big)|Invalid (string|option|literal|key|value)|Unrecognized key)/.test(msg)) return FALLBACK_MESSAGE;
  // Only a value that really is absent gets "(it's missing)"; a value of the wrong kind keeps its own sentence.
  const value = valueAt(input, issue.path);
  if (issue.code === "invalid_type" && (value === undefined || value === null) && !/missing/i.test(msg) && msg !== NOT_A_SCENE) return `${msg.replace(/\.$/, "")} (it's missing).`;
  return msg;
}

/**
 * A scene from another version is reported by that alone: its other fields were never checked
 * against this version's rules, so listing them would only be noise.
 */
function plainFailure(issues: readonly z.core.$ZodIssue[], input: unknown): string[] {
  const version = issues.find((i) => i.path[0] === "schemaVersion");
  return version ? [version.message] : plainErrors(issues, input);
}

export function parseScene(input: unknown): ParseResult<Scene> {
  const r = SceneSchema.safeParse(migrateScene(input));
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: plainFailure(r.error.issues, input) };
}

/**
 * Read a scene file the claimant opened. Checks the size first, then JSON,
 * then the schema. Never throws; errors are plain sentences.
 */
export function parseSceneFile(bytes: Uint8Array): ParseResult<SceneFile> {
  if (bytes.byteLength > MAX_SCENE_BYTES) {
    // Rounded DOWN to a tenth, so the size is never overstated; a file just over the limit says only that.
    const mb = Math.floor(bytes.byteLength / 1e5) / 10;
    const limit = MAX_SCENE_BYTES / 1e6;
    return { ok: false, errors: [mb <= limit ? `That file is too big to be a scene file (it's over the ${limit} MB limit).` : `That file is too big to be a scene file (${mb.toFixed(1)} MB; the limit is ${limit} MB).`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, errors: ["That file isn't a scene file we can read (it isn't valid JSON)."] };
  }
  const r = SceneFileSchema.safeParse(migrateScene(json));
  return r.success ? { ok: true, value: r.data } : { ok: false, errors: plainFailure(r.error.issues, json) };
}

/** v3 already carries the same physics inputs. Do not invent answers or change those inputs. */
export function migrateScene(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const old = input as Record<string, unknown>;
  if (old.schemaVersion !== 3) return input;
  return { ...old, schemaVersion: SCHEMA_VERSION };
}
