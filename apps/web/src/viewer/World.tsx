// The static world: ground, parking lots, road ribbons, lane paint, stalls, buildings. Everything that
// lies on the ground is draped on the ground MESH (see scene-geometry) and drawn as a few merged meshes.
// Colors come from tokens only.
import { useEffect, useMemo } from "react";
import { DoubleSide } from "three";
import { buildRoadArt, type RoadNetwork, type Vec2 } from "@csd/core";
import { LAYER, buildingGeometry, groundSurface, lotsGeometry, paintGeometry, ribbonsGeometry } from "./scene-geometry";
import { StreetNames } from "./StreetNames";
import type { SceneColors } from "./tokens";

/** `focus` is where the crash is and `avoid` the points of the vehicles' paths: street names go near the focus, but not on top of it or of the paths. */
export function World({ roads, colors, focus, avoid }: { roads: RoadNetwork | null; colors: SceneColors; focus: Vec2; avoid: readonly Vec2[] }) {
  const terrain = roads?.terrain ?? null;
  const size = roads ? roads.radiusM * 2.4 : 400;
  const ground = useMemo(() => groundSurface(terrain, size), [terrain, size]);
  const art = useMemo(() => (roads ? buildRoadArt(roads) : null), [roads]);
  const roadGeo = useMemo(() => (art ? ribbonsGeometry(art.ribbons, ground) : null), [art, ground]);
  const lotGeo = useMemo(() => (roads && roads.parking.length ? lotsGeometry(roads.parking, ground) : null), [roads, ground]);
  const paintGeo = useMemo(() => (art ? paintGeometry(art.paint, ground) : null), [art, ground]);
  const buildings = useMemo(() => (roads?.buildings ?? []).map((b) => ({ id: b.id, ...buildingGeometry(b, terrain) })), [roads, terrain]);
  // A lot is paler than the grass only by a little in the tokens; mixing in some road color makes it read as paving.
  const lotColor = useMemo(() => colors["--color-scene-lot"].clone().lerp(colors["--color-scene-road"], 0.4), [colors]);
  useEffect(() => () => ground.geometry.dispose(), [ground]);
  useEffect(() => () => roadGeo?.dispose(), [roadGeo]);
  useEffect(() => () => lotGeo?.dispose(), [lotGeo]);
  useEffect(() => () => paintGeo?.dispose(), [paintGeo]);
  useEffect(() => () => buildings.forEach((b) => b.geometry.dispose()), [buildings]);
  return (
    <group>
      <mesh geometry={ground.geometry} renderOrder={LAYER.ground} receiveShadow><meshStandardMaterial color={colors["--color-scene-grass"]} roughness={1} depthTest={false} depthWrite={false} /></mesh>
      {lotGeo && (
        <mesh geometry={lotGeo} renderOrder={LAYER.lot} receiveShadow>
          <meshStandardMaterial color={lotColor} roughness={1} side={DoubleSide} depthTest={false} depthWrite={false} />
        </mesh>
      )}
      {roadGeo && (
        <mesh geometry={roadGeo} renderOrder={LAYER.road} receiveShadow>
          <meshStandardMaterial color={colors["--color-scene-road"]} roughness={0.95} side={DoubleSide} depthTest={false} depthWrite={false} />
        </mesh>
      )}
      {paintGeo && (
        <mesh geometry={paintGeo} renderOrder={LAYER.paint} receiveShadow>
          <meshStandardMaterial color={colors["--color-scene-lane"]} roughness={0.9} side={DoubleSide} depthTest={false} depthWrite={false} />
        </mesh>
      )}
      <StreetNames art={art} ground={ground} focus={focus} avoid={avoid} colors={colors} />
      {buildings.map((b) => (
        <mesh key={b.id} geometry={b.geometry} position={[0, b.baseM, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={colors["--color-surface-3"]} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}
