import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter } from '../src/RateLimiter.js';

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe('SlidingWindowLimiter', () => {
  it('allows up to the limit per key, then refuses', () => {
    const limiter = new SlidingWindowLimiter(3, 1000, clock().now);

    expect([1, 2, 3].map(() => limiter.tryTake('a'))).toEqual([true, true, true]);
    expect(limiter.tryTake('a')).toBe(false);
    expect(limiter.allows('a')).toBe(false);
    expect(limiter.tryTake('b')).toBe(true);
  });

  it('does not count a refused take', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(1, 1000, c.now);
    limiter.tryTake('a');
    c.advance(600);
    expect(limiter.tryTake('a')).toBe(false);

    c.advance(401);
    expect(limiter.tryTake('a')).toBe(true);
  });

  it('frees a slot once the oldest take leaves the window', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 1000, c.now);
    limiter.tryTake('a');
    c.advance(500);
    limiter.tryTake('a');
    expect(limiter.allows('a')).toBe(false);

    c.advance(499);
    expect(limiter.tryTake('a')).toBe(false);
    c.advance(1);
    expect(limiter.tryTake('a')).toBe(true);
    expect(limiter.tryTake('a')).toBe(false);
  });

  it('checks without counting through allows', () => {
    const limiter = new SlidingWindowLimiter(1, 1000, clock().now);
    expect(limiter.allows('a')).toBe(true);
    expect(limiter.allows('a')).toBe(true);
    expect(limiter.tryTake('a')).toBe(true);
    expect(limiter.allows('a')).toBe(false);
  });

  it('prune drops keys with nothing left in the window and keeps the rest', () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(1, 1000, c.now);
    limiter.tryTake('idle');
    c.advance(800);
    limiter.tryTake('busy');
    c.advance(201);
    expect(limiter.keyCount).toBe(2);

    limiter.prune();

    expect(limiter.keyCount).toBe(1);
    expect(limiter.allows('busy')).toBe(false);
    expect(limiter.allows('idle')).toBe(true);
    expect(limiter.keyCount).toBe(1);
  });
});
