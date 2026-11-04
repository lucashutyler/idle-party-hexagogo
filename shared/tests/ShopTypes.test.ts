import { describe, it, expect } from 'vitest';
import { toShopSummary } from '../src/systems/ShopTypes';
import type { ShopDefinition } from '../src/systems/ShopTypes';

describe('toShopSummary', () => {
  it('says what a shop offers without its stock', () => {
    expect(toShopSummary({ id: 's', name: 'Supplies', inventory: [{ itemId: 'rope', price: 2 }], henchmanIds: ['sellsword'] }))
      .toEqual({ id: 's', name: 'Supplies', sellsItems: true, hiresHenchmen: true });
  });

  it('treats an empty or missing stock list as selling nothing', () => {
    expect(toShopSummary({ id: 'h', name: 'Hall', inventory: [], henchmanIds: ['sellsword'] }).sellsItems).toBe(false);
    expect(toShopSummary({ id: 'h', name: 'Hall', henchmanIds: [] } as unknown as ShopDefinition))
      .toEqual({ id: 'h', name: 'Hall', sellsItems: false, hiresHenchmen: false });
  });
});
