# Data sources for this example

- Roads, buildings and parking: © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0. https://www.openstreetmap.org/copyright
  Fetched 2026-10-11T22:38:30Z through the local /api proxy from https://overpass.kumi.systems/api/interpreter.
- Elevation: Terrarium tiles from the AWS Terrain Tiles open dataset (Mapzen/Tilezen; sources include USGS 3DEP and SRTM). https://registry.opendata.aws/terrain-tiles/
- The claim, people and vehicles in scene.json are made up. The place is a public road; no house numbers or personal data.
- F.E. Everett Turnpike (US 3) northbound, Nashua NH (on OSM way 909188998).

- This capture includes tagged road controls, lane annotations and street lights. Missing OSM tags remain unknown.
- Existing `change:lanes` tags were retained from the prior cached capture; `retainedTagSource` in osm.json records their source. No additional provider request was made.
