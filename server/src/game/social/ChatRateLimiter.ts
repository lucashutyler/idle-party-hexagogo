import type { ChatChannelType } from '@idle-party-rpg/shared';
import { SlidingWindowLimiter } from '../../RateLimiter.js';

export const CHAT_SEND_LIMIT_REFUSAL = 'You\'re sending messages too fast. Wait a few seconds.';
export const FRIEND_REQUEST_LIMIT_REFUSAL = 'You\'ve sent a lot of friend requests. Try again in a few minutes.';

/** Every player message counts against `perSender`; global messages also count against `global`. See docs/architecture/social.md → Send limits. */
export const CHAT_SEND_LIMITS = {
  perSender: [
    { limit: 5, windowMs: 5_000 },
    { limit: 20, windowMs: 60_000 },
  ],
  global: { limit: 1, windowMs: 3_000 },
} as const;

export const FRIEND_REQUEST_LIMIT = { limit: 20, windowMs: 10 * 60_000 } as const;

const PRUNE_EVERY_MS = 60_000;

type Clock = () => number;

/** Prunes its limiters at most once a minute, when asked. */
class PrunedLimiters {
  private lastPruneAt: number;

  constructor(private readonly limiters: readonly SlidingWindowLimiter[], private readonly now: Clock) {
    this.lastPruneAt = now();
  }

  pruneIfDue(): void {
    const now = this.now();
    if (now - this.lastPruneAt < PRUNE_EVERY_MS) return;
    this.lastPruneAt = now;
    for (const limiter of this.limiters) limiter.prune();
  }
}

export class ChatRateLimiter {
  private readonly perSender: SlidingWindowLimiter[];
  private readonly global: SlidingWindowLimiter;
  private readonly pruning: PrunedLimiters;

  constructor(now: Clock = () => Date.now()) {
    this.perSender = CHAT_SEND_LIMITS.perSender.map(({ limit, windowMs }) => new SlidingWindowLimiter(limit, windowMs, now));
    this.global = new SlidingWindowLimiter(CHAT_SEND_LIMITS.global.limit, CHAT_SEND_LIMITS.global.windowMs, now);
    this.pruning = new PrunedLimiters([...this.perSender, this.global], now);
  }

  /** Counts one message against every limit that applies, or none when any of them is reached. */
  tryTake(sender: string, channelType: ChatChannelType): boolean {
    this.pruning.pruneIfDue();
    const limiters = channelType === 'global' ? [...this.perSender, this.global] : this.perSender;
    if (!limiters.every(limiter => limiter.allows(sender))) return false;
    for (const limiter of limiters) limiter.tryTake(sender);
    return true;
  }

  get keyCount(): number {
    return Math.max(...this.perSender.map(limiter => limiter.keyCount), this.global.keyCount);
  }
}

export class FriendRequestLimiter {
  private readonly limiter: SlidingWindowLimiter;
  private readonly pruning: PrunedLimiters;

  constructor(now: Clock = () => Date.now()) {
    this.limiter = new SlidingWindowLimiter(FRIEND_REQUEST_LIMIT.limit, FRIEND_REQUEST_LIMIT.windowMs, now);
    this.pruning = new PrunedLimiters([this.limiter], now);
  }

  allows(sender: string): boolean {
    this.pruning.pruneIfDue();
    return this.limiter.allows(sender);
  }

  take(sender: string): void {
    this.limiter.tryTake(sender);
  }

  get keyCount(): number {
    return this.limiter.keyCount;
  }
}
