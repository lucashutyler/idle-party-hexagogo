/** Safari has no `requestIdleCallback`; this leaves startup room to settle first. */
const NO_IDLE_CALLBACK_DELAY_MS = 1500;

export function saveDataRequested(): boolean {
  return !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
}

/** Runs each step once, one per idle slot, and only while the tab is visible. Returns a cancel function. */
export function runStepsWhenIdle(steps: readonly (() => void)[]): () => void {
  const queue = [...steps];
  let cancelSlot: (() => void) | undefined;

  const requestSlot = (): void => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(runNext);
      cancelSlot = () => window.cancelIdleCallback(id);
    } else {
      const id = setTimeout(runNext, NO_IDLE_CALLBACK_DELAY_MS);
      cancelSlot = () => clearTimeout(id);
    }
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') return;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    requestSlot();
  };

  const scheduleNext = (): void => {
    if (queue.length === 0) return;
    if (document.visibilityState === 'hidden') document.addEventListener('visibilitychange', onVisibilityChange);
    else requestSlot();
  };

  const runNext = (): void => {
    if (document.visibilityState === 'hidden') {
      scheduleNext();
      return;
    }
    try {
      queue.shift()?.();
    } finally {
      scheduleNext();
    }
  };

  scheduleNext();

  return () => {
    queue.length = 0;
    cancelSlot?.();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
