// Radio groups and tab lists with a roving tabindex: one tab stop per group, arrow keys move
// the choice (and focus), Home/End jump to the ends. Radios here are buttons with role="radio",
// so the same component works for tiles, the compass, the impact zones and the unit switch.
import { createContext, useContext, type ButtonHTMLAttributes, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";

type Key = string | number;

/** Move focus and selection to the neighbour for an arrow/Home/End key. Returns true when handled. */
export function moveRoving(e: KeyboardEvent<HTMLElement>, selector: string, keys: { next: readonly string[]; prev: readonly string[] }): boolean {
  const current = (e.target as HTMLElement).closest<HTMLElement>(selector);
  if (!current) return false;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hasAttribute("disabled"));
  const i = items.indexOf(current);
  if (i < 0) return false;
  let target: HTMLElement | undefined;
  if (keys.next.includes(e.key)) target = items[(i + 1) % items.length];
  else if (keys.prev.includes(e.key)) target = items[(i - 1 + items.length) % items.length];
  else if (e.key === "Home") target = items[0];
  else if (e.key === "End") target = items[items.length - 1];
  if (!target) return false;
  e.preventDefault();
  target.focus();
  target.click();
  return true;
}

interface GroupContext {
  readonly value: Key | null;
  readonly values: readonly Key[];
  readonly onChange: (v: never) => void;
}
const Ctx = createContext<GroupContext | null>(null);

export interface RadioGroupProps<T extends Key> extends Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "role"> {
  /** Every value in the group, in tab/arrow order. */
  readonly values: readonly T[];
  readonly value: T | null;
  readonly onChange: (value: T) => void;
  readonly children: ReactNode;
}

export function RadioGroup<T extends Key>({ values, value, onChange, children, onKeyDown, ...rest }: RadioGroupProps<T>) {
  return (
    <Ctx.Provider value={{ value, values, onChange: onChange as (v: never) => void }}>
      <div
        {...rest}
        role="radiogroup"
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (!e.defaultPrevented) moveRoving(e, '[role="radio"]', { next: ["ArrowRight", "ArrowDown"], prev: ["ArrowLeft", "ArrowUp"] });
        }}
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

export interface RadioProps<T extends Key> extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "role" | "onClick"> {
  readonly value: T;
}

export function Radio<T extends Key>({ value, children, ...rest }: RadioProps<T>) {
  const g = useContext(Ctx);
  if (!g) throw new Error("Radio must sit inside a RadioGroup.");
  const checked = g.value === value;
  // The checked radio is the tab stop; with none checked, the first one is.
  const anyChecked = g.value !== null && g.values.includes(g.value);
  const tabStop = checked || (!anyChecked && g.values[0] === value);
  return (
    <button {...rest} type="button" role="radio" aria-checked={checked} tabIndex={tabStop ? 0 : -1} onClick={() => g.onChange(value as never)}>
      {children}
    </button>
  );
}

/* ---------- Tabs ---------- */

interface TabsContext {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly idBase: string;
}
const TabsCtx = createContext<TabsContext | null>(null);

export interface TabListProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "role"> {
  readonly value: string;
  readonly onChange: (v: string) => void;
  /** Prefix for the tab and panel ids. */
  readonly idBase: string;
  readonly children: ReactNode;
}

export function TabList({ value, onChange, idBase, children, ...rest }: TabListProps) {
  return (
    <TabsCtx.Provider value={{ value, onChange, idBase }}>
      <div {...rest} role="tablist" onKeyDown={(e) => moveRoving(e, '[role="tab"]', { next: ["ArrowRight"], prev: ["ArrowLeft"] })}>
        {children}
      </div>
    </TabsCtx.Provider>
  );
}

export function Tab({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const t = useContext(TabsCtx);
  if (!t) throw new Error("Tab must sit inside a TabList.");
  const selected = t.value === value;
  return (
    <button type="button" role="tab" className={className} id={`${t.idBase}-tab-${value}`} aria-selected={selected} aria-controls={`${t.idBase}-panel-${value}`} tabIndex={selected ? 0 : -1} onClick={() => t.onChange(value)}>
      {children}
    </button>
  );
}

export function TabPanel({ idBase, value, current, children, className }: { idBase: string; value: string; current: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" className={className} id={`${idBase}-panel-${value}`} aria-labelledby={`${idBase}-tab-${value}`} hidden={current !== value}>
      {current === value ? children : null}
    </div>
  );
}
