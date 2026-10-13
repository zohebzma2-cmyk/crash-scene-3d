// The dialog primitive shared by the About and Welcome dialogs (DESIGN.md section 4, Dialog): a native <dialog>
// opened with showModal(), so the page behind is inert and the dialog is announced as modal. On open, focus goes to
// the given element (else the first button); Tab and Shift+Tab stay inside; Esc and a click on the backdrop call
// onDismiss; when it closes, focus goes back to where it was before it opened.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalDialogProps {
  /** The id of the dialog's title. */
  readonly labelledBy: string;
  /** Esc and a click on the backdrop. */
  readonly onDismiss: () => void;
  /** Takes focus on open (else the first focusable element). */
  readonly initialFocus?: RefObject<HTMLElement | null>;
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function ModalDialog({ labelledBy, onDismiss, initialFocus, className, testId, children }: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const dismiss = useRef(onDismiss);
  useEffect(() => { dismiss.current = onDismiss; });
  // Where the press on the backdrop started: a drag that starts inside (selecting text) and ends outside is not a dismiss.
  const downOnBackdrop = useRef(false);

  // A layout effect, so the dialog is open (and the page behind inert) before anything paints.
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", "");
    const first = initialFocus?.current ?? d.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus({ preventScroll: true });
    return () => {
      if (typeof d.close === "function") { if (d.open) d.close(); } else d.removeAttribute("open");
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [initialFocus]);

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === "Escape") { e.preventDefault(); dismiss.current(); return; }
    if (e.key !== "Tab") return;
    // Every Tab is moved here (not left to the browser), so it is the same in every engine: Safari's Tab skips
    // buttons and links unless the person has turned that on, and Chrome lets Tab leave a modal for the address bar.
    e.preventDefault();
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  const onMouseDown = (e: MouseEvent<HTMLDialogElement>) => { downOnBackdrop.current = e.target === e.currentTarget; };
  // The dialog box has no padding of its own (its body fills it), so a click on the <dialog> itself is on the backdrop.
  const onClick = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget && downOnBackdrop.current) dismiss.current();
    downOnBackdrop.current = false;
  };

  return (
    // Native <dialog> keyboard (Esc) handling is kept; the handlers add the focus trap and the backdrop click.
    <dialog
      ref={ref}
      className={className}
      data-testid={testId}
      aria-labelledby={labelledBy}
      aria-modal="true"
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onCancel={(e) => { e.preventDefault(); dismiss.current(); }}
    >
      {children}
    </dialog>
  );
}
