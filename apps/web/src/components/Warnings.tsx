// Plain-language warnings: details that are missing, can't be used as typed, or don't fit together. Text only.
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../icons/Icon";
import { GateFixes } from "../review/RefusalFixes";
import { useDoc } from "../state/DocProvider";
import { useFlow, type GateProblem, type GateProblemKind } from "../state/Flow";
import { useRoads } from "../state/Roads";

export const MISSING_TITLE = "Some details are missing";
export const UNUSABLE_TITLE = "Some details need changing";
export const CONFLICT_TITLE = "Some details don't fit together";

/** Each kind of problem under its own title, missing details first (a missing detail is never called a contradiction). */
const GROUPS: ReadonlyArray<readonly [GateProblemKind, string]> = [["missing", MISSING_TITLE], ["unusable", UNUSABLE_TITLE], ["conflict", CONFLICT_TITLE]];

export function WarningList({ problems, title = CONFLICT_TITLE }: { problems: readonly GateProblem[]; title?: string }) {
  return (
    <>
      <p className="warnings-title"><Icon name="warning" />{title}</p>
      <ul>{problems.map((p, i) => <li key={`${i}-${p.text}`}>{p.text}</li>)}</ul>
    </>
  );
}

/** The gate's problems, grouped by kind, each group under its own title. */
export function WarningGroups({ problems }: { problems: readonly GateProblem[] }) {
  return (
    <>
      {GROUPS.map(([kind, title]) => {
        const list = problems.filter((p) => p.kind === kind);
        return list.length > 0 ? <WarningList key={kind} problems={list} title={title} /> : null;
      })}
    </>
  );
}

/**
 * Shown on Location and Vehicles once the claimant has tried to continue; stays live while details change. With `fixes`
 * (the Vehicles step), details that don't fit together also get the one-tap fixes the Review refusal offers.
 */
export function GatePanel({ fixes = false }: { fixes?: boolean }) {
  const flow = useFlow();
  const shown = flow.armed && flow.problems.length > 0;
  return shown ? <GatePanelBody fixes={fixes} /> : null;
}

function GatePanelBody({ fixes }: { fixes: boolean }) {
  const flow = useFlow();
  const { doc } = useDoc();
  const roads = useRoads();
  const fixRef = useRef<HTMLButtonElement>(null);
  // When the warnings first appear, bring them into view and put focus on "Fix the details".
  useEffect(() => {
    fixRef.current?.scrollIntoView?.({ block: "center" });
    fixRef.current?.focus({ preventScroll: true });
  }, []);
  // One-tap fixes only for details that don't fit together (a direction off the roads among them, which blocks): a missing or
  // unusable detail is the claimant's to give.
  const offerFixes = fixes && flow.problems.some((p) => p.kind === "conflict") && !flow.problems.some((p) => p.blocking && p.kind !== "conflict");
  return (
    <div className="warnings" data-testid="gate-panel">
      <div className="warnings-body" role="alert">
        <WarningGroups problems={flow.problems} />
      </div>
      {offerFixes ? <GateFixes scene={doc.scene} roads={roads.net} ready={roads.status !== "loading"} /> : null}
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
        <p className={`warnings-first${open || !many ? "" : " is-clamped"}`}>{open ? CONFLICT_TITLE : first.text}</p>
        <div className="warnings-actions">
          {many ? <button type="button" className="link-btn" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>{open ? "Show fewer" : `Show all (${problems.length})`}</button> : null}
          <button type="button" className="link-btn" onClick={onEdit}>Edit the details</button>
        </div>
      </div>
      {open ? <ul id={listId}>{problems.map((p, i) => <li key={`${i}-${p.text}`}>{p.text}</li>)}</ul> : null}
    </div>
  );
}
