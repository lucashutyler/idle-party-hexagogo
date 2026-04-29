import { describe, it, expect, beforeEach } from 'vitest';
import { TradeSystem } from '../src/game/social/TradeSystem.js';
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
      expect(result).toBe('Must offer at least one item');
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
      const result = system.confirmTrade(trade.id, 'alice',
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
      const result = system.confirmTrade(trade.id, 'bob',
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe('Waiting for the other player to confirm');
    });

    it('rejects when trade is still pending (not countered)', () => {
      setupReadyPair(state);
      const proposed = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.isBlocked);
      if (typeof proposed === 'string') throw new Error(proposed);

      const result = system.confirmTrade(proposed.id, 'alice',
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe('Both players must offer items before confirming');
    });

    it('rejects when actor is not a participant', () => {
      const trade = setupCounteredTrade(system, state);
      const result = system.confirmTrade(trade.id, 'charlie',
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe('Not your trade');
    });

    it('rejects when offered item is gone at confirm time', () => {
      const trade = setupCounteredTrade(system, state);
      state.takeItem('alice', 'sword');
      const result = system.confirmTrade(trade.id, 'alice',
        state.hasItemInInventory, state.getInventoryCount);
      expect(result).toBe('An offered item is no longer in inventory');
    });

    it('rejects (and leaves trade open) when stack would overflow', () => {
      const trade = setupCounteredTrade(system, state);
      // Alice already has 99 shields → can't accept 1 more
      state.setItemCount('alice', 'shield', 99);
      const result = system.confirmTrade(trade.id, 'alice',
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
      system.confirmTrade(trade.id, 'alice',
        state.hasItemInInventory, state.getInventoryCount);

      expect(system.getTrade(trade.id)).toBeNull();
      expect(system.getPlayerTrades('alice')).toHaveLength(0);
      expect(system.getPlayerTrades('bob')).toHaveLength(0);
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
