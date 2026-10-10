# 0006. One ZIP download, with a second tap as fallback

Status: Accepted, 2026-10-09 (Zoheb, "Downloads fixed").

## Context
Step 4 let the claimant save a PDF, a diagram PNG and a scene file. The first version saved the scene file and the PNG and opened the print window for the PDF, and the e2e suite expected several separate downloads. Several downloads at once are easy to lose or get blocked, especially on phones.

## Options considered
- Several separate downloads.
- One download: a lone file when only one is chosen, or one stored ZIP of everything.
- Building the ZIP can outlast the browser's short window after a tap, so a plain download may not be allowed to start.

## Decision
Save delivers ONE file: a lone file, or one stored ZIP (`crash-scene-<claim>.zip`) holding the PDF, the PNGs and the JSON. If building outlasts the tap window (about 3 s), the button becomes "Download your files" and a second tap delivers the same ZIP. Save waits up to 10 s for the 3D view before taking stills, and pictures are always requested so a missing still is reported. Any save with a PDF or PNG also includes the scene JSON, so the fingerprint printed on them can be checked.

## Consequences
- One export run uses one timestamp and one fingerprint for every file in the ZIP.
- `e2e/download.spec.ts` catches the real download, unzips it and checks every file (PDF pages, embedded fonts, disclaimer, fingerprint equal to the SHA-256 of the downloaded JSON, PNG sizes). A slow-save test (20x CPU) checks the second tap still delivers one ZIP (99c43d2).
- The first-visit tip for step 4 says "Save to my device gives you all of it as one ZIP."

Sources: 86918af, 5c4487e, 99c43d2, 20021c9, PROGRESS.md "Downloads fixed" and "Told Zoheb", DESIGN.md sections 5 and 19, README e2e section.
