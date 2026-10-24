// Scheduled "keep-warm" ping. Netlify spins a function down after a few minutes idle, and the next visitor
// then waits on a cold start (the "it has to warm up" complaint). This runs every 5 minutes and makes a couple
// of cheap requests to the live site's OWN endpoints so the app and the /api function (and its Blobs client)
// stay warm. It never calls an upstream provider: /api/vehicles/makes is answered from the long-lived cache
// after the first call, and the static page is just a file.
//
// It is tiny and fully resilient: any error (a missing URL in a context without one, a slow endpoint, a non-200)
// is swallowed, because a keep-warm ping must never turn into a logged failure or a retry storm. It writes no
// data and reads nothing sensitive.
//
// Scheduled Functions are available on every Netlify plan (including the free tier), so this ships as-is; if a
// plan ever disallowed them the deploy's function build would say so and the rest of the hardening still stands.
import type { Config } from "@netlify/functions";

const PATHS = ["/", "/api/vehicles/makes"] as const;
/** Don't let a slow endpoint hold the scheduled run open. */
const PING_TIMEOUT_MS = 8000;

export default async (): Promise<Response> => {
  // process.env.URL is the site's primary URL on Netlify; without it (e.g. a context that doesn't set it) there
  // is nothing to ping, so we quietly do nothing.
  const base = process.env.URL;
  if (!base) return new Response("no URL to warm", { status: 200 });
  await Promise.allSettled(PATHS.map(async (path) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    try {
      // HEAD on the static page, GET on the API route (it only answers GET). Errors are swallowed on purpose.
      const method = path === "/" ? "HEAD" : "GET";
      await fetch(new URL(path, base), { method, signal: ctrl.signal, headers: { "user-agent": "crash-scene-3d-warm/1" } });
    } catch {
      // A keep-warm ping must never fail the run.
    } finally {
      clearTimeout(timer);
    }
  }));
  return new Response("warmed", { status: 200 });
};

// Every 5 minutes. Netlify runs scheduled functions on this cron.
export const config: Config = { schedule: "*/5 * * * *" };
