import { useId } from "react";
import { CONTROL, YES_NO, taggedLaneCount, type SceneVehicle } from "@csd/core";
import { useDoc } from "../../state/DocProvider";
import { useRoads } from "../../state/Roads";
import { Icon } from "../../icons/Icon";
import { QuestionChoice } from "./QuestionChoice";

export function VehicleQuestions({ vehicle: v }: { vehicle: SceneVehicle }) {
  const { doc, dispatch } = useDoc();
  const roads = useRoads();
  const count = taggedLaneCount(roads.net, v, doc.scene.location);
  const id = useId();
  const account = v.account ?? {};
  const patch = (p: Partial<SceneVehicle>) => dispatch({ type: "vehicle", id: v.id, patch: p });
  const update = (key: keyof typeof account, value: string) => patch({ account: { ...account, [key]: value } });
  const lane = account.lane === "entered" ? v.travel.lane : null;
  return <details className="group optional-questions"><summary>More about vehicle {v.id} (optional)</summary>
    <p className="hint">What do you remember? “Not sure” skips a question.</p>
    <QuestionChoice label="What did the traffic control show?" icon="feature-signal" value={account.control} options={CONTROL} onChange={(value) => update("control", value)} />
    <div className="field"><label className="field-sub" htmlFor={id}><Icon name="feature-lanes" className="icon-sm" /> Which lane, from the right?</label>
      <select className="input" id={id} value={lane ?? "not-sure"} onChange={(e) => dispatch({ type: "lane-answer", id: v.id, lane: e.target.value === "not-sure" ? null : Number(e.target.value) })}>
        <option value="not-sure">Not sure</option>
        {count !== null ? Array.from({ length: count }, (_, i) => <option value={i} key={i}>Lane {i + 1}{i === 0 ? " (rightmost)" : ""}</option>) : null}
        {lane !== null && (count === null || lane >= count) ? <option value={lane}>Lane {lane + 1} (previous answer; count unconfirmed)</option> : null}
      </select>
      <p className="hint">{count === null ? "OpenStreetMap has no confirmed lane count for this direction at the pin." : `${count} lanes in this direction at the pin, from OpenStreetMap.`}</p>
    </div>
    <QuestionChoice label="Was the turn signal on?" icon="signal-on" value={account.signaled} options={YES_NO} onChange={(value) => update("signaled", value)} />
    <QuestionChoice label="Was it braking?" icon="braking" value={account.braking ?? (v.braking ? "yes" : undefined)} options={YES_NO} onChange={(value) => patch({ braking: value === "yes", account: { ...account, braking: value as "yes" | "no" | "not-sure" } })} />
    <QuestionChoice label="Was it swerving?" icon="swerving" value={account.swerving} options={YES_NO} onChange={(value) => update("swerving", value)} />
    <QuestionChoice label="Did the airbags deploy?" icon="airbag" value={account.airbags} options={YES_NO} onChange={(value) => update("airbags", value)} />
    <QuestionChoice label="Was it towed?" icon="tow-truck" value={account.towed} options={YES_NO} onChange={(value) => update("towed", value)} />
    <p className="hint">These are your recollections. Braking affects the picture only while moving. Swerving is a note.</p>
  </details>;
}
