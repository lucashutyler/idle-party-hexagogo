import { describe, expect, it } from 'vitest';
import { partyGridCell } from '../src/ui/partyGridLayout';

describe('partyGridCell', () => {
  it('labels columns front (2), mid (1), back (0)', () => {
    expect(partyGridCell(2).columnLabel).toBe('Front');
    expect(partyGridCell(4).columnLabel).toBe('Mid');
    expect(partyGridCell(6).columnLabel).toBe('Back');
  });

  it('maps to the combat party block in portrait: displayRow = 2 - col, displayCol = row', () => {
    for (let pos = 0; pos < 9; pos++) {
      const cell = partyGridCell(pos);
      expect(cell.row).toBe(Math.floor(pos / 3));
      expect(cell.col).toBe(pos % 3);
      expect(cell.portraitRow).toBe(2 - cell.col);
      expect(cell.portraitCol).toBe(cell.row);
    }
  });

  it('puts the whole front column on the top portrait row', () => {
    const topRow = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter(p => partyGridCell(p).portraitRow === 0);
    expect(topRow).toEqual([2, 5, 8]);
    expect(topRow.map(p => partyGridCell(p).portraitCol)).toEqual([0, 1, 2]);
  });

  it('is a bijection over the 3x3 grid', () => {
    const seen = new Set<string>();
    for (let pos = 0; pos < 9; pos++) {
      const { portraitRow, portraitCol } = partyGridCell(pos);
      seen.add(`${portraitRow},${portraitCol}`);
    }
    expect(seen.size).toBe(9);
  });
});
