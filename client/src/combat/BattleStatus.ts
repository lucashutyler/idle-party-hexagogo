import type { BattleVisual, CombatResult } from '@idle-party-rpg/shared';
import { escapeHtml, formatAmount } from './CombatFormat';

export type BattleStatusTone = 'victory' | 'defeat' | 'retreat' | 'idle';

export interface BattleStatus {
  tone: BattleStatusTone;
  title: string;
  rewards: string[];
  next: string;
}

export interface CharacterProgress {
  level: number;
  xp: number;
  xpForNextLevel: number;
  gold: number;
}

export interface BattleStatusInput {
  visual: BattleVisual;
  /** False when no fight is on the board at all (Run, or the server recovering). */
  hasFight: boolean;
  /** The fight's playback result, which arrives before the server's visual does. */
  result: CombatResult | null;
  /** Whether this fight was in a dungeon, even if the server has since ended the run. */
  inDungeon: boolean;
  lastFloor: boolean;
  /** True once the server has moved the party for this cycle, so "here" is already the next room. */
  walking: boolean;
  hasDestination: boolean;
  /** The room being walked to, when the player has discovered it. */
  roomName: string | null;
  rewards: string[];
  /** Whole seconds left of a hold on the next fight, when one is running. */
  regroupSeconds?: number;
}

const OUTCOME_TITLES: Record<CombatResult, string> = {
  victory: 'Victory',
  defeat: 'Defeated',
  retreat: 'Retreated',
};

function outcomeOf(input: BattleStatusInput): CombatResult | null {
  if (input.result) return input.result;
  return input.visual === 'victory' || input.visual === 'defeat' || input.visual === 'retreat' ? input.visual : null;
}

function walkingText(roomName: string | null): string {
  return roomName ? `Walking to ${roomName}` : 'Walking on';
}

function regroupText(input: BattleStatusInput): string {
  return input.regroupSeconds ? `Regrouping, ${input.regroupSeconds}s` : 'Regrouping';
}

function nextStep(outcome: CombatResult | null, input: BattleStatusInput): string {
  if (input.regroupSeconds) return regroupText(input);
  if (input.walking) return walkingText(input.roomName);
  if (input.inDungeon) return outcome === 'victory' && !input.lastFloor ? 'On to the next floor' : 'Back to the entrance';
  if (outcome !== 'victory') return regroupText(input);
  return input.hasDestination ? walkingText(input.roomName) : 'Fighting here again';
}

/** What the party is doing between fights, or null while a fight is running. */
export function battleStatus(input: BattleStatusInput): BattleStatus | null {
  if (!input.hasFight) return { tone: 'idle', title: '', rewards: [], next: regroupText(input) };
  const outcome = outcomeOf(input);
  if (!outcome && !input.walking && !input.regroupSeconds) return null;
  return {
    tone: outcome ?? 'idle',
    title: outcome ? OUTCOME_TITLES[outcome] : '',
    rewards: outcome === 'victory' ? input.rewards : [],
    next: nextStep(outcome, input),
  };
}

/** What a victory's state push added; a level-up resets `xp`, so it counts up to the old level's end. */
export function rewardLines(before: CharacterProgress | null, after: CharacterProgress | null): string[] {
  if (!before || !after) return [];
  const lines: string[] = [];
  const levelled = after.level > before.level;
  const xp = levelled ? before.xpForNextLevel - before.xp + after.xp : after.xp - before.xp;
  if (xp > 0) lines.push(`+${formatAmount(xp)} XP`);
  const gold = after.gold - before.gold;
  if (gold > 0) lines.push(`+${formatAmount(gold)} gold`);
  if (levelled) lines.push(`Level ${after.level}!`);
  return lines;
}

export function battleStatusHtml(status: BattleStatus): string {
  const head = status.title
    ? `<span class="combat-status-head"><b class="combat-status-title">${escapeHtml(status.title)}</b>${status.rewards.map(r => `<span class="combat-status-reward">${escapeHtml(r)}</span>`).join('')}</span>`
    : '';
  return `${head}<span class="combat-status-next">${escapeHtml(status.next)}</span>`;
}
