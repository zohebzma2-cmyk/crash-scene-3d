// Step 2: which vehicles were involved? Up to four. Letters re-pack when one is removed, and each
// card keeps its own state (its key follows the vehicle, not the letter).
import { useEffect, useState } from "react";
import { LIMITS } from "@csd/core";
import { Icon } from "../icons/Icon";
import { usePhone } from "../lib/dom";
import { useServices } from "../services/context";
import { useDoc } from "../state/DocProvider";
import { useFlow } from "../state/Flow";
import { useUi } from "../state/Ui";
import { Tips } from "../tips/Tips";
import { LogoCredit } from "./MakeLogo";
import { MiniMap } from "./MiniMap";
import { VehicleCard, vehicleListReason, type MakesState } from "./VehicleCard";
import { GatePanel } from "./Warnings";

export function VehiclesStep() {
  const { doc, dispatch } = useDoc();
  const { vehicles } = useServices();
  const { showToast } = useUi();
  const flow = useFlow();
  const phone = usePhone();
  const [makes, setMakes] = useState<MakesState>({ status: "loading" });
  const scene = doc.scene;

  useEffect(() => {
    let off = false;
    // Once per session (the service caches it); every card ranks against it. A failure leaves typing working.
    vehicles.makes().then((names) => { if (!off) setMakes({ status: "ok", names }); }, (e: unknown) => { if (!off) setMakes({ status: "error", reason: vehicleListReason(e) }); });
    return () => { off = true; };
  }, [vehicles]);

  const remove = (id: (typeof scene.vehicles)[number]["id"]) => {
    dispatch({ type: "remove-vehicle", id });
    showToast(`Vehicle removed. ${scene.vehicles.length - 1} vehicles now.`);
    window.setTimeout(() => document.getElementById("add-vehicle")?.focus({ preventScroll: true }), 0);
  };
  const add = () => {
    dispatch({ type: "add-vehicle" });
    const id = String.fromCharCode(65 + scene.vehicles.length);
    window.setTimeout(() => {
      const card = document.getElementById(`vehicle-${id}`);
      card?.scrollIntoView?.({ block: "start" });
      card?.querySelector<HTMLInputElement>('input[type="text"]')?.focus({ preventScroll: true });
    }, 0);
  };

  return (
    <section aria-labelledby="h-vehicles">
      <div className="split split-wide">
        <div className="split-head">
          <h1 className="title" id="h-vehicles">Which vehicles were involved?</h1>
          <p className="lede">Best guesses are fine. You can change anything later.</p>
        </div>
        <Tips step="vehicles" />
        <div className="split-side">
          {phone && !doc.located ? (
            <div className="map-compact" data-testid="mini-compact">
              <Icon name="pin" className="icon-lg" />
              <p>Set the place in step 1 to see the vehicles on the map.</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => flow.go("location")}>Set the place</button>
            </div>
          ) : <MiniMap scene={scene} />}
          <p className="hint">Each vehicle is drawn where it came from, pointing the way it was facing.</p>
        </div>
        <div className="split-main">
          <div className="vehicle-list">
            {scene.vehicles.map((v, i) => (
              <VehicleCard key={doc.vehicleKeys[i] ?? v.id} vehicle={v} canRemove={v.id !== "A" && scene.vehicles.length > LIMITS.minVehicles} directionSet={doc.directionSet[i] === true} onRemove={() => remove(v.id)} makes={makes} />
            ))}
          </div>
          <LogoCredit />
          {scene.vehicles.length < LIMITS.maxVehicles ? (
            <button className="btn btn-quiet add-vehicle" type="button" id="add-vehicle" onClick={add}><Icon name="plus" className="icon-sm" /><span>Add another vehicle</span></button>
          ) : null}
          <GatePanel fixes />
          <div className="actions">
            <button type="button" className="btn btn-quiet" onClick={() => flow.go("location")}><Icon name="arrow-left" className="icon-sm" />Back</button>
            <button type="button" className="btn btn-primary" id="to-review" onClick={() => flow.go("review")}>See the recreation <Icon name="arrow-right" className="icon-sm" /></button>
          </div>
        </div>
      </div>
    </section>
  );
}
