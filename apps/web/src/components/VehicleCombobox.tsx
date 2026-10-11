// One field of the vehicle picker (year, make or model) as a WAI-ARIA combobox: a text input with a
// list that is open while you type, arrow keys and Enter to pick, Escape to close, and touch rows at
// least --size-touch tall. The parent ranks the items; the input always keeps what was typed, so a
// vehicle vPIC doesn't know still works ("Use 'Zephyr' as typed").
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";

export interface ComboItem {
  readonly id: string;
  /** What picking it puts in the field. */
  readonly value: string;
  readonly main: string;
  readonly sub?: string | undefined;
  /** Shown before the text (a maker's logo, when there is one). */
  readonly lead?: ReactNode;
  /** The "use what I typed" row. */
  readonly free?: boolean;
}

export interface ComboStatus {
  readonly kind: "loading" | "note";
  readonly text: string;
}

export interface VehicleComboboxProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly items: readonly ComboItem[];
  readonly onType: (text: string) => void;
  readonly onPick: (item: ComboItem) => void;
  /** The field lost focus (Tab, a tap elsewhere) or Enter was pressed with nothing highlighted. */
  readonly onCommit?: () => void;
  /** A line under the rows: loading, or why there is no list. */
  readonly status?: ComboStatus | null;
  readonly inputMode?: "numeric" | "text";
  readonly maxLength?: number;
  readonly className?: string;
  readonly inputClassName?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  /** Extra name for the rows' list, read by screen readers ("Suggestions" when not given). */
  readonly listLabel?: string;
  /** Say how many suggestions there are (a polite live region, after typing settles). */
  readonly announce?: boolean;
}

/** The count is announced this long after the list last changed, so it isn't read on every keystroke. */
export const ANNOUNCE_DELAY_MS = 600;
export const suggestionsCount = (n: number) => (n === 0 ? "No suggestions." : `${n} ${n === 1 ? "suggestion" : "suggestions"}. Use the arrow keys.`);

export const SUGGESTIONS_LABEL = "Suggestions";
/** The list closes this long after the field loses focus (the address search uses the same pause). */
export const BLUR_CLOSE_MS = 120;

export function VehicleCombobox({
  id, label, value, items, onType, onPick, onCommit, status = null, inputMode = "text", maxLength, className = "", inputClassName = "", inputRef, listLabel = SUGGESTIONS_LABEL, announce = false,
}: VehicleComboboxProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [open, setOpen] = useState(false);
  /** The highlighted row; -1 for none. Typing highlights the best match so Enter takes it. */
  const [active, setActive] = useState(-1);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const current = active >= 0 && active < items.length ? active : -1;
  const visible = open && (items.length > 0 || status != null);
  const activeId = visible && current >= 0 ? items[current]?.id : undefined;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  // The live region is always in the page (a region added with its text is often not read); its text follows the
  // list once typing settles, and empties when the list closes.
  const matches = items.filter((i) => !i.free).length;
  const [said, setSaid] = useState("");
  useEffect(() => {
    if (!announce) return;
    const timer = window.setTimeout(() => setSaid(visible ? suggestionsCount(matches) : ""), ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [announce, visible, matches]);

  const pick = (item: ComboItem) => {
    setOpen(false);
    setActive(-1);
    onPick(item);
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(items.length ? 0 : -1); return; }
      setActive(items.length ? (current + 1) % items.length : -1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); setActive(items.length ? items.length - 1 : -1); return; }
      setActive(items.length ? (current <= 0 ? items.length - 1 : current - 1) : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = visible && current >= 0 ? items[current] : undefined;
      if (item) pick(item);
      else { setOpen(false); onCommit?.(); }
    } else if (e.key === "Escape") {
      if (visible) { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); }
    }
  }

  return (
    <div className={`field combobox vcombo ${className}`.trim()}>
      <label className="field-sub" htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        className={`input ${inputClassName}`.trim()}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        aria-busy={status?.kind === "loading" || undefined}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="next"
        value={value}
        onChange={(e) => {
          onType(e.target.value);
          setOpen(true);
          setActive(e.target.value.trim() ? 0 : -1);
        }}
        onFocus={() => { window.clearTimeout(closeTimer.current); setOpen(true); setActive(-1); }}
        onBlur={() => {
          onCommit?.();
          // Close a moment later, as the address search does: on phones the list is in the page flow, and closing it
          // at once would move whatever was just tapped below it before the tap lands.
          window.clearTimeout(closeTimer.current);
          closeTimer.current = window.setTimeout(() => { setOpen(false); setActive(-1); }, BLUR_CLOSE_MS);
        }}
        onKeyDown={onKeyDown}
      />
      {visible ? (
        <div className="combo-pop">
          {/* Named without the field's own word, so "Make" names only the input. */}
          <ul className="combo-list" id={listId} role="listbox" aria-label={listLabel}>
            {items.map((item, i) => (
              <li
                key={item.id}
                id={item.id}
                role="option"
                aria-selected={i === current}
                className={`combo-option${i === current ? " is-active" : ""}${item.free ? " is-free" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(item)}
                onMouseMove={() => { if (current !== i) setActive(i); }}
              >
                {item.lead ?? null}
                <span>
                  <span className="r-main">{item.main}</span>
                  {item.sub ? <span className="r-sub">{item.sub}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {status ? (
            <p className="combo-note" role="status">
              {status.kind === "loading" ? <span className="spinner" aria-hidden="true" /> : null}
              <span>{status.text}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {announce ? <span className="visually-hidden" aria-live="polite" data-testid="combo-count">{said}</span> : null}
    </div>
  );
}
