// Plain-language list of details that don't fit together. Text only.
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icons/Icon";
import { useFlow, type GateProblem } from "../state/Flow";

export function WarningList({ problems, title = "Some details don't fit together" }: { problems: readonly GateProblem[]; title?: string }) {
  return (
    <>
      <p className="warnings-title"><Icon name="warning" />{title}</p>
      <ul>{problems.map((p, i) => <li key={`${i}-${p.text}`}>{p.text}</li>)}</ul>
    </>
  );
}

/** Shown on Location and Vehicles once the claimant has tried to continue; stays live while details change. */
export function GatePanel() {
  const flow = useFlow();
  const shown = flow.armed && flow.problems.length > 0;
  return shown ? <GatePanelBody /> : null;
}

function GatePanelBody() {
  const flow = useFlow();
  const fixRef = useRef<HTMLButtonElement>(null);
  // When the warnings first appear, bring them into view and put focus on "Fix the details".
  useEffect(() => {
    fixRef.current?.scrollIntoView?.({ block: "center" });
    fixRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="warnings" role="alert" data-testid="gate-panel">
      <WarningList problems={flow.problems} />
      <div className="warnings-actions">
        <button ref={fixRef} type="button" className="btn btn-secondary" onClick={flow.fix}>Fix the details</button>
        {flow.blocking ? null : <button type="button" className="btn btn-quiet" onClick={flow.acceptAnyway}>See it anyway</button>}
      </div>
    </div>
  );
}

/**
 * The same warnings, compact, for the review where the picture needs the room: the first one on a line,
 * and "Show all (N)" opens the rest in place.
 */
export function CompactWarnings({ problems, onEdit }: { problems: readonly GateProblem[]; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const [first] = problems;
  if (!first) return null;
  const many = problems.length > 1;
  return (
    <div className="warnings warnings-compact" data-testid="review-warnings">
      <div className="warnings-row">
        <Icon name="warning" />
        <p className={`warnings-first${open || !many ? "" : " is-clamped"}`}>{open ? "Some details don't fit together" : first.text}</p>
        <div className="warnings-actions">
          {many ? <button type="button" className="link-btn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>{open ? "Show fewer" : `Show all (${problems.length})`}</button> : null}
          <button type="button" className="link-btn" onClick={onEdit}>Edit the details</button>
        </div>
      </div>
      {open ? <ul id={listId}>{problems.map((p, i) => <li key={`${i}-${p.text}`}>{p.text}</li>)}</ul> : null}
    </div>
  );
}
