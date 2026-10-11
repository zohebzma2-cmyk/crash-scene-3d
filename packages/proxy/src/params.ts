// Strict request validation. Anything not listed here is rejected (never forwarded).
import { z } from "zod";

const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (min: number, max: number) =>
  z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().min(min).max(max).refine((s) => !CONTROL.test(s)));

const int = (min: number, max: number) =>
  z.string().regex(/^\d{1,5}$/).transform(Number).pipe(z.number().int().min(min).max(max));

const num = (min: number, max: number) =>
  z.string().regex(/^-?\d{1,3}(\.\d{1,12})?$/).transform(Number).pipe(z.number().min(min).max(max));

export const searchParams = z.strictObject({
  q: text(2, 200),
  limit: int(1, 5).default(5),
});

export const overpassParams = z.strictObject({
  lat: num(-90, 90),
  lon: num(-180, 180),
  radius: int(50, 400),
});

const coordText = /^-?\d{1,3}(\.\d{1,12})?$/;
const latField = z.string().regex(coordText).transform(Number).pipe(z.number().min(-90).max(90));
const lonField = z.string().regex(coordText).transform(Number).pipe(z.number().min(-180).max(180));
const bothOrNeither = (o: { lat?: number; lon?: number }) => (o.lat === undefined) === (o.lon === undefined);

export const crossingParams = z.strictObject({
  a: text(2, 80),
  b: text(2, 80),
  near: text(0, 120).default(""),
  /** Bias point (the claim or the map view), used to find the streets when `near` is empty. */
  lat: latField.optional(),
  lon: lonField.optional(),
}).refine(bothOrNeither, { path: ["lat"] });

/** "w,s,e,n" of the map view. */
const bboxField = z.string().regex(/^-?\d{1,3}(\.\d{1,12})?(,-?\d{1,3}(\.\d{1,12})?){3}$/).transform((s) => s.split(",").map(Number) as [number, number, number, number])
  .pipe(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]));

export const suggestParams = z.strictObject({
  q: text(3, 120),
  lat: latField.optional(),
  lon: lonField.optional(),
  bbox: bboxField.optional(),
  limit: int(1, 8).default(5),
}).refine(bothOrNeither, { path: ["lat"] });

export const crossStreetsParams = z.strictObject({
  street: text(2, 80),
  /** Where to look for a street found by name. Optional when `ways` pins the street down exactly. */
  near: z.string().regex(/^-?\d{1,3}(\.\d{1,12})?,-?\d{1,3}(\.\d{1,12})?$/)
    .transform((s) => { const [lat, lon] = s.split(",").map(Number) as [number, number]; return { lat, lon }; })
    .pipe(z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })).optional(),
  radius: int(50, 2000).default(1500),
  ways: z.string().regex(/^\d{1,12}(,\d{1,12}){0,39}$/).transform((s) => s.split(",").map(Number)).optional(),
}).refine((o) => o.near !== undefined || o.ways !== undefined, { path: ["near"] });

export const noParams = z.strictObject({});

const VEHICLE_MAKE = /^[A-Za-z0-9][A-Za-z0-9 .&'/-]{0,39}$/;
export const modelsParams = (currentYear: number) =>
  z.strictObject({
    make: text(1, 40).refine((s) => VEHICLE_MAKE.test(s)),
    year: int(1950, currentYear + 2),
  });

const VEHICLE_MODEL = /^[A-Za-z0-9][A-Za-z0-9 .&'/()+-]{0,59}$/;
const makeField = text(1, 40).refine((s) => VEHICLE_MAKE.test(s));
const modelField = text(1, 60).refine((s) => VEHICLE_MODEL.test(s));

/** /api/vehicles/model: only the year, make and model are ever sent upstream (as catalog slugs). */
export const vehicleModelParams = (currentYear: number) =>
  z.strictObject({ make: makeField, model: modelField, year: int(1950, currentYear + 2).optional() });

/** /api/vehicles/image. */
export const vehicleImageParams = (currentYear: number) =>
  z.strictObject({
    make: makeField,
    model: modelField,
    year: int(1950, currentYear + 2).optional(),
    view: z.enum(["front34", "front34-r", "front", "side", "side-r", "rear34", "rear34-r", "rear"]).default("front34"),
    width: z.enum(["200", "400", "800", "1200"]).transform(Number).default(400),
    type: z.enum(["car", "moto"]).default("car"),
  });

/** /api/logos/make. */
export const makeLogoParams = z.strictObject({ name: makeField });

/** z/x/y of a tile path, checked against the zoom range and the 2^z grid. */
export function tileCoords(parts: readonly string[], maxZoom: number): { z: number; x: number; y: number } | null {
  if (parts.length !== 3 || !parts.every((p) => /^\d{1,8}$/.test(p))) return null;
  const [z, x, y] = parts.map(Number) as [number, number, number];
  if (z > maxZoom) return null;
  const n = 2 ** z;
  return x < n && y < n ? { z, x, y } : null;
}

/** Query string → object, rejecting repeated keys. Returns the offending field names on failure. */
export function parseQuery<S extends z.ZodType>(url: URL, schema: S): { ok: true; data: z.output<S> } | { ok: false; fields: string[] } {
  const raw: Record<string, string> = {};
  const dupes: string[] = [];
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    if (all.length > 1) dupes.push(key);
    raw[key] = all[0] as string;
  }
  const result = schema.safeParse(raw);
  if (result.success && dupes.length === 0) return { ok: true, data: result.data };
  const fields = new Set<string>(dupes);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path[0];
      // Unrecognized keys are reported with the key names in `keys`.
      if (issue.code === "unrecognized_keys") for (const k of issue.keys) fields.add(k);
      else if (typeof path === "string") fields.add(path);
    }
  }
  return { ok: false, fields: [...fields].map((f) => f.replace(/[^\w-]/g, "").slice(0, 20)) };
}
