// App shell: header with the claim chip, the disclaimer bar, the stepper, the toast and the
// "About this illustration" dialog. Light and dark follow the OS unless the toggle is used.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { DISCLAIMER_LONG, DISCLAIMER_SHORT, vehicleName } from "@csd/core";
import { Icon } from "../icons/Icon";
import { Brand } from "./Brand";
import { STEPS, stepIndex, useFlow, type StepKey } from "../state/Flow";
import { useServices } from "../services/context";
import { useScene } from "../state/DocProvider";
import { useUi } from "../state/Ui";
import { ShowTipsButton } from "../tips/Tips";

const LEAD = "Illustration only.";

function prefersDark(): boolean {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return true;
  if (root.classList.contains("light")) return false;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function Header({ onClose }: { onClose?: () => void }) {
  const scene = useScene();
  const flow = useFlow();
  const { mode } = useServices();
  const [dark, setDark] = useState(prefersDark);
  const toggle = () => {
    const root = document.documentElement;
    root.classList.toggle("dark", !dark);
    root.classList.toggle("light", dark);
    setDark(!dark);
  };
  const vehicle = vehicleName(scene.claim.vehicle);
  return (
    <header className="app-header">
      <Brand href="#location" onClick={(e) => { e.preventDefault(); flow.go("location"); }} />
      <span className="claim-chip" data-testid="claim-chip">
        <span className="claim-no"><span className="claim-word">Claim </span>{scene.claim.number}</span>
        <span className="long"> · <span id="claim-vehicle">{vehicle ?? "Vehicle not given"}</span></span>
      </span>
      {mode === "fixtures" ? <span className="mode-chip" title="Fixtures mode: examples only, nothing leaves the browser">Example data</span> : null}
      <span className="header-spacer" />
      <ShowTipsButton />
      <button className="icon-btn" type="button" aria-label={dark ? "Switch to the light theme" : "Switch to the dark theme"} onClick={toggle}>
        <Icon name={dark ? "sun" : "moon"} />
      </button>
      <button className="icon-btn" type="button" aria-label="Close and go back to the claim" onClick={onClose ?? (() => flow.go("location"))}>
        <Icon name="close" />
      </button>
    </header>
  );
}

export function DisclaimerBar({ onLearnMore }: { onLearnMore: () => void }) {
  return (
    // A labeled landmark (complementary), so the disclaimer isn't content outside every landmark (axe "region").
    <aside className="disclaimer-bar" aria-label="Disclaimer">
      <Icon name="info" className="icon-sm" />
      <span><strong>{LEAD}</strong><span className="long">{DISCLAIMER_SHORT.slice(LEAD.length)}</span></span>
      {/* Safari doesn't focus a clicked button, so the dialog would hand focus back to <body> on close: focus it first. */}
      <button type="button" className="link-btn" onClick={(e) => { e.currentTarget.focus(); onLearnMore(); }}>Learn more</button>
    </aside>
  );
}

export function Stepper() {
  const flow = useFlow();
  const current = stepIndex(flow.step);
  const click = (key: StepKey) => (e: MouseEvent) => { e.preventDefault(); flow.go(key); };
  return (
    <nav className="stepper" aria-label="Progress">
      <ol>
        {STEPS.map((s, i) => {
          const state = i < current ? "done" : i === current ? "current" : "todo";
          return (
            <li key={s.key} data-state={state}>
              <a href={`#${s.key}`} aria-current={i === current ? "step" : undefined} onClick={click(s.key)}>
                <span className="step-dot">
                  {state === "done" ? <Icon name="check" className="icon-xs" /> : <span className="n">{i + 1}</span>}
                </span>
                {s.name}
              </a>
            </li>
          );
        })}
      </ol>
      <p className="stepper-compact" aria-hidden="true">
        <span>Step {current + 1} of {STEPS.length} · {STEPS[current]?.name}</span>
        <span className="bar"><span style={{ width: `${((current + 1) / STEPS.length) * 100}%` }} /></span>
      </p>
    </nav>
  );
}

export function Toast() {
  const { toast, hideToast } = useUi();
  return (
    <div className="toast" role="status" aria-live="polite" hidden={!toast}>
      {toast ? (
        <>
          <Icon name="check" />
          <span>{toast}</span>
          <button className="icon-btn icon-btn-sm" type="button" aria-label="Dismiss" onClick={hideToast}><Icon name="close" className="icon-sm" /></button>
        </>
      ) : null}
    </div>
  );
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    } else if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby="about-title" onClose={onClose} onCancel={onClose}>
      <div className="dialog-body">
        <h2 id="about-title">About this illustration</h2>
        <p>{DISCLAIMER_LONG}</p>
        <div className="actions"><button type="button" className="btn btn-primary" onClick={onClose}>Got it</button></div>
      </div>
    </dialog>
  );
}
