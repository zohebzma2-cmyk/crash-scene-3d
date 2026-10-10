# InsurifyAI brand files

The official InsurifyAI logo, included only so this tool can show the real mark in the app header, the favicon, the PDF and the PNG exports.

| File | What it is |
|---|---|
| `insurifyai.svg` | Official vector, **unchanged**: the shield mark with the arrow breaking through it, as one path in a `translate(64 64) scale(0.75)` group on a 512 x 512 viewBox, with the white background rectangle that BIMI requires. |
| `logo-full.png` | Official lockup, 1024 x 559, opaque white background: the mark, then "Insurify" in near-black and "AI" in the logo blue. Reference for the wordmark proportions. |
| `logo-mark.png` | Official mark, 256 x 256, transparent. Source for the favicon PNGs. |
| `insurifyai-mark.svg` | **Derived** by `scripts/build-brand.mjs`: the same group transform, path data and fill as `insurifyai.svg`, minus the white background rectangle, with the viewBox cropped tightly to the path. A test checks that the path `d` is byte-identical and the fill is `#2369D7`. |

## Source

- <https://insurifyai.app/bimi/insurifyai.svg>
- <https://insurifyai.app/logo-full.png>
- <https://insurifyai.app/logo-mark.png>

Downloaded 2026-10-09 from the public InsurifyAI site.

## Rules

- Never redraw or recolor the mark. The logo blue is `#2369D7`, in `--color-logo` in `design/tokens.css`. It is the same in light and dark mode and is not the UI brand blue (`--color-brand`).
- The wordmark is live text in Plus Jakarta Sans, matched to `logo-full.png` (DESIGN.md section 13).
- Regenerate the derived mark and the favicons with `node scripts/build-brand.mjs`.

## Trademark

InsurifyAI, the InsurifyAI name and the InsurifyAI logo are trademarks of InsurifyAI. They are not covered by this repository's code license, and you may not use them without permission. The logo files in this folder are included only so this tool can show the official mark.
