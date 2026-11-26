import path from 'path';
import type { TradeState } from '@idle-party-rpg/shared';
import { UnreadableDataFileError, isDamagedDataFileError, isJsonObject, moveAside, readJsonFile, writeJsonFileAtomic } from '../JsonFiles.js';

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
  /** A damaged file is moved aside and no trades are restored, so the next save can't write over it. A failed read throws. */
  async load(): Promise<TradeState[]> {
    try {
      return await readTrades() ?? [];
    } catch (err) {
      if (!isDamagedDataFileError(err)) throw err;
      const aside = await moveAside(TRADE_FILE);
      console.error(`[TradeStore] Moved an unreadable file to ${aside}; starting with no trades:`, err.cause);
      return [];
    }
  }

  async save(trades: TradeState[]): Promise<void> {
    await writeJsonFileAtomic(TRADE_FILE, trades, { space: 2 });
  }
}

async function readTrades(): Promise<TradeState[] | undefined> {
  const value = await readJsonFile<unknown>(TRADE_FILE);
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isJsonObject)) {
    throw new UnreadableDataFileError(TRADE_FILE, new Error('it holds something other than a list of trades'));
  }
  return value as unknown as TradeState[];
}
