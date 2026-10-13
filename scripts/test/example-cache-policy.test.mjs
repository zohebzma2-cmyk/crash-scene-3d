import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { distanceM, minimizeExampleCache } from '../example-cache-policy.mjs';

describe('example circle privacy boundary', () => {
 for (const name of ['t-bone-intersection', 'highway-rear-end', 'parking-lot-backing']) {
  it(`${name}: every stored node and way vertex is within 250 m of the scene pin`, () => {
   const data = JSON.parse(readFileSync(`examples/${name}/osm.json`, 'utf8'));
   const scene = JSON.parse(readFileSync(`examples/${name}/scene.json`, 'utf8'));
   for (const e of data.elements) {
    for (const p of e.type === 'node' ? [e] : e.geometry) expect(distanceM(scene.location, p)).toBeLessThanOrEqual(250);
    if (e.nodes) expect(e.nodes).toHaveLength(e.geometry.length);
   }
  });
 }
 it('never joins disconnected retained runs or invents a polygon edge', () => {
  const center = { lat: 0, lon: 0 }, near = { lat: 0, lon: .001 }, far = { lat: 0, lon: .004 };
  const data = { center, elements: [
   { type: 'node', id: 1, ...far },
   { type: 'way', id: 2, geometry: [center, near, far, near, center], tags: { highway: 'residential' } },
   { type: 'way', id: 3, geometry: [center, near, far, center], tags: { building: 'yes' } },
   { type: 'way', id: 4, geometry: [far, near, center], nodes: [5,6,7], tags: { highway: 'residential' } },
  ] };
  const kept = minimizeExampleCache(data).elements;
  expect(kept.map(e => e.id)).toEqual([4]);
  expect(kept[0].geometry.slice(1)).toEqual([near,center]);
  expect(kept[0].nodes).toEqual([null,6,7]);
  for (const p of kept[0].geometry) expect(distanceM(center,p)).toBeLessThanOrEqual(250);
 });
});
