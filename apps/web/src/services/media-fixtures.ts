// Fixtures mode for vehicle photos, models and logos: a stand-in for our /api media routes that answers
// like the proxy does, from synthetic files (apps/web/test/fixtures/media, made by
// scripts/make-media-fixtures.mjs). Nothing calls /api. The real client code (media.ts) runs on top of it.
//
// ?media=on    photos, logos and models are served (the synthetic files)
// ?media=busy  every media call answers 429, as a provider over its quota would
// (default)    every media call answers the fallback (204), so fixtures screens look as they did before
// Only in a dev server or a VITE_FIXTURES=1 build; elsewhere the files aren't even bundled.
import { MEDIA_HEADERS, PROXY_ROUTES } from "@csd/core";
import type { FetchLike } from "./http";

export type FixtureMediaMode = "on" | "busy" | "off";

const FIXTURE_BUILD = import.meta.env.DEV || import.meta.env.VITE_FIXTURES === "1";
const files = (FIXTURE_BUILD ? import.meta.glob("../../test/fixtures/media/*", { query: "?url", import: "default" }) : {}) as Record<string, () => Promise<string>>;

export function fixtureMediaMode(search: string): FixtureMediaMode {
  const m = new URLSearchParams(search).get("media");
  return m === "on" || m === "1" ? "on" : m === "busy" ? "busy" : "off";
}

async function fileBytes(name: string): Promise<Uint8Array | null> {
  const key = Object.keys(files).find((k) => k.endsWith(`/${name}`));
  const url = key ? await (files[key] as () => Promise<string>)() : null;
  if (!url) return null;
  const res = await fetch(url);
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

/** A fetch for the media routes only, answering from the synthetic files. */
export function createFixtureMediaFetch(mode: FixtureMediaMode, load: (name: string) => Promise<Uint8Array | null> = fileBytes): FetchLike {
  return async (input) => {
    const path = input.split("?")[0];
    const isMedia = path === PROXY_ROUTES.vehicleImage || path === PROXY_ROUTES.vehicleModel || path === PROXY_ROUTES.makeLogo;
    if (!isMedia) return new Response(null, { status: 404 });
    if (mode === "busy") {
      return new Response(JSON.stringify({ code: "busy", message: "Busy." }), { status: 429, headers: { "content-type": "application/json", "retry-after": "60" } });
    }
    const fallback = () => path === PROXY_ROUTES.vehicleModel
      ? new Response(JSON.stringify({ fallback: true, reason: "no-model" }), { status: 200, headers: { "content-type": "application/json", [MEDIA_HEADERS.fallback]: "no-model" } })
      : new Response(null, { status: 204, headers: { [MEDIA_HEADERS.fallback]: "no-image", [MEDIA_HEADERS.image]: "none" } });
    if (mode === "off") return fallback();
    const name = path === PROXY_ROUTES.vehicleModel ? "car.glb" : path === PROXY_ROUTES.makeLogo ? "logo.png" : "car.png";
    const bytes = await load(name);
    if (!bytes) return fallback();
    const headers: Record<string, string> =
      path === PROXY_ROUTES.vehicleModel ? { "content-type": "model/gltf-binary", [MEDIA_HEADERS.watermarked]: "false" }
      : path === PROXY_ROUTES.makeLogo ? { "content-type": "image/png", [MEDIA_HEADERS.logoSource]: "carimages" }
      : { "content-type": "image/png", [MEDIA_HEADERS.image]: "exact", [MEDIA_HEADERS.view]: "front34" };
    return new Response(bytes as BodyInit, { status: 200, headers });
  };
}
