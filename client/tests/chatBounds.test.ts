import { describe, expect, it } from 'vitest';
import { floatingVerticalBounds } from '../src/ui/chatBounds';

const extent = (top: number, height: number) => ({ top, bottom: top + height, height });

describe('floatingVerticalBounds', () => {
  it('uses the whole viewport when nothing is docked', () => {
    expect(floatingVerticalBounds(800, [null], [null, null])).toEqual({ top: 0, bottom: 800 });
  });

  it('stays below the HUD and above the highest bottom-docked element', () => {
    const hud = extent(0, 48);
    const xpBar = extent(720, 6);
    const nav = extent(726, 68);
    const raisedBattle = extent(714, 60);
    expect(floatingVerticalBounds(800, [hud], [xpBar, nav, raisedBattle])).toEqual({ top: 48, bottom: 714 });
  });

  it('accounts for the nav float margin by using its rect rather than its height', () => {
    const nav = extent(800 - 6 - 34 - 68, 68);
    expect(floatingVerticalBounds(800, [], [nav]).bottom).toBe(692);
  });

  it('ignores hidden (zero-height) elements', () => {
    expect(floatingVerticalBounds(800, [extent(0, 0)], [extent(0, 0)])).toEqual({ top: 0, bottom: 800 });
  });

  it('never returns a bottom above the top', () => {
    expect(floatingVerticalBounds(100, [extent(0, 80)], [extent(50, 50)])).toEqual({ top: 80, bottom: 80 });
  });
});
