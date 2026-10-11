// Runs every benchmark scene through a fixer, on the main thread or in a module Web Worker (like the app), and records
// each search's time plus the longest main-thread task seen meanwhile (what a claimant would feel as a freeze).
import { cases } from "./data";
import { type One, runOne } from "./run";

const params = new URLSearchParams(location.search);
const which = params.get("which") ?? "v2";
const mode = params.get("mode") ?? "worker";
let longest = 0;
try {
  new PerformanceObserver((list) => { for (const e of list.getEntries()) longest = Math.max(longest, e.duration); }).observe({ type: "longtask", buffered: true });
} catch { /* no long-task timing in this browser */ }

async function main(): Promise<void> {
  const out: One[] = [];
  if (mode === "main") {
    for (let i = 0; i < cases.length; i++) {
      out.push(runOne(i, which));
      // One search per task, so the longest task is the longest freeze a claimant would feel.
      await new Promise((r) => setTimeout(r, 0));
    }
  } else {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    for (let i = 0; i < cases.length; i++) {
      out.push(await new Promise<One>((resolve) => { w.onmessage = (e: MessageEvent<One>) => resolve(e.data); w.postMessage({ i, which }); }));
    }
    w.terminate();
  }
  await new Promise((r) => setTimeout(r, 50));
  (window as unknown as { __bench: unknown }).__bench = { which, mode, results: out, longestTaskMs: longest, ua: navigator.userAgent };
  document.getElementById("out")!.textContent = `done: ${out.length}`;
}
void main();
