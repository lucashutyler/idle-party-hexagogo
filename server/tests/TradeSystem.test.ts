import { describe, it, expect, beforeEach } from 'vitest';
import { TradeSystem } from '../src/game/social/TradeSystem.js';
import type { TradeOfferItem } from '@idle-party-rpg/shared';

// Simple helpers to simulate player state
function createPlayerState() {
  const positions = new Map<string, { col: number; row: number }>();
  const inventories = new Map<string, Map<string, number>>();
  const blocked = new Map<string, Set<string>>();

  return {
    setPosition: (u: string, col: number, row: number) => { positions.set(u, { col, row }); },
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

    // Qty-aware: returns true iff player has >= quantity of itemId
    hasItemInInventory: (u: string, itemId: string, quantity: number = 1) =>
      (inventories.get(u)?.get(itemId) ?? 0) >= quantity,
    getInventoryCount: (u: string, itemId: string) => inventories.get(u)?.get(itemId) ?? 0,
    areSameTile: (a: string, b: string) => {
      const pa = positions.get(a);
      const pb = positions.get(b);
      if (!pa || !pb) return false;
      return pa.col === pb.col && pa.row === pb.row;
    },
    isBlocked: (a: string, b: string) =>
      (blocked.get(a)?.has(b) ?? false) || (blocked.get(b)?.has(a) ?? false),
  };
}

/** Shorthand: build a single-item offer array. */
const offer = (itemId: string, quantity = 1): TradeOfferItem[] => [{ itemId, quantity }];

/** Set up two players ready to trade at the same position with items. */
function setupReadyPair(state: ReturnType<typeof createPlayerState>, itemA = 'sword', itemB = 'shield') {
  state.setPosition('alice', 0, 0);
  state.setPosition('bob', 0, 0);
  state.giveItem('alice', itemA);
  state.giveItem('bob', itemB);
}

/** Convenience: propose + counter so a trade is in 'countered' state. */
function setupCounteredTrade(
  system: TradeSystem,
  state: ReturnType<typeof createPlayerState>,
  itemA = 'sword',
  itemB = 'shield',
) {
  setupReadyPair(state, itemA, itemB);
  const proposed = system.proposeTrade('alice', 'bob', offer(itemA),
    state.hasItemInInventory, state.areSameTile, state.isBlocked);
  if (typeof proposed === 'string') throw new Error(`proposeTrade failed: ${proposed}`);
  const countered = system.counterTrade('bob', offer(itemB),
    state.hasItemInInventory, state.areSameTile);
  if (typeof countered === 'string') throw new Error(`counterTrade failed: ${countered}`);
}

