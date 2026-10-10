# Prototype walkthrough

Run: 2026-10-09T20:52:43.013Z

## 1440px — 51/51 passed

| | Check | Detail |
|---|---|---|
| PASS | Claim address is prefilled but not sent until the claimant taps Search | This is the address on your claim. Tap Search to find it on the map. |
| PASS | No-results state for the made-up claim address offers the pin drop |  |
| PASS | Search box shows the whole field width (no cut-off) | 335px |
| PASS | Live Nominatim search: loading state, then results with attribution | 4 results |
| PASS | Picking a result moves the pin, recenters and fills the coordinates | 40.75701, -73.98597; street filled: "Times Square" |
| PASS | Zoom in and zoom out change the map zoom | zoom 18 → 17 → 18 |
| PASS | Dragging the pin updates the coordinates under the map | 40.75701, -73.98597 → 40.75689, -73.98565; exports will say "near Times Square" |
| PASS | Tapping the map moves the pin | 40.75657, -73.98670 |
| PASS | A search with no matches shows the no-results message (queued at 1 request per second) |  |
| PASS | Place type: parking hides street names (and drops them from captions), road hides the cross street |  |
| PASS | Street names, date and time take input |  |
| PASS | Road condition tiles have a clear selected state | selected ring: rgb(37, 99, 235) 0px 0px 0px 1px inset |
| PASS | Next goes to vehicles and keeps step 1 marked done |  |
| PASS | Your car is prefilled from the claim and editable |  |
| PASS | Year, make and model look up the model list in NHTSA vPIC and fill in the type | SUV from NHTSA vPIC (Multipurpose Passenger Vehicle (MPV)). Weight and size: suv class average. |
| PASS | Picking a type by hand overrides the lookup |  |
| PASS | Direction picker updates the arrow and the caption | arrow 90deg; "Heading east on Maple Ave" |
| PASS | Every action works and changes the caption (straight, turning left/right, backing up, parked) | Turning left, ending up heading east on Maple Ave / Turning right, ending up heading east on Maple Ave / Facing east, backing up on Maple Ave / Parked, facing east on Maple Ave / Heading east on Maple Ave |
| PASS | Arrow keys move the choice inside a radio group (one tab stop per group) | moved to 180°, back with ArrowLeft |
| PASS | Speed stepper changes the speed |  |
| PASS | Impact zones select (A front right) |  |
| PASS | Vehicle B: Not sure + limit stepper + I don't know the limit | 25–35 → 20–30; "We'll show 20–30 mph, around 25 mph, a typical city limit. The picture uses 25 mph." |
| PASS | Validation: same direction, neither hit in the rear, shows a plain warning instead of the picture | Your car (A) and vehicle B were both going east. When two vehicles going the same way collide, one is usually hit in the rear, but neither is marked that way. Check the directions or where each was hit. |
| PASS | Validation: impossible zones (head-on marked as rear) are explained | Your car (A) would have come at vehicle B head-on, from the front, but vehicle B is marked as hit on the rear. Check the direction, what each vehicle was doing, or where it was hit. |
| PASS | Fixing the details clears the warning live |  |
| PASS | No false warning when a 'Not sure' range covers the other vehicle's speed |  |
| PASS | Add another vehicle up to 4 (C and D colors), then remove both | C rgb(15, 118, 110), D rgb(162, 28, 175) |
| PASS | Mini map shows each vehicle as a silhouette | 2 markers: A, B |
| PASS | Sticky action bar doesn't cover the impact grid (phone) | desktop: not sticky |
| PASS | See the recreation goes to review |  |
| PASS | Review reads the shared state (A east 30 mph front right, B 20–30 mph rear, dry) | A Your car · 2019 Toyota RAV4 Heading east on Maple Ave · 30 mph Hit on the front right B Vehicle B · SUV Heading east on Maple Ave · not sure, 20–30 mph Hit on |
| PASS | Opens at the moment of impact with speeds at impact on the labels | A Your car 30 mph / B Vehicle B ~25 mph |
| PASS | Play runs to final rest; play at the end restarts from the beginning | restart readout "1.9 s before impact" |
| PASS | Timeline keyboard: Home, End, I, arrow keys | 2.0 s before impact / Final rest / At impact / 0.1 s after impact |
| PASS | Close and Wide views switch |  |
| PASS | Measure tab: values from the physics; pills on desktop, list on phones | 1 A moved after impact 27–43 ft / 2 B moved after impact 32–43 ft / 3 A to B at final rest, centre to centre 16–21 ft / A, last 2 s before impact 88 ft / B, last 2 s before impact 59–88 ft |
| PASS | View tab: labels and paths toggles, units switch to metric and back |  |
| PASS | Dark theme renders the review without errors |  |
| PASS | 'Looks right: save it' is reachable (phone: fixed in the bottom sheet) |  |
| PASS | Before saving, the time and fingerprint are not faked |  |
| PASS | Preview tabs: PDF, diagram, scene file |  |
| PASS | Save downloads the scene file and the diagram PNG, stamped with the real time | fingerprint ca28 cfce 6919 69c5; createdAt 2026-10-09T20:52:18Z; PNG 1600×1600 |
| PASS | Toast sits clear of the save button and goes away on other screens |  |
| PASS | PDF page matches the state and fits on one US Letter page | 1 page, 726 KB, review values all present |
| PASS | Diagram page carries the disclaimer, fingerprint and time |  |
| PASS | Changing the scene after saving marks the export as out of date |  |
| PASS | Four vehicles with warnings still fit the PDF on one page (auto-fit) | fit level 2, 0px to spare |
| PASS | Opening the saved scene file rebuilds the same scene | Opened the scene saved Oct 9, 2026, 4:52:18 PM EDT. File fingerprint ca28 cfce 6919 69c5. |
| PASS | Nominatim: at most 1 request per second, address text only | 3 requests, gaps 999 ms, 4808 ms |
| PASS | Network: only allowed hosts | localhost, fonts.googleapis.com, fonts.gstatic.com, tile.openstreetmap.org, nominatim.openstreetmap.org, vpic.nhtsa.dot.gov |
| PASS | No console errors |  |

