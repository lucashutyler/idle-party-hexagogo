import type { TradeState, TradeOffer, TradeOfferItem } from '@idle-party-rpg/shared';
import { MAX_STACK } from '@idle-party-rpg/shared';

/**
 * TradeSystem manages peer-to-peer item trades.
 *
 * Trade lifecycle:
 *   pending   — initiator proposed items; waiting for target to counter
 *   countered — target locked in their items; waiting for initiator to confirm
 *   confirmed — initiator confirmed; caller executes the atomic item swap
 *   cancelled — any cancellation (moved tiles, disconnected, explicit cancel)
 *
 * Rules:
 *   - Both players must be on the same tile
 *   - Each player offers at least one unequipped inventory item (with quantities)
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

export type ConfirmTradeFailure = { success: false; reason: string; affectedPlayer: 'initiator' | 'target' };

export class TradeSystem {
  /** All active trades by trade ID. */
  private trades = new Map<string, TradeState>();

  /** Quick lookup: username → trade ID (max one active trade per player). */
  private playerTrade = new Map<string, string>();

  /**
   * Propose a trade. Returns the new TradeState or an error string.
   *
   * `hasItemInInventory(username, itemId, quantity)` must return true iff the player
   * has at least `quantity` of `itemId` in their unequipped inventory.
   */
  proposeTrade(
    initiatorUsername: string,
    targetUsername: string,
    items: TradeOfferItem[],
    hasItemInInventory: (u: string, itemId: string, quantity: number) => boolean,
    areSameTile: (a: string, b: string) => boolean,
    isBlocked: (a: string, b: string) => boolean,
  ): TradeState | string {
    if (initiatorUsername === targetUsername) return 'Cannot trade with yourself';
    if (isBlocked(initiatorUsername, targetUsername)) return 'Cannot trade with a blocked user';
    if (!areSameTile(initiatorUsername, targetUsername)) return 'You must be in the same room to trade';
    if (this.playerTrade.has(initiatorUsername)) return 'You already have a pending trade';
    if (this.playerTrade.has(targetUsername)) return 'That player already has a pending trade';

    if (!Array.isArray(items) || items.length === 0) return 'Must offer at least one item';
    for (const { itemId, quantity } of items) {
      if (!hasItemInInventory(initiatorUsername, itemId, quantity)) {
        return 'Item not found in your inventory';
      }
    }

    const id = generateTradeId();
    const trade: TradeState = {
      id,
      status: 'pending',
      initiator: { username: initiatorUsername, items },
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
    items: TradeOfferItem[],
    hasItemInInventory: (u: string, itemId: string, quantity: number) => boolean,
    areSameTile: (a: string, b: string) => boolean,
  ): TradeState | string {
    const tradeId = this.playerTrade.get(targetUsername);
    if (!tradeId) return 'No pending trade';

    const trade = this.trades.get(tradeId);
    if (!trade) return 'Trade not found';
    if (trade.initiator.username === targetUsername) return 'Only the trade target can offer an item';
    if (trade.status !== 'pending') return 'Trade is not awaiting an offer';

    if (!areSameTile(trade.initiator.username, targetUsername)) return 'You are no longer in the same room';

    if (!Array.isArray(items) || items.length === 0) return 'Must offer at least one item';
    for (const { itemId, quantity } of items) {
      if (!hasItemInInventory(targetUsername, itemId, quantity)) {
        return 'Item not found in your inventory';
      }
    }

    trade.target = { username: targetUsername, items };
    trade.status = 'countered';

    return trade;
  }

  /**
   * Confirm a trade (initiator confirms after seeing the target's offer).
   * Re-validates item presence and stack capacity for both players at confirm time.
   *
   * Stack check uses net change per itemId (same itemId in both offers partially cancel out).
   *
   * Returns:
   *   - `{ trade, initiatorOffer, targetOffer }` on success — caller executes the atomic item swap
   *   - `ConfirmTradeFailure` if either player's inventory cannot accept incoming items (stack full)
   *     → trade is left in `countered` state so both players can modify or cancel
   *   - `string` for other validation errors (sent only to the initiator)
   */
  confirmTrade(
    initiatorUsername: string,
    hasItemInInventory: (u: string, itemId: string, quantity: number) => boolean,
    areSameTile: (a: string, b: string) => boolean,
    getInventoryCount: (u: string, itemId: string) => number,
  ): { trade: TradeState; initiatorOffer: TradeOffer; targetOffer: TradeOffer } | ConfirmTradeFailure | string {
    const tradeId = this.playerTrade.get(initiatorUsername);
    if (!tradeId) return 'No pending trade';

    const trade = this.trades.get(tradeId);
    if (!trade) return 'Trade not found';
    if (trade.initiator.username !== initiatorUsername) return 'Only the trade initiator can confirm';
    if (trade.status !== 'countered') return 'Waiting for the other player to offer an item first';
    if (!trade.target) return 'Trade has no target offer';

    if (!areSameTile(initiatorUsername, trade.target.username)) return 'You are no longer in the same room';

    // Re-validate item presence with required quantities
    for (const { itemId, quantity } of trade.initiator.items) {
      if (!hasItemInInventory(initiatorUsername, itemId, quantity)) {
        return 'Your offered item is no longer in your inventory';
      }
    }
    for (const { itemId, quantity } of trade.target.items) {
      if (!hasItemInInventory(trade.target.username, itemId, quantity)) {
        return 'Their offered item is no longer in their inventory';
      }
    }

    const initiatorOffer: TradeOffer = { ...trade.initiator };
    const targetOffer: TradeOffer = { ...trade.target };

    // Stack capacity check using net change per itemId.
    // For initiator: they lose initiatorOffer items, gain targetOffer items.
    // For target: they lose targetOffer items, gain initiatorOffer items.
    // Only check items with a positive net change (gaining more than giving of same type).
    const checkStackCapacity = (
      receiver: string,
      receiving: TradeOfferItem[],
      sending: TradeOfferItem[],
      affectedPlayer: 'initiator' | 'target',
    ): ConfirmTradeFailure | null => {
      const sendMap = new Map<string, number>();
      for (const { itemId, quantity } of sending) {
        sendMap.set(itemId, (sendMap.get(itemId) ?? 0) + quantity);
      }
      for (const { itemId, quantity } of receiving) {
        const netGain = quantity - (sendMap.get(itemId) ?? 0);
        if (netGain > 0) {
          if (getInventoryCount(receiver, itemId) + netGain > MAX_STACK) {
            return { success: false, reason: 'inventory_full', affectedPlayer };
          }
        }
      }
      return null;
    };

    const initiatorFail = checkStackCapacity(
      initiatorUsername, targetOffer.items, initiatorOffer.items, 'initiator',
    );
    if (initiatorFail) return initiatorFail;

    const targetFail = checkStackCapacity(
      targetOffer.username, initiatorOffer.items, targetOffer.items, 'target',
    );
    if (targetFail) return targetFail;

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
    const tradeId = this.playerTrade.get(username);
    if (!tradeId) return null;
    const trade = this.trades.get(tradeId);
    if (!trade) return null;
    if (trade.initiator.username === username) {
      // If target has countered, use their offer username; otherwise find via playerTrade map
      if (trade.target) return trade.target.username;
      for (const [u, id] of this.playerTrade) {
        if (id === tradeId && u !== username) return u;
      }
      return null;
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
