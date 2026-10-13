import { useId } from "react";
import { ANSWER_LABELS } from "@csd/core";
import { Icon } from "../../icons/Icon";

export function QuestionChoice({ label, icon, value, options, onChange, automatic }: { label: string; icon: string; value: string | undefined; options: readonly string[]; onChange: (value: string) => void; automatic?: string }) {
  const id = useId();
  return <div className="field"><label className="field-sub" htmlFor={id}><Icon name={icon} className="icon-sm" /> {label}</label>
    <select className="input" id={id} value={value ?? (automatic ? "auto" : "not-sure")} onChange={(e) => onChange(e.target.value)}>
      {automatic ? <option value="auto">{automatic}</option> : null}
      {options.map((x) => <option key={x} value={x}>{x === "none" ? "No control" : ANSWER_LABELS[x] ?? x}</option>)}
    </select></div>;
}
