import type { Scene } from "@csd/core";
// Static on purpose: this module is only in the 3D view's lazy chunk, so the zone table arrives with three.js and
// the first frame is lit for the pin's local time (never a default sun that then jumps).
import { estimateSun } from "@csd/core/sun";
import { useMemo } from "react";
import type { SceneColors } from "./tokens";
export function environment(scene: Scene) {
  const sun = estimateSun(scene);
  const light = scene.conditions?.lighting;
  const night = light === "dark-lit" || light === "dark-unlit" || (!light && sun?.lighting === "dark");
  const dusk = light === "dusk-dawn" || (!light && sun?.lighting === "dusk-dawn");
  const wet = scene.conditions?.weather === "rain";
  const snow = scene.conditions?.weather === "snow";
  const fog = scene.conditions?.weather === "fog";
  const elevation = (night ? -10 : dusk ? 3 : Math.max(10, sun?.elevationDeg ?? 50)) * Math.PI / 180;
  const azimuth = (sun?.azimuthDeg ?? 135) * Math.PI / 180;
  return { night, dusk, wet, snow, fog, lit: light === "dark-lit", sunPosition: [Math.sin(azimuth) * Math.cos(elevation) * 150, Math.max(5, Math.sin(elevation) * 150), -Math.cos(azimuth) * Math.cos(elevation) * 150] as [number, number, number] };
}
export function Environment({ scene, colors }: { scene: Scene; colors: SceneColors }) {
  const e = useMemo(() => environment(scene), [scene]);
  const sky = e.night ? colors["--color-scene-tire"] : e.dusk ? colors["--color-scene-ground"] : colors["--color-scene-sky"];
  return <>
    <color attach="background" args={[sky]} />
    {e.fog ? <fog attach="fog" args={[colors["--color-scene-ground"], 15, 180]} /> : null}
    {/* A schematic fill keeps roads readable at night; it does not imply mapped lamps. */}
    <hemisphereLight args={[colors["--color-scene-sky"], colors["--color-scene-lot"], e.night ? 0.65 : e.dusk ? 0.8 : 1]} />
    {e.night ? <ambientLight color={colors["--color-scene-sky"]} intensity={0.3} /> : null}
    <directionalLight color={colors["--color-scene-sun"]} position={e.sunPosition} intensity={e.night ? 0.2 : e.fog ? 0.5 : e.dusk ? 0.75 : 1.6} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-120} shadow-camera-right={120} shadow-camera-top={120} shadow-camera-bottom={-120} />
  </>;
}
