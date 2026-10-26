export interface HUDExecutionBudget {
  maxSteps: number;
  maxMs: number;
}

export interface HUDExecutionGuard {
  tick: () => void;
}

type SliceEnd = () => void;

// Runs `end` in a task after the current one. Like React's scheduler, this prefers
// setImmediate (Node) and then a MessageChannel (browsers) over timers: hidden documents
// throttle timers, and a late end would merge unrelated later tasks into one stale slice.
function createSliceEndScheduler(): (end: SliceEnd) => void {
  const immediate = (globalThis as { setImmediate?: (callback: SliceEnd) => unknown }).setImmediate;
  if (typeof immediate === "function") return (end: SliceEnd) => { immediate(end); };
  if (typeof MessageChannel === "function") {
    const channel = new MessageChannel();
    let pending: SliceEnd[] = [];
    channel.port1.onmessage = () => {
      const ends = pending;
      pending = [];
      ends.forEach((end) => end());
    };
    return (end: SliceEnd) => {
      pending.push(end);
      channel.port2.postMessage(null);
    };
  }
  return (end: SliceEnd) => { setTimeout(end, 0); };
}

const scheduleSliceEnd = createSliceEndScheduler();

/**
 * Bounds each synchronous execution slice of sandboxed HUD code.
 *
 * A slice opens at the first guard tick after the event loop last regained control and
 * closes once the current task, including its microtasks, has finished. Event handlers,
 * timers and re-renders that run later therefore start with a full budget, while code
 * that never yields, including promise chains that starve the event loop, exhausts its
 * slice and is stopped.
 */
export function createExecutionGuard(budget: HUDExecutionBudget): HUDExecutionGuard {
  let sliceStarted: number | null = null;
  let steps = 0;
  return {
    tick: () => {
      if (sliceStarted === null) {
        sliceStarted = performance.now();
        steps = 0;
        scheduleSliceEnd(() => { sliceStarted = null; });
      }
      steps += 1;
      if (steps > budget.maxSteps || performance.now() - sliceStarted > budget.maxMs) {
        throw new Error("HUD execution exceeded the sandbox budget");
      }
    },
  };
}