describe('TradeSystem', () => {
  let system: TradeSystem;
  let state: ReturnType<typeof createPlayerState>;

  beforeEach(() => {
    system = new TradeSystem();
    state = createPlayerState();
  });

  // ── proposeTrade ──────────────────────────────────────────────

  describe('proposeTrade', () => {
    it('creates a pending trade when all conditions met', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect(result.status).toBe('pending');
      expect(result.initiator.username).toBe('alice');
      expect(result.initiator.items).toEqual([{ itemId: 'sword', quantity: 1 }]);
      expect(result.target).toBeNull();
    });

    it('rejects trading with yourself', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'alice', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Cannot trade with yourself');
    });

    it('rejects when blocked', () => {
      setupReadyPair(state);
      state.block('alice', 'bob');
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Cannot trade with a blocked user');
    });

    it('rejects when blocked in reverse direction', () => {
      setupReadyPair(state);
      state.block('bob', 'alice');
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Cannot trade with a blocked user');
    });

    it('rejects when not on same tile', () => {
      setupReadyPair(state);
      state.setPosition('bob', 1, 1);
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('You must be in the same room to trade');
    });

    it('rejects when initiator already has a trade', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      state.setPosition('charlie', 0, 0);
      state.giveItem('alice', 'axe');
      const result = system.proposeTrade('alice', 'charlie', offer('axe'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('You already have a pending trade');
    });

    it('rejects when target already has a trade', () => {
      setupReadyPair(state);
      state.setPosition('charlie', 0, 0);
      state.giveItem('charlie', 'axe');
      system.proposeTrade('charlie', 'bob', offer('axe'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('That player already has a pending trade');
    });

    it('rejects when initiator does not have the item', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', offer('nonexistent_item'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Item not found in your inventory');
    });

    it('rejects when proposing more quantity than available', () => {
      setupReadyPair(state); // alice has 1 sword
      const result = system.proposeTrade('alice', 'bob', offer('sword', 2),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Item not found in your inventory');
    });

    it('allows level 1 players to trade', () => {
      // No level requirement — any level is valid
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(typeof result).not.toBe('string');
    });

    it('allows multi-item offers', () => {
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.giveItem('alice', 'sword');
      state.giveItem('alice', 'helmet');
      state.giveItem('bob', 'shield');
      const items: TradeOfferItem[] = [{ itemId: 'sword', quantity: 1 }, { itemId: 'helmet', quantity: 1 }];
      const result = system.proposeTrade('alice', 'bob', items,
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect(result.initiator.items).toHaveLength(2);
    });
  });

  // ── counterTrade ──────────────────────────────────────────────

  describe('counterTrade', () => {
    it('locks in target items and moves to countered state', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.counterTrade('bob', offer('shield'), state.hasItemInInventory, state.areSameTile);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect(result.status).toBe('countered');
      expect(result.target?.username).toBe('bob');
      expect(result.target?.items).toEqual([{ itemId: 'shield', quantity: 1 }]);
    });

    it('rejects when player has no pending trade', () => {
      const result = system.counterTrade('bob', offer('shield'), state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('No pending trade');
    });

    it('rejects when the initiator tries to counter their own trade', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.counterTrade('alice', offer('sword'), state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Only the trade target can offer an item');
    });

    it('rejects when trade is already countered', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', offer('shield'), state.hasItemInInventory, state.areSameTile);

      const result = system.counterTrade('bob', offer('shield'), state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Trade is not awaiting an offer');
    });

    it('rejects when players are no longer on the same tile', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      state.setPosition('bob', 2, 2);

      const result = system.counterTrade('bob', offer('shield'), state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('You are no longer in the same room');
    });

    it('rejects when target does not have the offered item', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.counterTrade('bob', offer('nonexistent_item'), state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Item not found in your inventory');
    });

    it('rejects when counter quantity exceeds inventory', () => {
      setupReadyPair(state); // bob has 1 shield
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      const result = system.counterTrade('bob', offer('shield', 2), state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Item not found in your inventory');
    });
  });

  // ── confirmTrade ──────────────────────────────────────────────

  describe('confirmTrade', () => {
    it('confirms trade and returns both offers', () => {
      setupCounteredTrade(system, state);

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect('success' in result).toBe(false);
      if ('success' in result) return;
      expect(result.trade.status).toBe('confirmed');
      expect(result.initiatorOffer).toEqual({ username: 'alice', items: [{ itemId: 'sword', quantity: 1 }] });
      expect(result.targetOffer).toEqual({ username: 'bob', items: [{ itemId: 'shield', quantity: 1 }] });
    });

    it('cleans up player trade entries after confirm', () => {
      setupCounteredTrade(system, state);
      system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile, state.getInventoryCount);

      expect(system.getPlayerTrade('alice')).toBeNull();
      expect(system.getPlayerTrade('bob')).toBeNull();
    });

    it('rejects when non-initiator tries to confirm', () => {
      setupCounteredTrade(system, state);

      const result = system.confirmTrade('bob',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect(result).toBe('Only the trade initiator can confirm');
    });

    it('rejects when trade is not yet countered', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect(result).toBe('Waiting for the other player to offer an item first');
    });

    it('rejects when initiator item is gone at confirm time', () => {
      setupCounteredTrade(system, state);
      state.takeItem('alice', 'sword');

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect(result).toBe('Your offered item is no longer in your inventory');
    });

    it('rejects when target item is gone at confirm time', () => {
      setupCounteredTrade(system, state);
      state.takeItem('bob', 'shield');

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect(result).toBe('Their offered item is no longer in their inventory');
    });

    it('rejects when players moved apart before confirmation', () => {
      setupCounteredTrade(system, state);
      state.setPosition('bob', 3, 3);

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect(result).toBe('You are no longer in the same room');
    });

    // ── Stack capacity checks ──────────────────────────────────

    it('returns inventory_full failure when initiator has 99 of the incoming item', () => {
      setupCounteredTrade(system, state); // alice offers sword, bob offers shield
      // alice already has 99 shields — cannot receive another
      state.setItemCount('alice', 'shield', 99);

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);

      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect('success' in result).toBe(true);
      if (!('success' in result)) return;
      expect(result.success).toBe(false);
      expect(result.reason).toBe('inventory_full');
      expect(result.affectedPlayer).toBe('initiator');
    });

    it('leaves trade in countered state (not cleaned up) after initiator stack failure', () => {
      setupCounteredTrade(system, state);
      state.setItemCount('alice', 'shield', 99);

      system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile, state.getInventoryCount);

      // Both players should still be mapped to the trade
      expect(system.getPlayerTrade('alice')).not.toBeNull();
      expect(system.getPlayerTrade('bob')).not.toBeNull();
      expect(system.getPlayerTrade('alice')?.status).toBe('countered');
    });

    it('returns inventory_full failure when target has 99 of the incoming item', () => {
      setupCounteredTrade(system, state); // alice offers sword, bob offers shield
      // bob already has 99 swords — cannot receive another
      state.setItemCount('bob', 'sword', 99);

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);

      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect('success' in result).toBe(true);
      if (!('success' in result)) return;
      expect(result.success).toBe(false);
      expect(result.reason).toBe('inventory_full');
      expect(result.affectedPlayer).toBe('target');
    });

    it('leaves trade in countered state (not cleaned up) after target stack failure', () => {
      setupCounteredTrade(system, state);
      state.setItemCount('bob', 'sword', 99);

      system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile, state.getInventoryCount);

      expect(system.getPlayerTrade('alice')).not.toBeNull();
      expect(system.getPlayerTrade('bob')).not.toBeNull();
    });

    it('allows confirm when both sides trade the same item (net zero, no stack issue)', () => {
      // Both offer 'pelt' — net change for each is 0 regardless of current stack
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.giveItem('alice', 'pelt');
      state.giveItem('bob', 'pelt');
      state.setItemCount('alice', 'pelt', 99); // already at max
      state.setItemCount('bob', 'pelt', 99);

      system.proposeTrade('alice', 'bob', offer('pelt'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', offer('pelt'), state.hasItemInInventory, state.areSameTile);

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);

      // Should succeed — giving and receiving the same item is a net-zero stack change
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect('success' in result).toBe(false);
    });

    it('allows confirm at 98 stacks (room for one more)', () => {
      setupCounteredTrade(system, state);
      state.setItemCount('alice', 'shield', 98); // room for one more
      state.setItemCount('bob', 'sword', 98);

      const result = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);

      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect('success' in result).toBe(false);
    });
  });

  // ── cancelTrade ──────────────────────────────────────────────

  describe('cancelTrade', () => {
    it('cancels a pending trade', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.cancelTrade('alice');
      expect(result?.status).toBe('cancelled');
    });

    it('allows either party to cancel', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.cancelTrade('bob');
      expect(result?.status).toBe('cancelled');
    });

    it('stores a cancel reason when provided', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.cancelTrade('alice', 'Player moved');
      expect(result?.cancelReason).toBe('Player moved');
    });

    it('returns null if player has no active trade', () => {
      const result = system.cancelTrade('alice');
      expect(result).toBeNull();
    });

    it('cleans up both players after cancel', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      system.cancelTrade('alice');
      expect(system.getPlayerTrade('alice')).toBeNull();
      expect(system.getPlayerTrade('bob')).toBeNull();
    });

    it('can cancel a countered trade', () => {
      setupCounteredTrade(system, state);

      const result = system.cancelTrade('alice');
      expect(result?.status).toBe('cancelled');
      expect(system.getPlayerTrade('bob')).toBeNull();
    });
  });

  // ── getTradePartner ──────────────────────────────────────────

  describe('getTradePartner', () => {
    it('returns partner username for initiator', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      expect(system.getTradePartner('alice')).toBe('bob');
    });

    it('returns partner username for target', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', offer('sword'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);

      expect(system.getTradePartner('bob')).toBe('alice');
    });

    it('returns null when no active trade', () => {
      expect(system.getTradePartner('alice')).toBeNull();
    });
  });

  // ── full trade flow ───────────────────────────────────────────

  describe('full trade flow', () => {
    it('completes a trade end-to-end', () => {
      setupCounteredTrade(system, state);

      const confirmed = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect(typeof confirmed).not.toBe('string');
      if (typeof confirmed === 'string') return;
      expect('success' in confirmed).toBe(false);
      if ('success' in confirmed) return;

      expect(confirmed.initiatorOffer).toEqual({ username: 'alice', items: [{ itemId: 'sword', quantity: 1 }] });
      expect(confirmed.targetOffer).toEqual({ username: 'bob', items: [{ itemId: 'shield', quantity: 1 }] });

      // Both players free to trade again
      expect(system.getPlayerTrade('alice')).toBeNull();
      expect(system.getPlayerTrade('bob')).toBeNull();
    });

    it('allows players to trade again after a trade completes', () => {
      setupCounteredTrade(system, state, 'sword', 'shield');
      system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile, state.getInventoryCount);

      // Give both new items and trade again
      state.giveItem('alice', 'axe');
      state.giveItem('bob', 'helmet');

      const result = system.proposeTrade('alice', 'bob', offer('axe'),
        state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(typeof result).not.toBe('string');
    });

    it('allows trade to proceed after a stack failure once inventory is freed', () => {
      setupCounteredTrade(system, state); // alice: sword, bob: shield
      state.setItemCount('alice', 'shield', 99); // alice full on shields

      // First confirm attempt fails
      const fail = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect('success' in fail).toBe(true);

      // Alice frees a slot (conceptually — simulate by dropping to 98)
      state.setItemCount('alice', 'shield', 98);

      // Second confirm attempt succeeds
      const ok = system.confirmTrade('alice',
        state.hasItemInInventory, state.areSameTile, state.getInventoryCount);
      expect(typeof ok).not.toBe('string');
      if (typeof ok === 'string') return;
      expect('success' in ok).toBe(false);
    });
  });
});
