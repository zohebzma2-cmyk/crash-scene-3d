// Until the real physics, map parsing and exports are merged, their functions throw
// "not implemented yet". In fixtures mode only, a service call that hits that falls back to a
// stand-in from fakes.ts. In live mode errors are never hidden.
export const isNotImplemented = (e: unknown): boolean => e instanceof Error && e.message.startsWith("not implemented yet");

export function withFallback<A extends unknown[], R>(real: (...args: A) => R, fake: (...args: A) => R, enabled: boolean): (...args: A) => R {
  if (!enabled) return real;
  let useFake = false;
  return (...args: A): R => {
    if (useFake) return fake(...args);
    try {
      const out = real(...args);
      if (out instanceof Promise) {
        return out.catch((e: unknown) => {
          if (!isNotImplemented(e)) throw e;
          useFake = true;
          return fake(...args);
        }) as R;
      }
      return out;
    } catch (e) {
      if (!isNotImplemented(e)) throw e;
      useFake = true;
      return fake(...args);
    }
  };
}
