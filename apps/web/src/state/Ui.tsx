// Screen-level state that is not part of the scene: units, the search text, the toast,
// and the last save (to mark the stamp stale when the scene changes after it).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExportStamp, Units } from "@csd/core";

export interface LastExport {
  readonly stamp: ExportStamp;
  /** Canonical scene text at save time, to tell when the scene has changed since. */
  readonly sceneKey: string;
}

/** A typed value that can't be used yet (the speed field). It blocks Review and Save until it is fixed. */
export interface FieldError {
  readonly text: string;
  readonly vehicleId: string;
}

interface UiValue {
  readonly units: Units;
  readonly setUnits: (u: Units) => void;
  readonly query: string;
  readonly setQuery: (q: string) => void;
  readonly toast: string | null;
  readonly showToast: (text: string) => void;
  readonly hideToast: () => void;
  /** Street names drawn on top of the map (the street picked, or the two that meet). */
  readonly highlight: readonly string[];
  readonly setHighlight: (names: readonly string[]) => void;
  /** Typed values waiting to be fixed, by field key. */
  readonly fieldErrors: Readonly<Record<string, FieldError>>;
  readonly setFieldError: (key: string, error: FieldError | null) => void;
  readonly lastExport: LastExport | null;
  readonly setLastExport: (e: LastExport | null) => void;
}
const Ctx = createContext<UiValue | null>(null);

/** How long a toast stays: the --duration-toast token (not changed by reduced motion). */
export function toastMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--duration-toast");
  const ms = parseFloat(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : 4000;
}

export function UiProvider({ children, initialQuery }: { children: ReactNode; initialQuery: string }) {
  const [units, setUnits] = useState<Units>("us");
  const [query, setQuery] = useState(initialQuery);
  const [toast, setToast] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<LastExport | null>(null);
  const [highlight, setHighlight] = useState<readonly string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, FieldError>>>({});
  const setFieldError = useCallback((key: string, error: FieldError | null) => {
    setFieldErrors((prev) => {
      if (error == null) {
        if (!(key in prev)) return prev;
        const { [key]: _gone, ...rest } = prev;
        return rest;
      }
      return prev[key]?.text === error.text && prev[key]?.vehicleId === error.vehicleId ? prev : { ...prev, [key]: error };
    });
  }, []);
  const timer = useRef(0);
  const hideToast = useCallback(() => { window.clearTimeout(timer.current); setToast(null); }, []);
  const showToast = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setToast(text);
    timer.current = window.setTimeout(() => setToast(null), toastMs());
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const value = useMemo(() => ({ units, setUnits, query, setQuery, toast, showToast, hideToast, highlight, setHighlight, fieldErrors, setFieldError, lastExport, setLastExport }), [units, query, toast, showToast, hideToast, highlight, fieldErrors, setFieldError, lastExport]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUi(): UiValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("UiProvider is missing.");
  return v;
}
