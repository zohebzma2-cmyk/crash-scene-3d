// App shell: header with the claim chip, the disclaimer bar, the stepper, the toast and the
// "About this illustration" dialog. Light and dark follow the OS unless the toggle is used.
import { useRef, useState, type MouseEvent } from "react";
import { DISCLAIMER_LONG, DISCLAIMER_SHORT, vehicleName, type SceneVehicle } from "@csd/core";
import { Icon } from "../icons/Icon";
import { Brand } from "./Brand";
import { STEPS, stepIndex, useFlow, type StepKey } from "../state/Flow";
import { useServices } from "../services/context";
import { useDoc } from "../state/DocProvider";
import { useUi } from "../state/Ui";
import { ShowTipsButton } from "../tips/Tips";
import { ModalDialog } from "./Modal";

const LEAD = "Illustration only.";

function prefersDark(): boolean {
  const root = document.documentElement;
  if (root.classList.contains("dark")) return true;
  if (root.classList.contains("light")) return false;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** The header's vehicle: vehicle A as entered, live; "Your car" until A has a make or model (DESIGN.md section 4, AppShell). */
export function headerVehicle(a: Pick<SceneVehicle, "year" | "make" | "model"> | undefined): string {
  return a && (a.make.trim() || a.model.trim()) ? (vehicleName(a) ?? YOUR_CAR) : YOUR_CAR;
}
const YOUR_CAR = "Your car";

export function Header({ onClose }: { onClose?: () => void }) {
  const { doc } = useDoc();
  const scene = doc.scene;
  const flow = useFlow();
  const { mode } = useServices();
  const [dark, setDark] = useState(prefersDark);
  const toggle = () => {
    const root = document.documentElement;
    root.classList.toggle("dark", !dark);
    root.classList.toggle("light", dark);
    setDark(!dark);
  };
  const vehicle = headerVehicle(scene.vehicles[0]);
  const number = scene.claim.number.trim();
  return (
    <header className="app-header">
      <Brand href="#location" onClick={(e) => { e.preventDefault(); flow.go("location"); }} />
      <span className="claim-chip" data-testid="claim-chip">
        {/* No claim number (a new visitor): no "Claim" part at all, and the vehicle shows on phones too. */}
        {number ? <><span className="claim-no"><span className="claim-word">Claim </span>{number}</span><span className="long"> · </span></> : null}
        <span className={number ? "long" : undefined}><span id="claim-vehicle">{vehicle}</span></span>
      </span>
      {mode === "fixtures" || doc.example ? <span className="mode-chip" title={doc.example ? "A made-up example: its claim and vehicles are not real" : "Fixtures mode: examples only, nothing leaves the browser"}>Example data</span> : null}
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

export const ABOUT_TOOL_LABEL = "About this tool";

export function DisclaimerBar({ onLearnMore, onAbout }: { onLearnMore: () => void; onAbout?: () => void }) {
  return (
    // A labeled landmark (complementary), so the disclaimer isn't content outside every landmark (axe "region").
    <aside className="disclaimer-bar" aria-label="Disclaimer">
      <Icon name="info" className="icon-sm" />
      <span><strong>{LEAD}</strong><span className="long">{DISCLAIMER_SHORT.slice(LEAD.length)}</span></span>
      {/* Safari doesn't focus a clicked button, so the dialog would hand focus back to <body> on close: focus it first. */}
      <button type="button" className="link-btn" onClick={(e) => { e.currentTarget.focus(); onLearnMore(); }}>Learn more</button>
      {/* Reopens the first-visit welcome (DESIGN.md section 19). Not on phones: there the bar sits over the 3D view's labels
          as the page scrolls, and a second link would crowd them; phones reach it from Learn more. */}
      {onAbout ? <button type="button" className="link-btn about-tool-link" onClick={(e) => { e.currentTarget.focus(); onAbout(); }}>{ABOUT_TOOL_LABEL}</button> : null}
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

/** `onAboutTool`: an "About this tool" button that swaps this dialog for the welcome (the way there on phones, DESIGN.md section 19). */
export function AboutDialog({ open, onClose, onAboutTool }: { open: boolean; onClose: () => void; onAboutTool?: () => void }) {
  const gotIt = useRef<HTMLButtonElement>(null);
  if (!open) return null;
  return (
    <ModalDialog labelledBy="about-title" onDismiss={onClose} initialFocus={gotIt}>
      <div className="dialog-body">
        <h2 id="about-title">About this illustration</h2>
        <p>{DISCLAIMER_LONG}</p>
        <div className="actions">
          {onAboutTool ? <button type="button" className="btn btn-quiet" onClick={onAboutTool}>{ABOUT_TOOL_LABEL}</button> : null}
          <button ref={gotIt} type="button" className="btn btn-primary" onClick={onClose}>Got it</button>
        </div>
      </div>
    </ModalDialog>
  );
}