## 390px — 51/51 passed

| | Check | Detail |
|---|---|---|
| PASS | Claim address is prefilled but not sent until the claimant taps Search | This is the address on your claim. Tap Search to find it on the map. |
| PASS | No-results state for the made-up claim address offers the pin drop |  |
| PASS | Search box shows the whole field width (no cut-off) | 358px |
| PASS | Live Nominatim search: loading state, then results with attribution | 4 results |
| PASS | Picking a result moves the pin, recenters and fills the coordinates | 40.75701, -73.98597; street filled: "Times Square" |
| PASS | Zoom in and zoom out change the map zoom | zoom 18 → 17 → 18 |
| PASS | Dragging the pin updates the coordinates under the map | 40.75701, -73.98597 → 40.75689, -73.98565; exports will say "near Times Square" |
| PASS | Tapping the map moves the pin | 40.75680, -73.98636 |
| PASS | A search with no matches shows the no-results message (queued at 1 request per second) |  |
| PASS | Place type: parking hides street names (and drops them from captions), road hides the cross street |  |
| PASS | Street names, date and time take input |  |
| PASS | Road condition tiles have a clear selected state | selected ring: rgb(37, 99, 235) 0px 0px 0px 1px inset |
| PASS | Next goes to vehicles and keeps step 1 marked done |  |
| PASS | Your car is prefilled from the claim and editable |  |
| PASS | Year, make and model look up the model list in NHTSA vPIC and fill in the type | SUV from NHTSA vPIC (Multipurpose Passenger Vehicle (MPV)). Weight and size: suv class average. |
| PASS | Picking a type by hand overrides the lookup |  |
| PASS | Direction picker updates the arrow and the caption | arrow 90deg; "Heading east on Maple Ave" |
| PASS | Every action works and changes the caption (straight, turning left/right, backing up, parked) | Turning left, ending up heading east on Maple Ave / Turning right, ending up heading east on Maple Ave / Facing east, backing up on Maple Ave / Parked, facing east on Maple Ave / Heading east on Maple Ave |
| PASS | Arrow keys move the choice inside a radio group (one tab stop per group) | moved to 180°, back with ArrowLeft |
| PASS | Speed stepper changes the speed |  |
| PASS | Impact zones select (A front right) |  |
| PASS | Vehicle B: Not sure + limit stepper + I don't know the limit | 25–35 → 20–30; "We'll show 20–30 mph, around 25 mph, a typical city limit. The picture uses 25 mph." |
| PASS | Validation: same direction, neither hit in the rear, shows a plain warning instead of the picture | Your car (A) and vehicle B were both going east. When two vehicles going the same way collide, one is usually hit in the rear, but neither is marked that way. Check the directions or where each was hit. |
| PASS | Validation: impossible zones (head-on marked as rear) are explained | Your car (A) would have come at vehicle B head-on, from the front, but vehicle B is marked as hit on the rear. Check the direction, what each vehicle was doing, or where it was hit. |
| PASS | Fixing the details clears the warning live |  |
| PASS | No false warning when a 'Not sure' range covers the other vehicle's speed |  |
| PASS | Add another vehicle up to 4 (C and D colors), then remove both | C rgb(15, 118, 110), D rgb(162, 28, 175) |
| PASS | Mini map shows each vehicle as a silhouette | 2 markers: A, B |
| PASS | Sticky action bar doesn't cover the impact grid (phone) |  |
| PASS | See the recreation goes to review |  |
| PASS | Review reads the shared state (A east 30 mph front right, B 20–30 mph rear, dry) | A Your car · 2019 Toyota RAV4 Heading east on Maple Ave · 30 mph Hit on the front right B Vehicle B · SUV Heading east on Maple Ave · not sure, 20–30 mph Hit on |
| PASS | Opens at the moment of impact with speeds at impact on the labels | A Your car 30 mph / B Vehicle B ~25 mph |
| PASS | Play runs to final rest; play at the end restarts from the beginning | restart readout "1.9 s before impact" |
| PASS | Timeline keyboard: Home, End, I, arrow keys | 2.0 s before impact / Final rest / At impact / 0.1 s after impact |
| PASS | Close and Wide views switch |  |
| PASS | Measure tab: values from the physics; pills on desktop, list on phones | 1 A moved after impact 27–43 ft / 2 B moved after impact 32–43 ft / 3 A to B at final rest, centre to centre 16–21 ft / A, last 2 s before impact 88 ft / B, last 2 s before impact 59–88 ft |
| PASS | View tab: labels and paths toggles, units switch to metric and back |  |
| PASS | Dark theme renders the review without errors |  |
| PASS | 'Looks right: save it' is reachable (phone: fixed in the bottom sheet) |  |
| PASS | Before saving, the time and fingerprint are not faked |  |
| PASS | Preview tabs: PDF, diagram, scene file |  |
| PASS | Save downloads the scene file and the diagram PNG, stamped with the real time | fingerprint 3a62 523d c9b0 f596; createdAt 2026-10-09T20:52:38Z; PNG 1600×1600 |
| PASS | Toast sits clear of the save button and goes away on other screens |  |
| PASS | PDF page matches the state and fits on one US Letter page | review values all present |
| PASS | Diagram page carries the disclaimer, fingerprint and time |  |
| PASS | Changing the scene after saving marks the export as out of date |  |
| PASS | Four vehicles with warnings still fit the PDF on one page (auto-fit) | fit level 2, 0px to spare |
| PASS | Opening the saved scene file rebuilds the same scene | Opened the scene saved Oct 9, 2026, 4:52:38 PM EDT. File fingerprint 3a62 523d c9b0 f596. |
| PASS | Nominatim: at most 1 request per second, address text only | 3 requests, gaps 999 ms, 4743 ms |
| PASS | Network: only allowed hosts | localhost, fonts.googleapis.com, fonts.gstatic.com, tile.openstreetmap.org, nominatim.openstreetmap.org, vpic.nhtsa.dot.gov |
| PASS | No console errors |  |
