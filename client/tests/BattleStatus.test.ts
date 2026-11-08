import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { battleStatus, battleStatusHtml, rewardLines } from '../src/combat/BattleStatus';
import type { BattleStatusInput } from '../src/combat/BattleStatus';

function input(overrides: Partial<BattleStatusInput> = {}): BattleStatusInput {
  return {
    visual: 'fighting', hasFight: true, result: null, inDungeon: false, lastFloor: false, walking: false,
    hasDestination: false, roomName: null, rewards: [], ...overrides,
  };
}

describe('battleStatus', () => {
  it('stays hidden while a fight is running', () => {
    expect(battleStatus(input())).toBeNull();
  });

  it('calls the win as soon as playback reaches it, before the server visual flips', () => {
    expect(battleStatus(input({ result: 'victory' }))?.title).toBe('Victory');
  });

  it('shows rewards and fights again when nowhere to walk', () => {
    const status = battleStatus(input({ visual: 'victory', result: 'victory', rewards: ['+5 XP', '+2 gold'] }))!;
    expect(status.tone).toBe('victory');
    expect(status.rewards).toEqual(['+5 XP', '+2 gold']);
    expect(status.next).toBe('Fighting here again');
  });

  it('names the next room after a win, and keeps it through the walk', () => {
    const won = input({ visual: 'victory', result: 'victory', hasDestination: true, roomName: 'Old Mill' });
    expect(battleStatus(won)?.next).toBe('Walking to Old Mill');
    const walking = input({ visual: 'none', result: 'victory', walking: true, roomName: 'Old Mill', rewards: ['+5 XP'] });
    expect(battleStatus(walking)).toMatchObject({ title: 'Victory', rewards: ['+5 XP'], next: 'Walking to Old Mill' });
  });

  it('does not name an undiscovered room', () => {
    expect(battleStatus(input({ visual: 'victory', hasDestination: true }))?.next).toBe('Walking on');
  });

  it('never promises a walk after a defeat or retreat until the party has moved', () => {
    expect(battleStatus(input({ visual: 'defeat', hasDestination: true, roomName: 'Old Mill' }))).toMatchObject({ title: 'Defeated', tone: 'defeat', next: 'Regrouping' });
    expect(battleStatus(input({ visual: 'retreat', result: 'retreat', hasDestination: true }))).toMatchObject({ title: 'Retreated', tone: 'retreat', next: 'Regrouping' });
    expect(battleStatus(input({ visual: 'none', result: 'defeat', walking: true, roomName: 'Old Mill' }))?.next).toBe('Walking to Old Mill');
  });

  it('counts down a wipe wait, and never promises a walk during one', () => {
    expect(battleStatus(input({ visual: 'defeat', result: 'defeat', regroupSeconds: 42 }))).toMatchObject({ title: 'Defeated', next: 'Regrouping, 42s' });
    expect(battleStatus(input({ visual: 'defeat', result: 'defeat', hasDestination: true, roomName: 'Old Mill', regroupSeconds: 1 }))?.next).toBe('Regrouping, 1s');
  });

  it('shows the wait with no fight on the board', () => {
    expect(battleStatus(input({ hasFight: false, visual: 'none', regroupSeconds: 9 }))).toMatchObject({ title: '', next: 'Regrouping, 9s' });
    expect(battleStatus(input({ visual: 'none', regroupSeconds: 9 }))).toMatchObject({ title: '', next: 'Regrouping, 9s' });
  });

  it('goes back to the plain line when no time is left', () => {
    expect(battleStatus(input({ visual: 'defeat', result: 'defeat', regroupSeconds: 0 }))?.next).toBe('Regrouping');
  });

  it('heads for the next floor inside a dungeon', () => {
    expect(battleStatus(input({ visual: 'victory', inDungeon: true }))?.next).toBe('On to the next floor');
  });

  it('heads back to the entrance after the last floor of a dungeon', () => {
    expect(battleStatus(input({ visual: 'victory', inDungeon: true, lastFloor: true }))?.next).toBe('Back to the entrance');
  });

  it('heads back to the entrance after a wipe on any floor of a dungeon, and never says regrouping', () => {
    for (const lastFloor of [false, true]) {
      expect(battleStatus(input({ visual: 'defeat', result: 'defeat', inDungeon: true, lastFloor }))).toMatchObject({ title: 'Defeated', next: 'Back to the entrance' });
    }
  });

  it('says the party is regrouping when there is no fight on the board', () => {
    expect(battleStatus(input({ hasFight: false, visual: 'none' }))).toMatchObject({ tone: 'idle', title: '', next: 'Regrouping' });
  });
});

describe('rewardLines', () => {
  const before = { level: 3, xp: 90, xpForNextLevel: 100, gold: 50 };

  it('reports the XP and gold a victory added', () => {
    expect(rewardLines(before, { ...before, xp: 95, gold: 62 })).toEqual(['+5 XP', '+12 gold']);
  });

  it('counts XP across a level-up, whose reset would read as a loss', () => {
    expect(rewardLines(before, { level: 4, xp: 5, xpForNextLevel: 150, gold: 50 })).toEqual(['+15 XP', 'Level 4!']);
  });

  it('claims nothing it cannot back up', () => {
    expect(rewardLines(before, before)).toEqual([]);
    expect(rewardLines(before, { ...before, gold: 10 })).toEqual([]);
    expect(rewardLines(null, before)).toEqual([]);
  });
});

describe('battleStatusHtml', () => {
  it('escapes room names', () => {
    const html = battleStatusHtml({ tone: 'victory', title: 'Victory', rewards: [], next: 'Walking to <b>Mill</b>' });
    expect(html).toContain('Walking to &lt;b&gt;Mill&lt;/b&gt;');
  });
});

describe('combat.css paint budget', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/combat.css'), 'utf8');

  it('runs nothing forever and blurs nothing', () => {
    expect(css).not.toMatch(/\binfinite\b/);
    expect(css).not.toContain('backdrop-filter');
  });
});
