// The token reader: the only way scene code gets colors. Resolves CSS custom
// properties (including light-dark()) to concrete colors through a probe
// element, so three.js materials follow design/tokens.css and the theme.
import { Color } from "three";

export const SCENE_TOKENS = [
  "--color-scene-ground", "--color-scene-grass", "--color-scene-road", "--color-scene-lane",
  "--color-scene-path", "--color-scene-measure", "--color-scene-lot",
  "--color-scene-label", "--color-surface", "--color-surface-2", "--color-surface-3",
  "--color-border-strong", "--color-text", "--color-text-secondary",
  "--color-scene-glass", "--color-scene-tire", "--color-scene-headlight", "--color-scene-taillight",
  "--color-scene-sky", "--color-scene-sun", "--color-scene-debris-glass", "--color-scene-debris-plastic", "--color-scene-skid", "--color-scene-impact", "--color-focus-ring", "--color-text-on-brand",
  "--color-vehicle-a", "--color-vehicle-b", "--color-vehicle-c", "--color-vehicle-d",
] as const;
export type SceneToken = (typeof SCENE_TOKENS)[number];
export type SceneColors = Readonly<Record<SceneToken, Color>> & { readonly css: Readonly<Record<SceneToken, string>> };

/** Read every scene token as resolved in `root`'s color scheme. */
export function readSceneColors(root: HTMLElement = document.documentElement): SceneColors {
  const probe = document.createElement("span");
  probe.style.display = "none";
  root.append(probe);
  const colors = {} as Record<SceneToken, Color>;
  const css = {} as Record<SceneToken, string>;
  for (const token of SCENE_TOKENS) {
    probe.style.color = `var(${token})`;
    const resolved = getComputedStyle(probe).color;
    css[token] = resolved;
    colors[token] = parseCssColor(resolved);
  }
  probe.remove();
  return Object.assign(colors, { css });
}

/** Parse "rgb(r, g, b)", "rgb(r g b / a)" or "color(srgb r g b)" into a three Color (sRGB). */
export function parseCssColor(value: string): Color {
  const c = new Color();
  const rgb = value.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (rgb) return c.setRGB(Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, "srgb");
  const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (srgb) return c.setRGB(Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), "srgb");
  return c.setRGB(0.5, 0.5, 0.5, "srgb");     // unreadable token: neutral grey, never a hard-coded brand color
}

export function vehicleToken(id: string): SceneToken {
  return (`--color-vehicle-${id.toLowerCase()}`) as SceneToken;
}
