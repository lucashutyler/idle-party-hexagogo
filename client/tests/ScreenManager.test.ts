import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenManager, type Screen } from '../src/screens/ScreenManager';

function makeScreen(prebuild?: () => void): Screen {
  return { onActivate: vi.fn(), onDeactivate: vi.fn(), prebuild };
}

describe('ScreenManager.prebuildSteps', () => {
  let manager: ScreenManager;
  let element: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    manager = new ScreenManager();
    element = document.getElementById('a')!;
  });

  it('builds the screen, then lays it out with its hidden contents lifted for that pass only', () => {
    const order: string[] = [];
    const prebuild = vi.fn(() => { order.push('build'); });
    Object.defineProperty(element, 'offsetHeight', {
      get: () => {
        order.push(`layout:${element.dataset.prebuilding !== undefined}`);
        return 0;
      },
    });
    manager.register('a', element, makeScreen(prebuild));

    manager.prebuildSteps(['a']).forEach(step => step());

    expect(order).toEqual(['build', 'layout:true']);
    expect(element.dataset.prebuilding).toBeUndefined();
  });

  it('gives a separate step to each piece of work, so each gets its own idle slot', () => {
    manager.register('a', element, makeScreen(vi.fn()));
    manager.register('b', document.getElementById('b')!, makeScreen(vi.fn()));

    expect(manager.prebuildSteps(['a', 'b'])).toHaveLength(4);
  });

  it('skips screens that have no prebuild or are not registered', () => {
    manager.register('a', element, makeScreen());

    expect(manager.prebuildSteps(['a', 'missing'])).toEqual([]);
  });

  it('skips a screen the player reached first', () => {
    const prebuild = vi.fn();
    manager.register('a', element, makeScreen(prebuild));
    const steps = manager.prebuildSteps(['a']);

    manager.switchTo('a');
    steps.forEach(step => step());

    expect(prebuild).not.toHaveBeenCalled();
    expect(element.dataset.prebuilding).toBeUndefined();
  });

  it('skips a screen the player has already left again', () => {
    const prebuild = vi.fn();
    manager.register('a', element, makeScreen(prebuild));
    manager.register('b', document.getElementById('b')!, makeScreen());
    const steps = manager.prebuildSteps(['a']);

    manager.switchTo('a');
    manager.switchTo('b');
    steps.forEach(step => step());

    expect(prebuild).not.toHaveBeenCalled();
  });

  it('builds a screen registered again for a new game session', () => {
    const stale = vi.fn();
    manager.register('a', element, makeScreen(stale));
    manager.switchTo('a');

    const prebuild = vi.fn();
    manager.register('a', element, makeScreen(prebuild));
    manager.switchTo('other');
    manager.prebuildSteps(['a']).forEach(step => step());

    expect(prebuild).toHaveBeenCalledTimes(1);
    expect(stale).not.toHaveBeenCalled();
  });
});
