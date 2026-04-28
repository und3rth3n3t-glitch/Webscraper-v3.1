// Same-origin gate for the drain phase. Pure functions only — all
// scheduler state passed in. Fully unit-testable without DOM/runtime.

export const DRAIN_PARALLEL_CAP = 4;

// Returns true if a task with the given origin can start (or resume into
// drain) right now, given the set of origins already running in drain
// and the running count vs cap.
//   - origin === null  → no origin gate (still subject to cap)
//   - cap === 0        → never startable
//   - runningCount >= cap → never startable
//   - origin in activeOrigins → blocked
export function canStartInDrain(
  origin: string | null,
  activeOrigins: ReadonlySet<string>,
  runningCount: number,
  cap: number,
): boolean {
  if (cap <= 0) return false;
  if (runningCount >= cap) return false;
  if (origin !== null && activeOrigins.has(origin)) return false;
  return true;
}
