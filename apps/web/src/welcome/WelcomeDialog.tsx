// The first-visit welcome (DESIGN.md section 19, "Welcome on a first visit"): what the tool does, the short
// disclaimer, the four steps, and two buttons. Text only. Built on the shared dialog primitive (components/Modal).
import { useRef } from "react";
import { DISCLAIMER_SHORT } from "@csd/core";
import { ModalDialog } from "../components/Modal";
import { STEPS } from "../state/Flow";

export const WELCOME_TITLE = "See what happened, in 3D";
export const WELCOME_TEXT = "Enter the place, the vehicles, which way each one was going and where each was hit. We rebuild the crash in 3D on the real road layout, then you can save a PDF, pictures and the scene file, all made in your browser.";
export const WELCOME_HOW = "How it works";
export const TRY_EXAMPLE_LABEL = "Try an example";
export const DISMISS_LABEL = "Dismiss";
/** The example "Try an example" opens: the same as /?example=t-bone-intersection#review. */
export const WELCOME_EXAMPLE = "t-bone-intersection";

export const START_OWN_LABEL = "Start my own";
export const NEW_TAB_NOTE = "The example opens in a new tab, so what you entered here stays as it is.";

/**
 * `newTabHref`: reopened after details were entered, "Try an example" is a link that opens the example in a new tab
 * (and says so), so nothing entered here is replaced.
 */
/** `onStartOwn`: reopened over an example (or work that began as one): a "Start my own" button for a new, empty scene. */
export function WelcomeDialog({ onTryExample, onDismiss, newTabHref, onStartOwn }: { onTryExample: () => void; onDismiss: () => void; newTabHref?: string; onStartOwn?: () => void }) {
  const primary = useRef<HTMLButtonElement & HTMLAnchorElement>(null);
  return (
    <ModalDialog labelledBy="welcome-title" onDismiss={onDismiss} initialFocus={primary} className="welcome-dialog" testId="welcome">
      <div className="dialog-body welcome-body">
        <h2 id="welcome-title">{WELCOME_TITLE}</h2>
        <p>{WELCOME_TEXT}</p>
        <p className="welcome-disclaimer">{DISCLAIMER_SHORT}</p>
        <div className="welcome-how">
          <h3 id="welcome-how">{WELCOME_HOW}</h3>
          <ol className="welcome-steps" aria-labelledby="welcome-how">
            {STEPS.map((s, i) => (
              <li key={s.key}><span className="step-dot" aria-hidden="true"><span className="n">{i + 1}</span></span>{s.name}</li>
            ))}
          </ol>
        </div>
        {newTabHref ? <p className="hint" id="welcome-new-tab">{NEW_TAB_NOTE}</p> : null}
        <div className="actions">
          {onStartOwn ? <button type="button" className="btn btn-quiet welcome-start-own" onClick={onStartOwn}>{START_OWN_LABEL}</button> : null}
          <button type="button" className="btn btn-secondary" onClick={onDismiss}>{DISMISS_LABEL}</button>
          {newTabHref ? (
            <a ref={primary} className="btn btn-primary" href={newTabHref} target="_blank" rel="noopener noreferrer" aria-describedby="welcome-new-tab" onClick={() => window.setTimeout(onDismiss, 0)}>{TRY_EXAMPLE_LABEL}</a>
          ) : (
            <button ref={primary} type="button" className="btn btn-primary" onClick={onTryExample}>{TRY_EXAMPLE_LABEL}</button>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
