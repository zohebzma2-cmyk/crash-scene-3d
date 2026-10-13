// Local headless baseline. Never permits provider requests.
import { build } from 'rolldown';
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const label = process.argv[2] ?? 'after';
const base = process.argv[3] ?? 'http://127.0.0.1:4198';
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw Error('Local builds only');
const bundle = `${process.cwd()}/qa-output/benchmarks/core-${label}.mjs`;
await build({ input: 'packages/core/src/index.ts', platform: 'node', output: { file: bundle, format: 'esm' } });
const mapBundle = `${process.cwd()}/qa-output/benchmarks/map-${label}.mjs`;
await build({ input: 'packages/mapdata/src/index.ts', platform: 'node', output: { file: mapBundle, format: 'esm' } });
const { taggedCrosswalkPaint } = await import(pathToFileURL(bundle));
const { parseOverpass } = await import(pathToFileURL(mapBundle));
const data = JSON.parse(await readFile('examples/t-bone-intersection/osm.json', 'utf8'));
const frame = { origin: data.center, metersPerUnit: 1 };
const cold = [], warm = [];
for (let i = 0; i < 12; i++) {
 const net = parseOverpass(data, frame, data.radiusM, data.fetchedAt);
 let at = performance.now(); taggedCrosswalkPaint(net); cold.push(performance.now() - at);
 at = performance.now(); for (let j = 0; j < 3; j++) taggedCrosswalkPaint(net); warm.push((performance.now() - at) / 3);
}
const browser = await chromium.launch(); const load = [];
try { for (let i = 0; i < 7; i++) {
 const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
 const page = await context.newPage();
 await page.route('**/*', r => ['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname) ? r.continue() : r.abort());
 const at = performance.now();
 await page.goto(`${base}/?fixtures=1&example=t-bone-intersection#review`);
 await page.locator('.viewer-canvas[data-ready="true"]').waitFor({ timeout: 90000 });
 load.push(performance.now() - at); await context.close();
} } finally { await browser.close(); }
const median = a => [...a].sort((a,b)=>a-b)[Math.floor(a.length / 2)];
const result = { label, crosswalkColdMedianMs: median(cold), crosswalkReuseMedianMs: median(warm), viewerReadyMedianMs: median(load), cold, warm, load };
await writeFile(`qa-output/benchmarks/${label}.json`, JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
