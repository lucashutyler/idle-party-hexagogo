import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runStepsWhenIdle, saveDataRequested } from '../src/ui/idleSteps';

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('runStepsWhenIdle', () => {
  let slots: Map<number, () => void>;

  const runIdleSlot = (): void => {
    const [id, slot] = [...slots.entries()][0];
    slots.delete(id);
    slot();
  };

  beforeEach(() => {
    slots = new Map();
    let nextId = 1;
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => {
      slots.set(nextId, cb);
      return nextId++;
    });
    vi.stubGlobal('cancelIdleCallback', (id: number) => { slots.delete(id); });
    setVisibility('visible');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('runs one step per idle slot', () => {
    const first = vi.fn();
    const second = vi.fn();
    runStepsWhenIdle([first, second]);

    expect(first).not.toHaveBeenCalled();
    runIdleSlot();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    runIdleSlot();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('asks for no more idle time once the steps have run', () => {
    const step = vi.fn();
    runStepsWhenIdle([step]);

    runIdleSlot();

    expect(slots.size).toBe(0);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('asks for no idle time while the tab is hidden, and resumes when it is shown', () => {
    setVisibility('hidden');
    const step = vi.fn();
    runStepsWhenIdle([step]);
    expect(slots.size).toBe(0);

    setVisibility('visible');
    expect(step).not.toHaveBeenCalled();
    runIdleSlot();

    expect(step).toHaveBeenCalledTimes(1);
  });

  it('holds a step whose slot arrives after the tab was hidden', () => {
    const step = vi.fn();
    runStepsWhenIdle([step]);
    setVisibility('hidden');

    runIdleSlot();

    expect(step).not.toHaveBeenCalled();
    expect(slots.size).toBe(0);

    setVisibility('visible');
    runIdleSlot();
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('stops after hiding and showing the tab again once every step has run', () => {
    const step = vi.fn();
    runStepsWhenIdle([step]);
    runIdleSlot();

    setVisibility('hidden');
    setVisibility('visible');

    expect(slots.size).toBe(0);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a step throws', () => {
    const later = vi.fn();
    runStepsWhenIdle([() => { throw new Error('boom'); }, later]);

    expect(runIdleSlot).toThrow('boom');
    runIdleSlot();

    expect(later).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the waiting slot and the remaining steps', () => {
    const step = vi.fn();
    const cancel = runStepsWhenIdle([step]);

    cancel();

    expect(slots.size).toBe(0);
    setVisibility('hidden');
    setVisibility('visible');
    expect(slots.size).toBe(0);
    expect(step).not.toHaveBeenCalled();
  });

  it('cancel also stops a run that is waiting for the tab to be shown', () => {
    setVisibility('hidden');
    const step = vi.fn();
    const cancel = runStepsWhenIdle([step]);

    cancel();
    setVisibility('visible');

    expect(slots.size).toBe(0);
    expect(step).not.toHaveBeenCalled();
  });

  it('falls back to a timer where requestIdleCallback is missing', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestIdleCallback', undefined);
    const first = vi.fn();
    const second = vi.fn();
    runStepsWhenIdle([first, second]);

    expect(first).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    expect(second).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('saveDataRequested', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'connection');
  });

  it('reads the browser data-saver flag', () => {
    expect(saveDataRequested()).toBe(false);
    Object.defineProperty(navigator, 'connection', { configurable: true, value: { saveData: true } });
    expect(saveDataRequested()).toBe(true);
  });
});
