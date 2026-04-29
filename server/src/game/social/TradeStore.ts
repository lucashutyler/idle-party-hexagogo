import fs from 'fs/promises';
import path from 'path';
import type { TradeState } from '@idle-party-rpg/shared';

const TRADE_FILE = path.resolve('data', 'trades.json');

/**
 * Persists asynchronous trade state to data/trades.json.
 *
 * Trades survive server restarts so that a proposed trade waiting on the other
 * player's response is not lost when the server reboots. Only active trades
 * (status: 'pending' or 'countered') are saved — confirmed/cancelled trades are
 * already removed from TradeSystem.
 */
export class TradeStore {
  async load(): Promise<TradeState[]> {
    try {
      const raw = await fs.readFile(TRADE_FILE, 'utf-8');
      const arr = JSON.parse(raw) as TradeState[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  async save(trades: TradeState[]): Promise<void> {
    await fs.mkdir(path.dirname(TRADE_FILE), { recursive: true });
    await fs.writeFile(TRADE_FILE, JSON.stringify(trades, null, 2));
  }
}
