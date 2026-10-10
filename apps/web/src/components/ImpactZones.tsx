// "Where was it hit?" Eight zones around the vehicle's own silhouette (a 3 x 3 grid; the middle is the car).
import { PRESETS, ZONES, ZONE_WORDS, type SceneVehicle, type Zone } from "@csd/core";
import { Radio, RadioGroup } from "../a11y/roving";
import { Icon } from "../icons/Icon";
import { ucFirst } from "../lib/text";

export const zoneLabel = (z: Zone): string => ucFirst(ZONE_WORDS[z].replace(" side", ""));

export function ImpactZones({ vehicle, onChange }: { vehicle: SceneVehicle; onChange: (z: Zone) => void }) {
  const legendId = `zones-legend-${vehicle.id}`;
  return (
    <fieldset className="group" data-fix-target>
      <legend className="group-label" id={legendId}>Where was it hit?</legend>
      <RadioGroup className="zones" aria-labelledby={legendId} values={ZONES} value={vehicle.zone} onChange={onChange}>
        <span className="zones-body" aria-hidden="true"><Icon name={PRESETS[vehicle.type].icon} /></span>
        {ZONES.map((z) => <Radio key={z} value={z} data-z={z} aria-label={`Hit on the ${ZONE_WORDS[z]}`}>{zoneLabel(z)}</Radio>)}
      </RadioGroup>
    </fieldset>
  );
}
