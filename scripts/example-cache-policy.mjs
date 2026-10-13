// Offline example minimization. No upstream calls and no replacement/hand-authored map tags.
export const EXAMPLE_TAGS = new Set([
  'highway', 'service', 'oneway', 'junction', 'lanes', 'lanes:forward', 'lanes:backward', 'lanes:both_ways',
  'turn:lanes', 'turn:lanes:forward', 'turn:lanes:backward', 'turn:lanes:both_ways',
  'maxspeed', 'maxspeed:forward', 'maxspeed:backward', 'width', 'name', 'ref',
  'building', 'building:levels', 'height', 'amenity', 'footway', 'crossing', 'crossing:markings',
  'crossing:signals', 'crossing:island', 'direction', 'traffic_sign', 'traffic_sign:direction',
  'traffic_signals', 'traffic_signals:direction', 'lit',
]);
export function distanceM(a, b) {
  const r = Math.PI / 180, dLat = (a.lat - b.lat) * r, dLon = (a.lon - b.lon) * r;
  return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2)));
}
export function minimizeExampleCache(data, pin = data.center) {
  const inside = p => p && distanceM(pin, p) <= 250;
  const rad = Math.PI / 180, radius = 249.95;
  const xy = p => [(p.lon - pin.lon) * rad * 6371008.8 * Math.cos(pin.lat * rad), (p.lat - pin.lat) * rad * 6371008.8];
  const clip = geometry => {
    const runs = []; let run = [];
    const flush = () => { if (run.length > 1) runs.push(run); run = []; };
    for (let i = 1; i < geometry.length; i++) {
      const a = geometry[i - 1], b = geometry[i], [ax,ay] = xy(a), [bx,by] = xy(b);
      const dx = bx-ax, dy=by-ay, aa=dx*dx+dy*dy, bb=2*(ax*dx+ay*dy), cc=ax*ax+ay*ay-radius*radius;
      if (!aa) continue;
      const disc = bb*bb-4*aa*cc;
      if (disc < 0) { flush(); continue; }
      const lo = Math.max(0,(-bb-Math.sqrt(disc))/(2*aa)), hi = Math.min(1,(-bb+Math.sqrt(disc))/(2*aa));
      if (lo >= hi) { flush(); continue; }
      const at = t => t === 0 ? a : t === 1 ? b : { lat:a.lat+(b.lat-a.lat)*t, lon:a.lon+(b.lon-a.lon)*t };
      if (lo > 0) flush();
      if (!run.length) run.push(at(lo));
      run.push(at(hi)); if (hi < 1) flush();
    }
    flush(); return runs;
  };
  const elements = [];
  for (const e of data.elements) {
    const tags = Object.fromEntries(Object.entries(e.tags ?? {}).filter(([k]) => EXAMPLE_TAGS.has(k) && (k !== 'name' || e.type === 'way' && e.tags?.highway)));
    if (e.type === 'node') {
      if (inside(e)) elements.push({ type: 'node', id: e.id, lat: e.lat, lon: e.lon, tags });
      continue;
    }
    if (e.type !== 'way' || !e.geometry?.length) continue;
    const allInside = e.geometry.every(inside);
    if ((tags.building || tags.amenity === 'parking') && !allInside) continue;
    const runs = allInside ? [e.geometry] : clip(e.geometry);
    // Do not join disconnected segments or invent extra OpenStreetMap way identifiers.
    if (runs.length !== 1) continue;
    const geometry = runs[0];
    if (geometry.length < 2) continue;
    elements.push({ type: 'way', id: e.id, ...(e.nodes?.length === e.geometry.length ? { nodes: geometry.map(p => e.nodes[e.geometry.indexOf(p)] ?? null) } : {}), geometry, tags });
  }
  const capture = { ...data };
  delete capture.retainedTagSource;
  return { ...capture, radiusM: 250, filter: 'example-circle-v1: geometry within 250 m of scene pin; line ends interpolated at circle boundary; split runs and cut polygons omitted; strict public-road tag whitelist', elements };
}
