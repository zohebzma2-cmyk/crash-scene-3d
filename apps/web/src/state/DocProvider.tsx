// The shared scene store: React context + reducer, persisted to sessionStorage under one key.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type Dispatch, type ReactNode } from "react";
import { mapThumbnail } from "../services/thumbnail";
import { loadDoc, reducer, saveDoc, type Action, type Doc } from "./doc";
import type { Scene } from "@csd/core";

interface DocContextValue {
  readonly doc: Doc;
  readonly dispatch: Dispatch<Action>;
}
const Ctx = createContext<DocContextValue | null>(null);

const storage = (): Storage | null => {
  try { return window.sessionStorage; } catch { return null; }
};

export function DocProvider({ children, initial }: { children: ReactNode; initial?: Doc }) {
  const [doc, rawDispatch] = useReducer(reducer, undefined, () => initial ?? loadDoc(storage()));
  // A map thumbnail belongs to one pin: drop it whenever the scene is replaced or the pin moves.
  const dispatch = useCallback<Dispatch<Action>>((a) => {
    if (a.type === "replace" || a.type === "reset" || a.type === "pin" || a.type === "pick") mapThumbnail.clear();
    rawDispatch(a);
  }, []);
  useEffect(() => saveDoc(storage(), doc), [doc]);
  const value = useMemo(() => ({ doc, dispatch }), [doc, dispatch]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDoc(): DocContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("DocProvider is missing.");
  return v;
}

export function useScene(): Scene {
  return useDoc().doc.scene;
}
