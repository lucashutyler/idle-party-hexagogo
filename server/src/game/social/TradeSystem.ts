import type { TradeState, TradeOffer } from '@idle-party-rpg/shared';

/**
 * TradeSystem manages peer-to-peer item trades.
 *
 * Trade lifecycle:
 *   pending   — initiator proposed with an item; waiting for target to counter
 *   countered — target accepted and locked in their own item; waiting for initiator to confirm
 *   confirmed — initiator confirmed; caller executes the atomic item swap
 *   cancelled — any cancellation (moved tiles, disconnected, explicit cancel)
 *
 * Rules:
 *   - Both players must be level 5+
 *   - Both players must be on the same tile
 *   - Both players offer exactly one unequipped inventory item
 *   - A player can only have one pending trade at a time
 *   - Blocked users cannot trade with each other
 *   - Trades cancel automatically on movement or disconnect (wired by PlayerManager)
 *
 * NOTE: Trade state is intentionally NOT persisted across server restarts.
 * All active trades are cancelled on disconnect. Do not add trade state to PlayerSaveData.
 *
 * This class is pure stateful logic — no WebSocket sends, no file I/O.
 * PlayerManager wires everything together.
 */

let tradeIdCounter = 0;

function generateTradeId(): string {
  return `trade_${Date.now()}_${++tradeIdCounter}`;
}

export class TradeSystem {
  /** All active trades by trade ID. */
  private trades = new Map<string, TradeState>();

  /** Quick lookup: username → trade ID (max one active trade per player). */
  private playerTrade = new Map<string, string>();

  /**
   * Propose a trade. Returns the new TradeState or an error string.
   *
   * Validates:
   * - Not trading with self
   * - Neither player is blocked by the other
   * - Both players are level 5+
   * - Both players are on the same tile
   * - Neither player has an existing pending trade
   * - The item exists in the initiator's inventory (unequipped items only — equipped items
   *   are removed from inventory, so inventory[itemId] > 0 implies it is not equipped)
   */
  proposeTrade(
    initiatorUsername: string,
    targetUsername: string,
    itemId: string,
    getPlayerLevel: (u: string) => number | null,
    hasItemInInventory: (u: string, itemId: string) => boolean,
    areSameTile: (a: string, b: string) => boolean,
    isBlocked: (a: string, b: string) => boolean,
  ): TradeState | string {
    if (initiatorUsername === targetUsername) return 'Cannot trade with yourself';
    if (isBlocked(initiatorUsername, targetUsername)) return 'Cannot trade with a blocked user';

    const initiatorLevel = getPlayerLevel(initiatorUsername);
    if (initiatorLevel === null) return 'Player not found';
    if (initiatorLevel < 5) return 'You must be level 5 or higher to trade';

    const targetLevel = getPlayerLevel(targetUsername);
    if (targetLevel === null) return 'Target player not found';
    if (targetLevel < 5) return 'That player must be level 5 or higher to trade';

    if (!areSameTile(initiatorUsername, targetUsername)) return 'You must be in the same room to trade';

    if (this.playerTrade.has(initiatorUsername)) return 'You already have a pending trade';
    if (this.playerTrade.has(targetUsername)) return 'That player already has a pending trade';

    if (!hasItemInInventory(initiatorUsername, itemId)) return 'Item not found in your inventory';

    const id = generateTradeId();
    const trade: TradeState = {
      id,
      status: 'pending',
      initiator: { username: initiatorUsername, itemId },
      target: null,
      timestamp: Date.now(),
    };

    this.trades.set(id, trade);
    this.playerTrade.set(initiatorUsername, id);
    this.playerTrade.set(targetUsername, id);

    return trade;
  }

