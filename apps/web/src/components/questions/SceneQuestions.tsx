import { useMemo, useState } from "react";
import { ANSWER_LABELS, LIGHTING, WEATHER, VISIBILITY } from "@csd/core";
import { useSunEstimator } from "../../lib/lazy-core";
import { useDoc } from "../../state/DocProvider";
import { Icon } from "../../icons/Icon";
import { QuestionChoice } from "./QuestionChoice";

export function SceneQuestions() {
  const { doc, dispatch } = useDoc();
  const c = doc.scene.conditions ?? {};
  const { location, occurred } = doc.scene;
  // The estimate (and its zone table) loads the first time the panel opens: it is only shown inside it.
  const [opened, setOpened] = useState(false);
  const estimateSun = useSunEstimator(opened);
  const sun = useMemo(() => doc.located && estimateSun ? estimateSun({ location, occurred }) : null, [doc.located, estimateSun, location, occurred]);
  const update = (patch: Partial<typeof c>) => dispatch({ type: "conditions", conditions: { ...c, ...patch } });
  const estimate = sun ? `${sun.lighting === "dark" ? "Dark — street lighting unknown" : ANSWER_LABELS[sun.lighting]} (estimated)` : undefined;
  return <details className="group optional-questions" onToggle={(e) => { if (e.currentTarget.open) setOpened(true); }}><summary>Light, weather and visibility (optional)</summary>
    <p className="hint">Skip any question with “Not sure”. Answers are what you remember.</p>
    <QuestionChoice label="What was the light like?" icon="light-daylight" value={c.lighting} options={LIGHTING} automatic={estimate} onChange={(v) => update({ lighting: v === "auto" ? undefined : v as typeof c.lighting })} />
    {!estimateSun ? null : sun ? <p className="hint">Estimated at the pin in {sun.zone}. {sun.sunrise && sun.sunset ? `Sunrise about ${sun.sunrise}; sunset about ${sun.sunset}.` : "The sun may stay above or below the horizon on this date."} Choose an answer to confirm what you remember.</p> : <p className="hint">Set the pin, date and time for a daylight estimate. You can also choose an answer yourself.</p>}
    <QuestionChoice label="What was the weather?" icon="weather-rain" value={c.weather} options={WEATHER} onChange={(v) => update({ weather: v as typeof c.weather })} />
    <fieldset className="group"><legend className="field-sub">Did anything make it hard to see?</legend>
      {VISIBILITY.map((v) => <label className="check-row" key={v}><input type="checkbox" checked={c.visibility?.includes(v) ?? v === "not-sure"} onChange={(e) => {
        const old = c.visibility ?? [];
        const next = e.target.checked ? v === "none" || v === "not-sure" ? [v] : [...old.filter((x) => x !== "none" && x !== "not-sure"), v] : old.filter((x) => x !== v);
        update({ visibility: next.length ? next : ["not-sure"] });
      }} /><Icon name={v === "sun-glare" ? "visibility-glare" : v === "parked-cars" ? "visibility-parked" : v === "hedges" ? "visibility-hedges" : "info"} className="icon-sm" />{ANSWER_LABELS[v]}</label>)}
    </fieldset>
  </details>;
}
