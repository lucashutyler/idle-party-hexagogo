import { describe, it, expect, afterEach, vi } from 'vitest';
import { fx } from '../src/ui/motion';

describe('fx', () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };

  afterEach(() => {
    process.off('unhandledRejection', onRejection);
    rejections.length = 0;
    vi.restoreAllMocks();
  });

  it('does not leave an unhandled rejection when an animation is cancelled', async () => {
    process.on('unhandledRejection', onRejection);
    const animation = fx(document.createElement('div'), [{ opacity: 0 }, { opacity: 1 }], 1000);

    animation?.cancel();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(animation).not.toBeNull();
    expect(rejections).toEqual([]);
  });

  it('returns null when the element cannot animate', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'animate', { value: undefined });

    expect(fx(element, [], 100)).toBeNull();
  });
});
