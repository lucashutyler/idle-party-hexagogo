import { randomUUID } from 'crypto';
import type { TradeState, TradeOffer, TradeOfferItem } from '@idle-party-rpg/shared';
import { MAX_STACK } from '@idle-party-rpg/shared';

/**
 * TradeSystem manages asynchronous peer-to-peer item trades.
 *
 * Trade lifecycle:
 *   pending   — initiator proposed items; waiting for target to counter
 *   countered — target locked in their items; waiting for initiator to confirm
 *   confirmed — initiator confirmed; caller executes the atomic item swap
 *   cancelled — either player cancelled
 *
 * Rules:
 *   - Each player offers at least one unequipped inventory item (with quantities)
 *   - Players can have MULTIPLE active proposed trades (one per partner pair)
 *   - Blocked users cannot trade with each other
 *   - Trades persist across server restarts and movement (asynchronous)
 *   - Trades are NOT cancelled on disconnect
 *
 * `lastUpdatedBy` tracks who took the most recent action — the OTHER player
 * needs to act next. Used by clients to surface "needs my attention" state.
 *
 * This class is pure stateful logic — no WebSocket sends, no file I/O.
 * PlayerManager wires everything together; TradeStore handles persistence.
 */

export type ConfirmTradeFailure = { success: false; reason: string; affectedPlayer: 'initiator' | 'target' };

export class TradeSystem {
  /** All active trades by trade ID. */
  private trades = new Map<string, TradeState>();

  /** Quick lookup: username → set of trade IDs the player participates in. */
  private playerTrades = new Map<string, Set<string>>();

  /** Restore trades from persisted data (called at startup). */
  restoreFromSaveData(saved: TradeState[]): void {
    this.trades.clear();
    this.playerTrades.clear();
    for (const trade of saved) {
      // Only restore unfinished trades
      if (trade.status === 'cancelled' || trade.status === 'confirmed') continue;
      this.trades.set(trade.id, trade);
      this.indexParticipants(trade);
    }
  }

  /** Snapshot all active trades for persistence. */
  getAllTrades(): TradeState[] {
    return Array.from(this.trades.values());
  }

  private indexParticipants(trade: TradeState): void {
    const participants = [trade.initiator.username];
    if (trade.target?.username) participants.push(trade.target.username);
    // For pending trades with no target offer yet, the target is implicit by the
    // initiator's intended counterparty — we still need to index them so the target
    // can find this trade. Callers populate the second participant via setTarget.
    for (const u of participants) {
      let set = this.playerTrades.get(u);
      if (!set) {
        set = new Set();
        this.playerTrades.set(u, set);
      }
      set.add(trade.id);
    }
  }

  private indexUser(username: string, tradeId: string): void {
    let set = this.playerTrades.get(username);
    if (!set) {
      set = new Set();
      this.playerTrades.set(username, set);
    }
    set.add(tradeId);
  }

  private deindexUser(username: string, tradeId: string): void {
    const set = this.playerTrades.get(username);
    if (!set) return;
    set.delete(tradeId);
    if (set.size === 0) this.playerTrades.delete(username);
  }

  /** Trade IDs the user participates in. */
  private getTradeIdsFor(username: string): Set<string> {
    return this.playerTrades.get(username) ?? new Set();
  }

  /** All active trades involving the given user. */
  getPlayerTrades(username: string): TradeState[] {
    const ids = this.getTradeIdsFor(username);
    const result: TradeState[] = [];
    for (const id of ids) {
      const t = this.trades.get(id);
      if (t) result.push(t);
    }
    return result;
  }

  getTrade(tradeId: string): TradeState | null {
    return this.trades.get(tradeId) ?? null;
  }

  /**
   * Find an existing active trade between two players (in either direction).
   * Used to enforce the "one trade per pair" rule.
   */
  findTradeBetween(a: string, b: string): TradeState | null {
    for (const id of this.getTradeIdsFor(a)) {
      const t = this.trades.get(id);
      if (!t) continue;
      const other = t.initiator.username === a
        ? t.target?.username
        : t.initiator.username;
      if (other === b) return t;
    }
    return null;
  }

  /**
   * Propose a trade. Returns the new TradeState or an error string.
   *
   * `targetUsername` is stored as the initial `target.username` (with empty items)
   * so the target appears in the trade record before they counter.
   */
  proposeTrade(
    initiatorUsername: string,
    targetUsername: string,
    items: TradeOfferItem[],
    hasItemInInventory: (u: string, itemId: string, quantity: number) => boolean,
    isBlocked: (a: string, b: string) => boolean,
  ): TradeState | string {
    if (initiatorUsername === targetUsername) return 'Cannot trade with yourself';
    if (isBlocked(initiatorUsername, targetUsername)) return 'Cannot trade with a blocked user';
    if (this.findTradeBetween(initiatorUsername, targetUsername)) {
      return 'You already have a pending trade with that player';
    }

    if (!Array.isArray(items) || items.length === 0) return 'Must offer at least one item';
    for (const { itemId, quantity } of items) {
      if (!hasItemInInventory(initiatorUsername, itemId, quantity)) {
        return 'Item not found in your inventory';
      }
    }

    const id = `trade_${randomUUID()}`;
    const trade: TradeState = {
      id,
      status: 'pending',
      initiator: { username: initiatorUsername, items },
      // Target slot is created upfront with the intended counterparty so they can find it.
      target: { username: targetUsername, items: [] },
      timestamp: Date.now(),
      lastUpdatedBy: initiatorUsername,
    };

    this.trades.set(id, trade);
    this.indexUser(initiatorUsername, id);
    this.indexUser(targetUsername, id);

    return trade;
  }

