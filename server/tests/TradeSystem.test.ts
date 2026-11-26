import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TradeSystem,
  TRADE_NONCE_MISMATCH,
  INVALID_TRADE_ITEMS,
  TRADE_NO_LONGER_VALID,
  parseOfferItems,
  swapTradeItems,
} from '../src/game/social/TradeSystem.js';
import type { TradeInventory } from '../src/game/social/TradeSystem.js';
import { MAX_STACK } from '@idle-party-rpg/shared';
import type { TradeOfferItem, TradeState } from '@idle-party-rpg/shared';

/**
 * Async TradeSystem: trades persist across server restarts and movement, players
 * can have multiple active trades (one per partner pair), and either player can
 * confirm — but only after the OTHER player took the most recent action.
 */

function createPlayerState() {
  const inventories = new Map<string, Map<string, number>>();
  const blocked = new Map<string, Set<string>>();

  return {
    giveItem: (u: string, itemId: string, count = 1) => {
      if (!inventories.has(u)) inventories.set(u, new Map());
      const inv = inventories.get(u)!;
      inv.set(itemId, (inv.get(itemId) ?? 0) + count);
    },
    takeItem: (u: string, itemId: string) => {
      const inv = inventories.get(u);
      if (!inv) return;
      const count = inv.get(itemId) ?? 0;
      if (count <= 1) inv.delete(itemId);
      else inv.set(itemId, count - 1);
    },
    setItemCount: (u: string, itemId: string, count: number) => {
      if (!inventories.has(u)) inventories.set(u, new Map());
      inventories.get(u)!.set(itemId, count);
    },
    block: (a: string, b: string) => {
      if (!blocked.has(a)) blocked.set(a, new Set());
      blocked.get(a)!.add(b);
    },
    hasItemInInventory: (u: string, itemId: string, quantity: number = 1) =>
      (inventories.get(u)?.get(itemId) ?? 0) >= quantity,
    getInventoryCount: (u: string, itemId: string) => inventories.get(u)?.get(itemId) ?? 0,
    isBlocked: (a: string, b: string) =>
      (blocked.get(a)?.has(b) ?? false) || (blocked.get(b)?.has(a) ?? false),
  };
}

const offer = (itemId: string, quantity = 1): TradeOfferItem[] => [{ itemId, quantity }];

function setupReadyPair(state: ReturnType<typeof createPlayerState>, itemA = 'sword', itemB = 'shield') {
  state.giveItem('alice', itemA);
  state.giveItem('bob', itemB);
}

/** Propose + counter so a trade is in 'countered' state (lastUpdatedBy = 'bob'). */
function setupCounteredTrade(
  system: TradeSystem,
  state: ReturnType<typeof createPlayerState>,
  itemA = 'sword',
  itemB = 'shield',
): TradeState {
  setupReadyPair(state, itemA, itemB);
  const proposed = system.proposeTrade('alice', 'bob', offer(itemA),
    state.hasItemInInventory, state.isBlocked);
  if (typeof proposed === 'string') throw new Error(`proposeTrade failed: ${proposed}`);
  const countered = system.counterTrade(proposed.id, 'bob', offer(itemB),
    state.hasItemInInventory);
  if (typeof countered === 'string') throw new Error(`counterTrade failed: ${countered}`);
  return countered;
}

