import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { minimizeExampleCache } from './example-cache-policy.mjs';
for (const name of ['t-bone-intersection', 'highway-rear-end', 'parking-lot-backing']) {
 const path = `examples/${name}/osm.json`;
 const old = JSON.parse(process.argv.includes('--from-head') ? execFileSync('git', ['show', `HEAD:${path}`], { encoding: 'utf8' }) : await readFile(path, 'utf8'));
 const scene = JSON.parse(await readFile(`examples/${name}/scene.json`, 'utf8'));
 const data = minimizeExampleCache(old, scene.location);
 await writeFile(path, JSON.stringify(data));
 console.log(`${name}: ${old.elements.length} -> ${data.elements.length} elements; ${data.elements.filter(e => e.type === 'way').length} ways, ${data.elements.filter(e => e.type === 'node').length} nodes`);
}
