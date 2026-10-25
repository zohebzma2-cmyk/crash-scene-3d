# Data sources for this example

- Roads, buildings and parking: © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0. https://www.openstreetmap.org/copyright
  Fetched 2026-10-24T21:06:57Z from https://overpass.openstreetmap.fr/api/interpreter.
- Elevation: Terrarium tiles from the AWS Terrain Tiles open dataset (Mapzen/Tilezen; sources include USGS 3DEP and SRTM). https://registry.opendata.aws/terrain-tiles/
- The claim, people and vehicles in scene.json are made up. The place is a famous public intersection. House numbers and contact details have been stripped from the OSM building tags (scripts/fetch-curated.mjs): only public road geometry, street names and the town (addr:city) remain.
- Crossing: State Street and Madison Street, Chicago (the origin of the city's address grid; OSM node 27446720).
