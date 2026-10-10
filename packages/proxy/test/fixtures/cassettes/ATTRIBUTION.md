# Recorded exchanges (cassettes)

Each file is one real request to the project's proxy and everything behind it, recorded once on 2026-10-10
from a local `netlify dev` run with a fresh cache, with the User-Agent
`InsurifyAI-CrashScene/1.0 (+https://github.com/zohebzma2-cmyk/crash-scene-3d)`:

- `request`: the browser's call to `/api/geo/...`
- `response`: what the proxy answered (status and body)
- `upstream`: each call the proxy made to Photon, Nominatim or Overpass, with the real response text

Tests replay these and never contact a live service. They check that the proxy asks upstream for exactly what
was recorded and answers exactly what it answered.

Data sources and credit:

- Roads and street names: Overpass API, © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0.
  https://www.openstreetmap.org/copyright
- Place and street search: Photon (komoot) https://photon.komoot.io and Nominatim https://nominatim.openstreetmap.org, both
  serving OpenStreetMap data, © OpenStreetMap contributors (ODbL 1.0).

The recordings hold street names, town names and OSM way and node ids only: no personal data. Per the project rule
(no house numbers in fixtures), any Photon result that carried a house number was removed from the recordings. Because
of that a suggest answer can come back with one more trailing entry than was recorded (the next result fills the
place), so the suggest replays check that the recorded answer is a prefix of the replayed one.

Public streets only: every recording is about a main road in a town centre (Main and Amherst Street in Nashua, Elm and
Hanover Street in Manchester, North Main and Pleasant Street in Concord, Boylston and Tremont Street in Boston).
Overpass elements not named exactly like those two streets were removed from the recordings (the answers are unchanged),
so no side or residential streets are kept. The search area of the live calls was a town centre, never a private address.
