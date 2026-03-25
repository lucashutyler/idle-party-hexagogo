import { describe, it, expect, beforeEach } from 'vitest';
import { TradeSystem } from '../src/game/social/TradeSystem.js';

// Simple helpers to simulate player state
function createPlayerState() {
  const levels = new Map<string, number>();
  const positions = new Map<string, { col: number; row: number }>();
  const inventories = new Map<string, Set<string>>();
  const blocked = new Map<string, Set<string>>();

  return {
    setLevel: (u: string, level: number) => { levels.set(u, level); },
    setPosition: (u: string, col: number, row: number) => { positions.set(u, { col, row }); },
    giveItem: (u: string, itemId: string) => {
      if (!inventories.has(u)) inventories.set(u, new Set());
      inventories.get(u)!.add(itemId);
    },
    takeItem: (u: string, itemId: string) => {
      inventories.get(u)?.delete(itemId);
    },
    block: (a: string, b: string) => {
      if (!blocked.has(a)) blocked.set(a, new Set());
      blocked.get(a)!.add(b);
    },

    getPlayerLevel: (u: string) => levels.get(u) ?? null,
    hasItemInInventory: (u: string, itemId: string) => inventories.get(u)?.has(itemId) ?? false,
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

/** Set up two players ready to trade at the same position with items. */
function setupReadyPair(state: ReturnType<typeof createPlayerState>, itemA = 'sword', itemB = 'shield') {
  state.setLevel('alice', 5);
  state.setLevel('bob', 5);
  state.setPosition('alice', 0, 0);
  state.setPosition('bob', 0, 0);
  state.giveItem('alice', itemA);
  state.giveItem('bob', itemB);
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
      const result = system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect(result.status).toBe('pending');
      expect(result.initiator.username).toBe('alice');
      expect(result.initiator.itemId).toBe('sword');
      expect(result.target).toBeNull();
    });

    it('rejects trading with yourself', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'alice', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Cannot trade with yourself');
    });

    it('rejects when blocked', () => {
      setupReadyPair(state);
      state.block('alice', 'bob');
      const result = system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Cannot trade with a blocked user');
    });

    it('rejects when blocked in reverse direction', () => {
      setupReadyPair(state);
      state.block('bob', 'alice');
      const result = system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Cannot trade with a blocked user');
    });

    it('rejects when initiator is below level 5', () => {
      setupReadyPair(state);
      state.setLevel('alice', 4);
      const result = system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('You must be level 5 or higher to trade');
    });

    it('rejects when target is below level 5', () => {
      setupReadyPair(state);
      state.setLevel('bob', 4);
      const result = system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('That player must be level 5 or higher to trade');
    });

    it('rejects when not on same tile', () => {
      setupReadyPair(state);
      state.setPosition('bob', 1, 1);
      const result = system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('You must be in the same room to trade');
    });

    it('rejects when initiator already has a trade', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      state.setLevel('charlie', 5);
      state.setPosition('charlie', 0, 0);
      state.giveItem('alice', 'axe');
      const result = system.proposeTrade('alice', 'charlie', 'axe',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('You already have a pending trade');
    });

    it('rejects when target already has a trade', () => {
      setupReadyPair(state);
      state.setLevel('charlie', 5);
      state.setPosition('charlie', 0, 0);
      state.giveItem('charlie', 'axe');
      // bob is already involved in a trade with charlie
      system.proposeTrade('charlie', 'bob', 'axe',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      const result = system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('That player already has a pending trade');
    });

    it('rejects when initiator does not have the item', () => {
      setupReadyPair(state);
      const result = system.proposeTrade('alice', 'bob', 'nonexistent_item',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(result).toBe('Item not found in your inventory');
    });
  });

  // ── counterTrade ──────────────────────────────────────────────

  describe('counterTrade', () => {
    it('locks in target item and moves to countered state', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect(result.status).toBe('countered');
      expect(result.target?.username).toBe('bob');
      expect(result.target?.itemId).toBe('shield');
    });

    it('rejects when player has no pending trade', () => {
      const result = system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('No pending trade');
    });

    it('rejects when the initiator tries to counter their own trade', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.counterTrade('alice', 'sword', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Only the trade target can offer an item');
    });

    it('rejects when trade is already countered', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);

      const result = system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Trade is not awaiting an offer');
    });

    it('rejects when players are no longer on the same tile', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      state.setPosition('bob', 2, 2);

      const result = system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('You are no longer in the same room');
    });

    it('rejects when target does not have the offered item', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.counterTrade('bob', 'nonexistent_item', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Item not found in your inventory');
    });
  });

  // ── confirmTrade ──────────────────────────────────────────────

  describe('confirmTrade', () => {
    it('confirms trade and returns both offers', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);

      const result = system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;
      expect(result.trade.status).toBe('confirmed');
      expect(result.initiatorOffer).toEqual({ username: 'alice', itemId: 'sword' });
      expect(result.targetOffer).toEqual({ username: 'bob', itemId: 'shield' });
    });

    it('cleans up player trade entries after confirm', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile);

      expect(system.getPlayerTrade('alice')).toBeNull();
      expect(system.getPlayerTrade('bob')).toBeNull();
    });

    it('rejects when non-initiator tries to confirm', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);

      const result = system.confirmTrade('bob', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Only the trade initiator can confirm');
    });

    it('rejects when trade is not yet countered', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Waiting for the other player to offer an item first');
    });

    it('rejects when initiator item is gone at confirm time', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      state.takeItem('alice', 'sword'); // Item removed after proposing

      const result = system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Your offered item is no longer in your inventory');
    });

    it('rejects when target item is gone at confirm time', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      state.takeItem('bob', 'shield'); // Item removed after countering

      const result = system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('Their offered item is no longer in their inventory');
    });

    it('rejects when players moved apart before confirmation', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      state.setPosition('bob', 3, 3);

      const result = system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile);
      expect(result).toBe('You are no longer in the same room');
    });
  });

  // ── cancelTrade ──────────────────────────────────────────────

  describe('cancelTrade', () => {
    it('cancels a pending trade', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.cancelTrade('alice');
      expect(result?.status).toBe('cancelled');
    });

    it('allows either party to cancel', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.cancelTrade('bob');
      expect(result?.status).toBe('cancelled');
    });

    it('stores a cancel reason when provided', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      const result = system.cancelTrade('alice', 'Player moved');
      expect(result?.cancelReason).toBe('Player moved');
    });

    it('returns null if player has no active trade', () => {
      const result = system.cancelTrade('alice');
      expect(result).toBeNull();
    });

    it('cleans up both players after cancel', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      system.cancelTrade('alice');
      expect(system.getPlayerTrade('alice')).toBeNull();
      expect(system.getPlayerTrade('bob')).toBeNull();
    });

    it('can cancel a countered trade', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);

      const result = system.cancelTrade('alice');
      expect(result?.status).toBe('cancelled');
      expect(system.getPlayerTrade('bob')).toBeNull();
    });
  });

  // ── getTradePartner ──────────────────────────────────────────

  describe('getTradePartner', () => {
    it('returns partner username for initiator', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      expect(system.getTradePartner('alice')).toBe('bob');
    });

    it('returns partner username for target', () => {
      setupReadyPair(state);
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);

      expect(system.getTradePartner('bob')).toBe('alice');
    });

    it('returns null when no active trade', () => {
      expect(system.getTradePartner('alice')).toBeNull();
    });
  });

  // ── full trade flow ───────────────────────────────────────────

  describe('full trade flow', () => {
    it('completes a trade end-to-end', () => {
      setupReadyPair(state);

      // Alice proposes
      const proposed = system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(typeof proposed).not.toBe('string');

      // Bob counters
      const countered = system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      expect(typeof countered).not.toBe('string');

      // Alice confirms
      const confirmed = system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile);
      expect(typeof confirmed).not.toBe('string');
      if (typeof confirmed === 'string') return;

      expect(confirmed.initiatorOffer).toEqual({ username: 'alice', itemId: 'sword' });
      expect(confirmed.targetOffer).toEqual({ username: 'bob', itemId: 'shield' });

      // Both players free to trade again
      expect(system.getPlayerTrade('alice')).toBeNull();
      expect(system.getPlayerTrade('bob')).toBeNull();
    });

    it('allows players to trade again after a trade completes', () => {
      setupReadyPair(state);
      state.giveItem('alice', 'axe');
      state.giveItem('bob', 'helmet');

      // First trade
      system.proposeTrade('alice', 'bob', 'sword',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      system.counterTrade('bob', 'shield', state.hasItemInInventory, state.areSameTile);
      system.confirmTrade('alice', state.hasItemInInventory, state.areSameTile);

      // Second trade (same players, different items)
      const result = system.proposeTrade('alice', 'bob', 'axe',
        state.getPlayerLevel, state.hasItemInInventory, state.areSameTile, state.isBlocked);
      expect(typeof result).not.toBe('string');
    });
  });
});
