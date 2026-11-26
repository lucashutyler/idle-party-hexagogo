import { describe, expect, it } from 'vitest';
import { ChatRateLimiter, FRIEND_REQUEST_LIMIT, GUILD_INVITE_LIMIT, RequestLimiter } from '../src/game/social/ChatRateLimiter.js';

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

describe('ChatRateLimiter', () => {
  it('allows five messages in five seconds, refuses the sixth, and allows it once the window has passed', () => {
    const c = clock();
    const limits = new ChatRateLimiter(c.now);

    for (let i = 0; i < 5; i++) {
      expect(limits.tryTake('Testy', 'zone')).toBe(true);
      c.advance(900);
    }
    expect(limits.tryTake('Testy', 'zone')).toBe(false);

    c.advance(600);
    expect(limits.tryTake('Testy', 'zone')).toBe(true);
  });

  it('allows twenty messages a minute, sent slowly enough for the short window', () => {
    const c = clock();
    const limits = new ChatRateLimiter(c.now);

    for (let i = 0; i < 20; i++) {
      expect(limits.tryTake('Testy', 'party')).toBe(true);
      c.advance(1_100);
    }
    expect(limits.tryTake('Testy', 'party')).toBe(false);

    c.advance(60_000);
    expect(limits.tryTake('Testy', 'party')).toBe(true);
  });

  it('allows one global message every three seconds, and other channels in between', () => {
    const c = clock();
    const limits = new ChatRateLimiter(c.now);

    expect(limits.tryTake('Testy', 'global')).toBe(true);
    expect(limits.tryTake('Testy', 'global')).toBe(false);
    expect(limits.tryTake('Testy', 'dm')).toBe(true);

    c.advance(3_001);
    expect(limits.tryTake('Testy', 'global')).toBe(true);
  });

  it('shares one budget across channels', () => {
    const limits = new ChatRateLimiter(clock().now);

    expect(limits.tryTake('Testy', 'global')).toBe(true);
    for (const channel of ['dm', 'dm', 'guild', 'tile'] as const) expect(limits.tryTake('Testy', channel)).toBe(true);
    expect(limits.tryTake('Testy', 'dm')).toBe(false);
  });

  it('counts nothing for a refused message', () => {
    const c = clock();
    const limits = new ChatRateLimiter(c.now);
    expect(limits.tryTake('Testy', 'global')).toBe(true);
    c.advance(1_000);

    for (let i = 0; i < 10; i++) expect(limits.tryTake('Testy', 'global')).toBe(false);

    for (let i = 0; i < 4; i++) expect(limits.tryTake('Testy', 'zone')).toBe(true);
  });

  it('keeps each sender apart', () => {
    const limits = new ChatRateLimiter(clock().now);
    for (let i = 0; i < 5; i++) limits.tryTake('Testy', 'zone');

    expect(limits.tryTake('Testy', 'zone')).toBe(false);
    expect(limits.tryTake('Quill', 'zone')).toBe(true);
  });

  it('forgets idle senders', () => {
    const c = clock();
    const limits = new ChatRateLimiter(c.now);
    limits.tryTake('Testy', 'global');
    expect(limits.keyCount).toBe(1);

    c.advance(61_000);
    limits.tryTake('Quill', 'zone');

    expect(limits.keyCount).toBe(1);
  });
});

describe('RequestLimiter', () => {
  it('refuses the 21st friend request in ten minutes, and allows one once the window has passed', () => {
    const c = clock();
    const limits = new RequestLimiter(FRIEND_REQUEST_LIMIT, c.now);

    for (let i = 0; i < 20; i++) {
      expect(limits.allows('Testy')).toBe(true);
      limits.take('Testy');
      c.advance(1_000);
    }
    expect(limits.allows('Testy')).toBe(false);
    expect(limits.allows('Quill')).toBe(true);

    c.advance(10 * 60_000);
    expect(limits.allows('Testy')).toBe(true);
  });

  it('counts only what was taken', () => {
    const limits = new RequestLimiter(FRIEND_REQUEST_LIMIT, clock().now);

    for (let i = 0; i < 50; i++) limits.allows('Testy');

    expect(limits.allows('Testy')).toBe(true);
  });

  it('allows 20 guild invites in ten minutes', () => {
    const c = clock();
    const limits = new RequestLimiter(GUILD_INVITE_LIMIT, c.now);

    for (let i = 0; i < 20; i++) limits.take('Testy');
    expect(limits.allows('Testy')).toBe(false);

    c.advance(10 * 60_000);
    expect(limits.allows('Testy')).toBe(true);
  });
});
