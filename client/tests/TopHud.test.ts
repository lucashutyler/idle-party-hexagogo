import { describe, expect, it } from 'vitest';
import { formatGoldChip } from '../src/ui/TopHud';

describe('formatGoldChip', () => {
  it('shows the full localized number below 10,000', () => {
    expect(formatGoldChip(0)).toBe('0');
    expect(formatGoldChip(9999)).toBe((9999).toLocaleString());
    expect(formatGoldChip(9999)).toMatch(/^9.?999$/);
  });

  it('abbreviates thousands with one floored decimal', () => {
    expect(formatGoldChip(10_000)).toBe('10k');
    expect(formatGoldChip(12_345)).toBe('12.3k');
    expect(formatGoldChip(99_999)).toBe('99.9k');
  });

  it('drops the decimal from three-digit abbreviations', () => {
    expect(formatGoldChip(100_000)).toBe('100k');
    expect(formatGoldChip(999_999)).toBe('999k');
  });

  it('abbreviates millions and billions', () => {
    expect(formatGoldChip(1_000_000)).toBe('1M');
    expect(formatGoldChip(1_234_567)).toBe('1.2M');
    expect(formatGoldChip(2_500_000_000)).toBe('2.5B');
  });
});
