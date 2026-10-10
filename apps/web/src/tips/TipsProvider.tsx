// Tip visibility, shared by every step and remembered per device.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { useFlow, type StepKey } from "../state/Flow";
import { SHOWING, isHidden, readTipsState, writeTipsState, type TipsState } from "./storage";

interface TipsValue {
  readonly isVisible: (id: string) => boolean;
  readonly hide: (id: string) => void;
  readonly hideAll: () => void;
  readonly showAll: () => void;
  /** Steps whose tip slot is on screen right now (Review has none while it can't draw the picture). */
  readonly slots: ReadonlySet<StepKey>;
  readonly registerSlot: (step: StepKey) => () => void;
  /** Set by "Show tips": the tip that appears takes focus once. Cleared when the step changes. */
  readonly focusCardRef: MutableRefObject<boolean>;
}
const Ctx = createContext<TipsValue | null>(null);

export function TipsProvider({ children }: { children: ReactNode }) {
  const { step } = useFlow();
  const [state, setState] = useState<TipsState>(readTipsState);
  const [slots, setSlots] = useState<ReadonlySet<StepKey>>(new Set());
  const latest = useRef(state);
  const focusCardRef = useRef(false);
  useEffect(() => { focusCardRef.current = false; }, [step]);
  const commit = useCallback((next: TipsState) => { latest.current = next; setState(next); writeTipsState(next); }, []);
  const hide = useCallback((id: string) => { if (!latest.current.hidden.includes(id)) commit({ ...latest.current, hidden: [...latest.current.hidden, id] }); }, [commit]);
  const hideAll = useCallback(() => commit({ ...latest.current, all: true }), [commit]);
  const showAll = useCallback(() => commit(SHOWING), [commit]);
  const registerSlot = useCallback((s: StepKey) => {
    setSlots((prev) => (prev.has(s) ? prev : new Set(prev).add(s)));
    return () => setSlots((prev) => { if (!prev.has(s)) return prev; const next = new Set(prev); next.delete(s); return next; });
  }, []);
  const value = useMemo<TipsValue>(() => ({ isVisible: (id) => !isHidden(state, id), hide, hideAll, showAll, slots, registerSlot, focusCardRef }), [state, hide, hideAll, showAll, slots, registerSlot]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTips(): TipsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("TipsProvider is missing.");
  return v;
}