  /**
   * Counter a trade (target locks in their own item offer).
   * Moves trade from 'pending' → 'countered'.
   * Returns updated TradeState or an error string.
   */
  counterTrade(
    targetUsername: string,
    itemId: string,
    hasItemInInventory: (u: string, itemId: string) => boolean,
    areSameTile: (a: string, b: string) => boolean,
  ): TradeState | string {
    const tradeId = this.playerTrade.get(targetUsername);
    if (!tradeId) return 'No pending trade';

    const trade = this.trades.get(tradeId);
    if (!trade) return 'Trade not found';
    if (trade.initiator.username === targetUsername) return 'Only the trade target can offer an item';
    if (trade.status !== 'pending') return 'Trade is not awaiting an offer';

    if (!areSameTile(trade.initiator.username, targetUsername)) return 'You are no longer in the same room';
    if (!hasItemInInventory(targetUsername, itemId)) return 'Item not found in your inventory';

    trade.target = { username: targetUsername, itemId };
    trade.status = 'countered';

    return trade;
  }

  /**
   * Confirm a trade (initiator confirms after seeing the target's offer).
   * Re-validates item presence for both players at confirm time.
   * Returns { trade, initiatorOffer, targetOffer } on success, or an error string.
   * The caller is responsible for executing the atomic item swap.
   */
  confirmTrade(
    initiatorUsername: string,
    hasItemInInventory: (u: string, itemId: string) => boolean,
    areSameTile: (a: string, b: string) => boolean,
  ): { trade: TradeState; initiatorOffer: TradeOffer; targetOffer: TradeOffer } | string {
    const tradeId = this.playerTrade.get(initiatorUsername);
    if (!tradeId) return 'No pending trade';

    const trade = this.trades.get(tradeId);
    if (!trade) return 'Trade not found';
    if (trade.initiator.username !== initiatorUsername) return 'Only the trade initiator can confirm';
    if (trade.status !== 'countered') return 'Waiting for the other player to offer an item first';
    if (!trade.target) return 'Trade has no target offer';

    // Re-validate same tile at confirm time (not just at propose time)
    if (!areSameTile(initiatorUsername, trade.target.username)) return 'You are no longer in the same room';

    // Re-validate item presence at confirm time (not just at propose time)
    if (!hasItemInInventory(initiatorUsername, trade.initiator.itemId)) {
      return 'Your offered item is no longer in your inventory';
    }
    if (!hasItemInInventory(trade.target.username, trade.target.itemId)) {
      return 'Their offered item is no longer in their inventory';
    }

    const initiatorOffer: TradeOffer = { ...trade.initiator };
    const targetOffer: TradeOffer = { ...trade.target };

    trade.status = 'confirmed';
    this.cleanupTrade(tradeId);

    return { trade, initiatorOffer, targetOffer };
  }

  /**
   * Cancel a trade. Either player can cancel at any stage.
   * Returns the cancelled TradeState, or null if the player had no active trade.
   */
  cancelTrade(username: string, reason?: string): TradeState | null {
    const tradeId = this.playerTrade.get(username);
    if (!tradeId) return null;

    const trade = this.trades.get(tradeId);
    if (!trade) {
      this.playerTrade.delete(username);
      return null;
    }

    trade.status = 'cancelled';
    if (reason) trade.cancelReason = reason;

    this.cleanupTrade(tradeId);

    return trade;
  }

  /**
   * Get the other player in this trade (the one who is not the given username).
   * Returns null if no active trade or the trade has no known other party.
   */
  getTradePartner(username: string): string | null {
    const trade = this.getPlayerTrade(username);
    if (!trade) return null;
    if (trade.initiator.username === username) {
      return trade.target?.username ?? null;
    }
    return trade.initiator.username;
  }

  /** Get the active trade for a player, or null if none. */
  getPlayerTrade(username: string): TradeState | null {
    const tradeId = this.playerTrade.get(username);
    if (!tradeId) return null;
    return this.trades.get(tradeId) ?? null;
  }

  private cleanupTrade(tradeId: string): void {
    const trade = this.trades.get(tradeId);
    if (trade) {
      this.playerTrade.delete(trade.initiator.username);
      if (trade.target) {
        this.playerTrade.delete(trade.target.username);
      }
    }
    this.trades.delete(tradeId);
  }
}