  /**
   * Counter a trade. Either player can update their offer at any time
   * before confirmation. Status stays 'pending' if either offer is empty;
   * becomes 'countered' once both players have offered something.
   */
  counterTrade(
    tradeId: string,
    actingUsername: string,
    items: TradeOfferItem[],
    hasItemInInventory: (u: string, itemId: string, quantity: number) => boolean,
  ): TradeState | string {
    const trade = this.trades.get(tradeId);
    if (!trade) return 'Trade not found';
    if (trade.status === 'cancelled' || trade.status === 'confirmed') return 'Trade is no longer active';

    const isInitiator = trade.initiator.username === actingUsername;
    const isTarget = trade.target?.username === actingUsername;
    if (!isInitiator && !isTarget) return 'Not your trade';

    if (!Array.isArray(items) || items.length === 0) return 'Must offer at least one item';
    for (const { itemId, quantity } of items) {
      if (!hasItemInInventory(actingUsername, itemId, quantity)) {
        return 'Item not found in your inventory';
      }
    }

    if (isInitiator) {
      trade.initiator = { username: actingUsername, items };
    } else if (trade.target) {
      trade.target = { username: actingUsername, items };
    }

    // Status: 'countered' once both have offered; otherwise 'pending'
    const initOk = trade.initiator.items.length > 0;
    const targetOk = (trade.target?.items.length ?? 0) > 0;
    trade.status = (initOk && targetOk) ? 'countered' : 'pending';
    trade.lastUpdatedBy = actingUsername;
    trade.timestamp = Date.now();

    return trade;
  }

  /**
   * Confirm a trade. Either player can confirm — but only if the OTHER player
   * was the last to update. Re-validates inventory + stack capacity.
   *
   * Returns:
   *   - `{ trade, initiatorOffer, targetOffer }` on success — caller executes the atomic swap.
   *     The trade is removed from the system before returning.
   *   - `ConfirmTradeFailure` if either player's inventory cannot accept incoming items
   *     → trade is left in `countered` state.
   *   - `string` for other validation errors.
   */
  confirmTrade(
    tradeId: string,
    actingUsername: string,
    hasItemInInventory: (u: string, itemId: string, quantity: number) => boolean,
    getInventoryCount: (u: string, itemId: string) => number,
  ): { trade: TradeState; initiatorOffer: TradeOffer; targetOffer: TradeOffer } | ConfirmTradeFailure | string {
    const trade = this.trades.get(tradeId);
    if (!trade) return 'Trade not found';
    if (trade.status !== 'countered') return 'Both players must offer items before confirming';
    if (!trade.target) return 'Trade has no target offer';

    const isInitiator = trade.initiator.username === actingUsername;
    const isTarget = trade.target.username === actingUsername;
    if (!isInitiator && !isTarget) return 'Not your trade';

    if (trade.lastUpdatedBy === actingUsername) {
      return 'Waiting for the other player to confirm';
    }

    for (const { itemId, quantity } of trade.initiator.items) {
      if (!hasItemInInventory(trade.initiator.username, itemId, quantity)) {
        return 'An offered item is no longer in inventory';
      }
    }
    for (const { itemId, quantity } of trade.target.items) {
      if (!hasItemInInventory(trade.target.username, itemId, quantity)) {
        return 'An offered item is no longer in inventory';
      }
    }

    const initiatorOffer: TradeOffer = { ...trade.initiator };
    const targetOffer: TradeOffer = { ...trade.target };

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
      trade.initiator.username, targetOffer.items, initiatorOffer.items, 'initiator',
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
   * Cancel a trade. Either participant can cancel.
   * Returns the cancelled TradeState, or null if no such trade or actor not a participant.
   */
  cancelTrade(tradeId: string, actingUsername: string, reason?: string): TradeState | null {
    const trade = this.trades.get(tradeId);
    if (!trade) return null;
    const isParticipant = trade.initiator.username === actingUsername
      || trade.target?.username === actingUsername;
    if (!isParticipant) return null;

    trade.status = 'cancelled';
    if (reason) trade.cancelReason = reason;
    this.cleanupTrade(tradeId);
    return trade;
  }

  /** Cancel ALL trades a player participates in (e.g. on suspension). */
  cancelAllForPlayer(username: string, reason?: string): TradeState[] {
    const cancelled: TradeState[] = [];
    const ids = Array.from(this.getTradeIdsFor(username));
    for (const id of ids) {
      const t = this.cancelTrade(id, username, reason);
      if (t) cancelled.push(t);
    }
    return cancelled;
  }

  /** Get the other participant of this trade. */
  getTradePartner(tradeId: string, username: string): string | null {
    const trade = this.trades.get(tradeId);
    if (!trade) return null;
    if (trade.initiator.username === username) return trade.target?.username ?? null;
    if (trade.target?.username === username) return trade.initiator.username;
    return null;
  }

  private cleanupTrade(tradeId: string): void {
    const trade = this.trades.get(tradeId);
    if (trade) {
      this.deindexUser(trade.initiator.username, tradeId);
      if (trade.target) this.deindexUser(trade.target.username, tradeId);
    }
    this.trades.delete(tradeId);
  }
}