describe('TradeSystem (async)', () => {
  let system: TradeSystem;
  let state: ReturnType<typeof createPlayerState>;

  beforeEach(() => {
    system = new TradeSystem();
    state = createPlayerState();
  });

  describe('proposeTrade', () => {
    it('creates a pending trade with a target slot', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);

      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect(result.status).toBe('pending');
      expect(result.initiator).toEqual({ username: 'alice', items: [{ itemId: 'sword', quantity: 1 }] });
      expect(result.target).toEqual({ username: 'bob', items: [] });
      expect(result.lastUpdatedBy).toBe('alice');
    });

    it('rejects trading with yourself', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'alice', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      expect(result).toBe('Cannot trade with yourself');
    });

    it('rejects when blocked', () => {
      setupReadyPair(state);
      state.block('alice', 'bob');
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      expect(result).toBe('Cannot trade with a blocked user');
    });

    it('rejects when blocked in reverse direction', () => {
      setupReadyPair(state);
      state.block('bob', 'alice');
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      expect(result).toBe('Cannot trade with a blocked user');
    });

    it('does NOT require players to be on the same tile', () => {
      // Async: position is irrelevant.
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      expect(typeof result).not.toBe('string');
    });

    it('rejects duplicate trade with the same partner', () => {
      setupReadyPair(state);
      state.giveItem('alice', 'axe');
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      const result = system.proposeTrade('alice', 'bob', offer('axe'),
        state.hasItemInInventory, state.isBlocked);
      expect(result).toBe('You already have a pending trade with that player');
    });

    it('allows a player to have multiple trades with different partners', () => {
      state.giveItem('alice', 'sword');
      state.giveItem('alice', 'axe');
      state.giveItem('bob', 'shield');
      state.giveItem('charlie', 'helm');

      const r1 = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      const r2 = system.proposeTrade('alice', 'charlie', offer('axe'),
        state.hasItemInInventory, state.isBlocked);

      expect(typeof r1).not.toBe('string');
      expect(typeof r2).not.toBe('string');
      expect(system.getPlayerTrades('alice')).toHaveLength(2);
    });

    it('rejects when initiator does not have the item', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', offer('nonexistent'),
        state.hasItemInInventory, state.isBlocked);
      expect(result).toBe('Item not found in your inventory');
    });

    it('rejects empty offers', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', [],
        state.hasItemInInventory, state.isBlocked);
      expect(result).toBe(INVALID_TRADE_ITEMS);
    });
  });

  describe('whole-number offers', () => {
    const lines = (quantity: unknown) => [{ itemId: 'sword', quantity }] as unknown as TradeOfferItem[];
    const badQuantities: unknown[] = [1e-20, 1.5, 0, -1, '1'];

    it.each(badQuantities)('propose refuses a quantity of %s', (quantity) => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', lines(quantity), state.hasItemInInventory, state.isBlocked);
      expect(result).toBe(INVALID_TRADE_ITEMS);
      expect(system.findTradeBetween('alice', 'bob')).toBeNull();
    });

    it.each(badQuantities)('counter refuses a quantity of %s', (quantity) => {
      setupReadyPair(state);
      state.giveItem('bob', 'sword');
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'), state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);
      const result = system.counterTrade(proposed.id, 'bob', lines(quantity), state.hasItemInInventory);
      expect(result).toBe(INVALID_TRADE_ITEMS);
      expect(system.getTrade(proposed.id)?.target?.items).toEqual([]);
    });

    it('merges two lines of one item into one', () => {
      state.giveItem('alice', 'gem', 3);
      const result = system.proposeTrade('alice', 'bob',
        [{ itemId: 'gem', quantity: 1 }, { itemId: 'gem', quantity: 2 }], state.hasItemInInventory, state.isBlocked);
      if (typeof result === 'string') throw new Error(result);
      expect(result.initiator.items).toEqual([{ itemId: 'gem', quantity: 3 }]);
    });

    it('refuses lines of one item that add up to more than the player has', () => {
      state.giveItem('alice', 'gem', 3);
      const result = system.proposeTrade('alice', 'bob',
        [{ itemId: 'gem', quantity: 2 }, { itemId: 'gem', quantity: 2 }], state.hasItemInInventory, state.isBlocked);
      expect(result).toBe('Item not found in your inventory');
    });

    it('refuses lines of one item that add up to more than a stack', () => {
      state.setItemCount('alice', 'gem', MAX_STACK);
      const result = system.proposeTrade('alice', 'bob',
        [{ itemId: 'gem', quantity: 60 }, { itemId: 'gem', quantity: 60 }], state.hasItemInInventory, state.isBlocked);
      expect(result).toBe(INVALID_TRADE_ITEMS);
    });

    it('refuses malformed lines', () => {
      expect(parseOfferItems('gem')).toBeNull();
      expect(parseOfferItems([null])).toBeNull();
      expect(parseOfferItems([{ itemId: '', quantity: 1 }])).toBeNull();
      expect(parseOfferItems([{ itemId: 7, quantity: 1 }])).toBeNull();
      expect(parseOfferItems([{ itemId: 'gem', quantity: MAX_STACK }])).toEqual([{ itemId: 'gem', quantity: MAX_STACK }]);
    });

    it('drops a saved trade with a fractional line on restore, and logs its id', () => {
      const trade = setupCounteredTrade(system, state);
      const saved = JSON.parse(JSON.stringify(trade)) as TradeState;
      saved.target!.items = [{ itemId: 'shield', quantity: 0.5 }];
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const fresh = new TradeSystem();
      fresh.restoreFromSaveData([saved]);

      expect(fresh.getTrade(trade.id)).toBeNull();
      expect(fresh.getPlayerTrades('alice')).toHaveLength(0);
      expect(fresh.getPlayerTrades('bob')).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(trade.id));
      warn.mockRestore();
    });

    it('keeps a saved trade the target has not countered yet', () => {
      setupReadyPair(state);
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'), state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);

      const fresh = new TradeSystem();
      fresh.restoreFromSaveData(JSON.parse(JSON.stringify(system.getAllTrades())));

      expect(fresh.getTrade(proposed.id)?.target?.items).toEqual([]);
      expect(fresh.getPlayerTrades('bob')).toHaveLength(1);
    });

    it('cancels a stored trade whose line turned fractional when it is confirmed', () => {
      const trade = setupCounteredTrade(system, state);
      system.getTrade(trade.id)!.target!.items = [{ itemId: 'shield', quantity: 1e-20 }];

      const result = system.confirmTrade(trade.id, 'alice', trade.nonce, state.hasItemInInventory, state.getInventoryCount);

      expect(result).toBe(TRADE_NO_LONGER_VALID);
      expect(system.getTrade(trade.id)).toBeNull();
      expect(system.getPlayerTrades('alice')).toHaveLength(0);
      expect(system.getPlayerTrades('bob')).toHaveLength(0);
    });

    it('hands the merged offers to the swap on confirm', () => {
      const trade = setupCounteredTrade(system, state);
      state.giveItem('bob', 'shield');
      system.getTrade(trade.id)!.target!.items = [{ itemId: 'shield', quantity: 1 }, { itemId: 'shield', quantity: 1 }];

      const result = system.confirmTrade(trade.id, 'alice', trade.nonce, state.hasItemInInventory, state.getInventoryCount);

      if (typeof result === 'string' || 'success' in result) throw new Error(String(result));
      expect(result.targetOffer.items).toEqual([{ itemId: 'shield', quantity: 2 }]);
    });
  });

  describe('swapTradeItems', () => {
    function inventory(start: Record<string, number>): TradeInventory & { items: Record<string, number> } {
      const items = { ...start };
      return {
        items,
        removeFromInventory(itemId, quantity) {
          if ((items[itemId] ?? 0) < quantity) return false;
          items[itemId] -= quantity;
          if (items[itemId] === 0) delete items[itemId];
          return true;
        },
        addToInventory(itemId, quantity) {
          if ((items[itemId] ?? 0) + quantity > MAX_STACK) return false;
          items[itemId] = (items[itemId] ?? 0) + quantity;
          return true;
        },
      };
    }

    it('hands each offer to the other side', () => {
      const alice = inventory({ sword: 1, gem: 5 });
      const bob = inventory({ shield: 2 });
      expect(swapTradeItems(alice, [{ itemId: 'gem', quantity: 3 }], bob, [{ itemId: 'shield', quantity: 2 }])).toBeNull();
      expect(alice.items).toEqual({ sword: 1, gem: 2, shield: 2 });
      expect(bob.items).toEqual({ gem: 3 });
    });

    it('undoes every removal and hand-over when the partner\'s stack is full', () => {
      const alice = inventory({ sword: 1, gem: 2 });
      const bob = inventory({ shield: 1, gem: MAX_STACK });
      const result = swapTradeItems(alice,
        [{ itemId: 'sword', quantity: 1 }, { itemId: 'gem', quantity: 2 }], bob, [{ itemId: 'shield', quantity: 1 }]);
      expect(result).toBe('inventory_full');
      expect(alice.items).toEqual({ sword: 1, gem: 2 });
      expect(bob.items).toEqual({ shield: 1, gem: MAX_STACK });
    });

    it('takes back what the partner already received when the confirming side is full', () => {
      const alice = inventory({ sword: 1, shield: MAX_STACK });
      const bob = inventory({ shield: 1 });
      const result = swapTradeItems(alice, [{ itemId: 'sword', quantity: 1 }], bob, [{ itemId: 'shield', quantity: 1 }]);
      expect(result).toBe('inventory_full');
      expect(alice.items).toEqual({ sword: 1, shield: MAX_STACK });
      expect(bob.items).toEqual({ shield: 1 });
    });

    it('puts items back when an offered item is gone', () => {
      const alice = inventory({ sword: 1 });
      const bob = inventory({});
      const result = swapTradeItems(alice, [{ itemId: 'sword', quantity: 1 }], bob, [{ itemId: 'shield', quantity: 1 }]);
      expect(result).toBe('item_missing');
      expect(alice.items).toEqual({ sword: 1 });
      expect(bob.items).toEqual({});
    });
  });

  describe('counterTrade', () => {
    it('locks in target items and moves to countered state', () => {
      setupReadyPair(state);
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);

      const result = system.counterTrade(proposed.id, 'bob', offer('shield'), state.hasItemInInventory);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect(result.status).toBe('countered');
      expect(result.target?.items).toEqual([{ itemId: 'shield', quantity: 1 }]);
      expect(result.lastUpdatedBy).toBe('bob');
    });

    it('lets the initiator update their own offer (stays pending if target empty)', () => {
      setupReadyPair(state);
      state.giveItem('alice', 'axe');
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);

      const updated = system.counterTrade(proposed.id, 'alice', offer('axe'), state.hasItemInInventory);
      expect(typeof updated).not.toBe('string');
      if (typeof updated === 'string') return;
      expect(updated.status).toBe('pending');
      expect(updated.initiator.items).toEqual([{ itemId: 'axe', quantity: 1 }]);
      expect(updated.lastUpdatedBy).toBe('alice');
    });

    it('rejects when trade not found', () => {
      const result = system.counterTrade('nope', 'bob', offer('shield'), state.hasItemInInventory);
      expect(result).toBe('Trade not found');
    });

    it('rejects when actor is not a participant', () => {
      setupReadyPair(state);
      state.giveItem('charlie', 'item');
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);

      const result = system.counterTrade(proposed.id, 'charlie', offer('item'), state.hasItemInInventory);
      expect(result).toBe('Not your trade');
    });

    it('rejects when target lacks the item', () => {
      setupReadyPair(state);
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);

      const result = system.counterTrade(proposed.id, 'bob', offer('nope'), state.hasItemInInventory);
      expect(result).toBe('Item not found in your inventory');
    });

    it('allows back-and-forth countering after countered state is reached', () => {
      const trade = setupCounteredTrade(system, state);
      state.giveItem('alice', 'axe');

      const updated = system.counterTrade(trade.id, 'alice', offer('axe'), state.hasItemInInventory);
      expect(typeof updated).not.toBe('string');
      if (typeof updated === 'string') return;
      expect(updated.lastUpdatedBy).toBe('alice');
      expect(updated.initiator.items).toEqual([{ itemId: 'axe', quantity: 1 }]);
      expect(updated.status).toBe('countered'); // both still have offers
    });
  });

  describe('confirmTrade', () => {
    it('confirms when the partner just acted', () => {
      const trade = setupCounteredTrade(system, state);
      // alice can confirm because bob was the last to update (the counter)
      const result = system.confirmTrade(trade.id, 'alice', trade.nonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect('success' in result).toBe(false);
      if ('success' in result) return;
      expect(result.trade.status).toBe('confirmed');
      expect(result.initiatorOffer.username).toBe('alice');
      expect(result.targetOffer.username).toBe('bob');
    });

    it('rejects when player tries to confirm their own latest action', () => {
      const trade = setupCounteredTrade(system, state);
      // bob counter-ed last; bob can't confirm
      const result = system.confirmTrade(trade.id, 'bob', trade.nonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe('Waiting for the other player to confirm');
    });

    it('rejects when trade is still pending (not countered)', () => {
      setupReadyPair(state);
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);

      const result = system.confirmTrade(proposed.id, 'alice', proposed.nonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe('Both players must offer items before confirming');
    });

    it('rejects when actor is not a participant', () => {
      const trade = setupCounteredTrade(system, state);
      const result = system.confirmTrade(trade.id, 'charlie', trade.nonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe('Not your trade');
    });

    it('rejects when offered item is gone at confirm time', () => {
      const trade = setupCounteredTrade(system, state);
      state.takeItem('alice', 'sword');
      const result = system.confirmTrade(trade.id, 'alice', trade.nonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe('An offered item is no longer in inventory');
    });

    it('rejects (and leaves trade open) when stack would overflow', () => {
      const trade = setupCounteredTrade(system, state);
      // Alice already has 99 shields → can't accept 1 more
      state.setItemCount('alice', 'shield', 99);
      const result = system.confirmTrade(trade.id, 'alice', trade.nonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect('success' in result).toBe(true);
      if (!('success' in result)) return;
      expect(result.success).toBe(false);
      expect(result.affectedPlayer).toBe('initiator');

      // Trade should still exist
      expect(system.getTrade(trade.id)?.status).toBe('countered');
    });

    it('cleans up trade indexes after confirmation', () => {
      const trade = setupCounteredTrade(system, state);
      system.confirmTrade(trade.id, 'alice', trade.nonce,
        state.hasItemInInventory, state.getInventoryCount);

      expect(system.getTrade(trade.id)).toBeNull();
      expect(system.getPlayerTrades('alice')).toHaveLength(0);
      expect(system.getPlayerTrades('bob')).toHaveLength(0);
    });
  });

  describe('confirm nonce (replay / offer-swap protection)', () => {
    it('mints a nonce on propose', () => {
      setupReadyPair(state);
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);
      expect(typeof proposed.nonce).toBe('string');
      expect(proposed.nonce.length).toBeGreaterThan(0);
    });

    it('rotates the nonce on every counter', () => {
      setupReadyPair(state);
      state.giveItem('bob', 'pebble');
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);
      const n0 = `${proposed.nonce}`;

      const c1 = system.counterTrade(proposed.id, 'bob', offer('shield'), state.hasItemInInventory);
      if (typeof c1 === 'string') throw new Error(c1);
      // counterTrade returns the live trade object — snapshot the string, don't alias it.
      const n1 = c1.nonce;
      expect(n1).not.toBe(n0);

      const c2 = system.counterTrade(proposed.id, 'bob', offer('pebble'), state.hasItemInInventory);
      if (typeof c2 === 'string') throw new Error(c2);
      expect(c2.nonce).not.toBe(n1);
    });

    it('rejects a confirm for an offer that was swapped after the player saw it', () => {
      // The exploit the nonce closes: bob baits alice with a good offer, then
      // swaps in a worthless one while her confirm is in flight. `lastUpdatedBy`
      // is still 'bob' after the swap, so that check alone would let it through.
      const trade = setupCounteredTrade(system, state);
      const seenNonce = trade.nonce;

      state.giveItem('bob', 'pebble');
      const swapped = system.counterTrade(trade.id, 'bob', offer('pebble'), state.hasItemInInventory);
      if (typeof swapped === 'string') throw new Error(swapped);
      expect(swapped.lastUpdatedBy).toBe('bob'); // the old guard still passes

      const result = system.confirmTrade(trade.id, 'alice', seenNonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe(TRADE_NONCE_MISMATCH);

      // Nothing was swapped and the trade stays open so alice can re-read it.
      expect(system.getTrade(trade.id)?.status).toBe('countered');
      expect(system.getTrade(trade.id)?.target?.items).toEqual([{ itemId: 'pebble', quantity: 1 }]);
    });

    it('accepts the confirm once the player re-reads the swapped offer', () => {
      const trade = setupCounteredTrade(system, state);
      state.giveItem('bob', 'pebble');
      const swapped = system.counterTrade(trade.id, 'bob', offer('pebble'), state.hasItemInInventory);
      if (typeof swapped === 'string') throw new Error(swapped);

      const result = system.confirmTrade(trade.id, 'alice', swapped.nonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(typeof result).not.toBe('string');
    });

    // Note: it is the post-confirm cleanup, not the nonce, that catches this one —
    // the trade is gone. The nonce is what catches a replay against a trade that
    // still exists (next test). Both are asserted so neither guard can regress
    // silently.
    it('rejects a replayed confirm frame after the trade completed', () => {
      const trade = setupCounteredTrade(system, state);
      const capturedId = trade.id;
      const capturedNonce = trade.nonce;

      const first = system.confirmTrade(capturedId, 'alice', capturedNonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(typeof first).not.toBe('string');

      // Same frame, sent twice — the trade is gone, so there is nothing to re-run.
      const replay = system.confirmTrade(capturedId, 'alice', capturedNonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(replay).toBe('Trade not found');
    });

    it('rejects a replayed confirm against a fresh trade with the same partner', () => {
      const trade = setupCounteredTrade(system, state);
      const capturedNonce = trade.nonce;
      system.cancelTrade(trade.id, 'alice');

      // New trade, same pair, same items — the captured nonce must not carry over.
      const next = setupCounteredTrade(system, state);
      const result = system.confirmTrade(next.id, 'alice', capturedNonce,
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe(TRADE_NONCE_MISMATCH);
    });

    it('rejects a confirm with a missing or garbage nonce', () => {
      const trade = setupCounteredTrade(system, state);
      expect(system.confirmTrade(trade.id, 'alice', '',
        state.hasItemInInventory, state.getInventoryCount)).toBe(TRADE_NONCE_MISMATCH);
      expect(system.confirmTrade(trade.id, 'alice', 'not-a-real-nonce',
        state.hasItemInInventory, state.getInventoryCount)).toBe(TRADE_NONCE_MISMATCH);
      expect(system.getTrade(trade.id)?.status).toBe('countered');
    });

    it('does not let a non-participant probe nonces', () => {
      const trade = setupCounteredTrade(system, state);
      // Same error whether the outsider guesses right or wrong.
      expect(system.confirmTrade(trade.id, 'charlie', trade.nonce,
        state.hasItemInInventory, state.getInventoryCount)).toBe('Not your trade');
      expect(system.confirmTrade(trade.id, 'charlie', 'wrong',
        state.hasItemInInventory, state.getInventoryCount)).toBe('Not your trade');
    });

    it('backfills a nonce for trades persisted before nonces existed', () => {
      const trade = setupCounteredTrade(system, state);
      const legacy = JSON.parse(JSON.stringify(trade)) as TradeState & { nonce?: string };
      delete legacy.nonce;

      const restored = new TradeSystem();
      restored.restoreFromSaveData([legacy as TradeState]);

      const live = restored.getTrade(trade.id);
      expect(typeof live?.nonce).toBe('string');
      expect(live?.nonce.length).toBeGreaterThan(0);

      // The backfilled nonce is the one that works.
      expect(restored.confirmTrade(trade.id, 'alice', '',
        state.hasItemInInventory, state.getInventoryCount)).toBe(TRADE_NONCE_MISMATCH);
      expect(typeof restored.confirmTrade(trade.id, 'alice', live!.nonce,
        state.hasItemInInventory, state.getInventoryCount)).not.toBe('string');
    });

    it('preserves the nonce across a normal save/restore round trip', () => {
      const trade = setupCounteredTrade(system, state);
      const restored = new TradeSystem();
      restored.restoreFromSaveData(JSON.parse(JSON.stringify(system.getAllTrades())));
      expect(restored.getTrade(trade.id)?.nonce).toBe(trade.nonce);
    });
  });

  describe('cancelTrade', () => {
    it('cancels an active trade by either participant', () => {
      const trade = setupCounteredTrade(system, state);
      const cancelled = system.cancelTrade(trade.id, 'bob', 'changed mind');
      expect(cancelled?.status).toBe('cancelled');
      expect(cancelled?.cancelReason).toBe('changed mind');
      expect(system.getTrade(trade.id)).toBeNull();
    });

    it('returns null for non-participant', () => {
      const trade = setupCounteredTrade(system, state);
      const cancelled = system.cancelTrade(trade.id, 'charlie');
      expect(cancelled).toBeNull();
    });

    it('returns null when trade does not exist', () => {
      expect(system.cancelTrade('nope', 'alice')).toBeNull();
    });

    it('cancelAllForPlayer cancels every trade involving the user', () => {
      state.giveItem('alice', 'sword');
      state.giveItem('alice', 'axe');
      state.giveItem('bob', 'shield');
      state.giveItem('charlie', 'helm');
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      system.proposeTrade('alice', 'charlie', offer('axe'),
        state.hasItemInInventory, state.isBlocked);

      const cancelled = system.cancelAllForPlayer('alice', 'banned');
      expect(cancelled).toHaveLength(2);
      expect(system.getPlayerTrades('alice')).toHaveLength(0);
      expect(system.getPlayerTrades('bob')).toHaveLength(0);
      expect(system.getPlayerTrades('charlie')).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('restoreFromSaveData rebuilds active trades and indexes', () => {
      const trade = setupCounteredTrade(system, state);
      const saved = system.getAllTrades();
      expect(saved).toHaveLength(1);

      const fresh = new TradeSystem();
      fresh.restoreFromSaveData(saved);

      expect(fresh.getTrade(trade.id)?.status).toBe('countered');
      expect(fresh.getPlayerTrades('alice')).toHaveLength(1);
      expect(fresh.getPlayerTrades('bob')).toHaveLength(1);
    });

    it('skips finished trades on restore', () => {
      const trade = setupCounteredTrade(system, state);
      // Mark as confirmed manually for the test
      const cloned: TradeState = { ...trade, status: 'confirmed' };

      const fresh = new TradeSystem();
      fresh.restoreFromSaveData([cloned]);

      expect(fresh.getTrade(trade.id)).toBeNull();
      expect(fresh.getPlayerTrades('alice')).toHaveLength(0);
    });
  });

  describe('findTradeBetween', () => {
    it('finds an active trade in either direction', () => {
      setupReadyPair(state);
      const t = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof t === 'string') throw new Error(t);

      expect(system.findTradeBetween('alice', 'bob')?.id).toBe(t.id);
      expect(system.findTradeBetween('bob', 'alice')?.id).toBe(t.id);
    });

    it('returns null when no trade between the pair', () => {
      expect(system.findTradeBetween('alice', 'bob')).toBeNull();
    });
  });
});
