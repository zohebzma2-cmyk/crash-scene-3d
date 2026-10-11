import { runOne } from "./run";
const scope = self as unknown as { onmessage: ((e: MessageEvent<{ i: number; which: string }>) => void) | null; postMessage(m: unknown): void };
scope.onmessage = (e) => scope.postMessage(runOne(e.data.i, e.data.which));
