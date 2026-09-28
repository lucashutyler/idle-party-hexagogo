import type { ClientCombatStatus, CombatEvent, LevelCon, MasteryEntry, MonsterLevelSource, MonsterTier } from '@idle-party-rpg/shared';
import { LEVEL_CON_INFO, levelCon } from '@idle-party-rpg/shared';
import type { EnrageDisplay } from './CombatPlayback';

export interface StatusPip {
  icon: string;
  tone: 'bad' | 'good';
  title: string;
  count?: number;
}

export const MAX_VISIBLE_PIPS = 4;

/** Stamp text for an `interrupt` event: the engine marks counters from an Interrupt reaction with cardType 'interrupt'. */
export function interruptStampText(ev: Pick<CombatEvent, 'cardType'>): string {
  return ev.cardType === 'interrupt' ? 'COUNTERED!' : 'INTERRUPTED!';
}

/** "0:07", "1:05", "12:00". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/** Cooldown / cast countdown text: one decimal under 10 s, whole seconds above. */
export function formatSeconds(ms: number): string {
  if (ms <= 0) return '';
  if (ms >= 9950) return String(Math.ceil(ms / 1000));
  return (Math.ceil(ms / 100) / 10).toFixed(1);
}

/** Static durations: "2s", "1.5s". */
export function formatDuration(ms: number): string {
  return `${Math.round(ms / 100) / 10}s`;
}

/** Damage/heal amounts: exact below 10 000, then 12.3k / 1.2M. */
export function formatAmount(n: number): string {
  const abs = Math.abs(Math.round(n));
  if (abs < 10000) return String(abs);
  if (abs < 1_000_000) return `${trimDecimal(abs / 1000)}k`;
  return `${trimDecimal(abs / 1_000_000)}M`;
}

function trimDecimal(value: number): string {
  const rounded = value >= 100 ? Math.floor(value) : Math.floor(value * 10) / 10;
  return String(rounded);
}

export function statusIcon(status: ClientCombatStatus): { icon: string; tone: 'bad' | 'good' } {
  const name = status.name.toLowerCase();
  switch (status.kind) {
    case 'dot':
      if (/ignite|burn|fire|flame/.test(name)) return { icon: '🔥', tone: 'bad' };
      if (/rot|poison|venom|plague/.test(name)) return { icon: '☠', tone: 'bad' };
      return { icon: '🩸', tone: 'bad' };
    case 'hot':
      return { icon: '✚', tone: 'good' };
    case 'mark':
      return { icon: '🎯', tone: 'bad' };
    case 'chaos':
      return { icon: '🌀', tone: 'bad' };
    case 'scorch':
      return { icon: '♨', tone: 'bad' };
    case 'buff':
      return { icon: /song|anthem|rally/.test(name) ? '🎵' : '⬆', tone: 'good' };
    case 'enrage':
      return { icon: '😡', tone: 'bad' };
    default:
      return { icon: '⬇', tone: 'bad' };
  }
}

/** Status pips for a unit card, most urgent first. */
export function statusPips(unit: { hp: number; stunMs: number; shield: number; statuses: readonly ClientCombatStatus[] }): StatusPip[] {
  if (unit.hp <= 0) return [];
  const pips: StatusPip[] = [];
  if (unit.stunMs > 0) pips.push({ icon: '💫', tone: 'bad', title: 'Stunned' });
  if (unit.shield > 0) pips.push({ icon: '🛡', tone: 'good', title: `Shield (${formatAmount(unit.shield)})` });
  for (const status of unit.statuses) {
    const { icon, tone } = statusIcon(status);
    const pip: StatusPip = { icon, tone, title: status.name };
    if (status.stacks && status.stacks > 1) pip.count = status.stacks;
    pips.push(pip);
  }
  return pips;
}

/** Stable string for change detection of a pip row. */
export function pipsKey(pips: readonly StatusPip[]): string {
  return pips.map(p => `${p.icon}${p.count ?? ''}`).join('|');
}

export function hpTier(fraction: number): 'high' | 'mid' | 'low' | 'critical' {
  if (fraction <= 0.25) return 'critical';
  if (fraction <= 0.5) return 'low';
  if (fraction <= 0.75) return 'mid';
  return 'high';
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** First letters of up to two words, for portraits without art. */
export function initials(name: string): string {
  const words = name.replace(/#\d+$/, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

/** "×1.6": enrage and other damage multipliers, at most two decimals. */
export function formatMultiplier(value: number): string {
  return `×${Math.round(value * 100) / 100}`;
}

/** Boss bar enrage slot: "⏱ 4:48" counting down (rounded up), then "🔥 ×1.6". */
export function enrageSlotText(display: Pick<EnrageDisplay, 'state' | 'remainingMs' | 'multiplier'>): string {
  if (display.state === 'on') return `🔥 ${formatMultiplier(display.multiplier)}`;
  return `⏱ ${formatClock(Math.ceil(display.remainingMs / 1000) * 1000)}`;
}

/** Regroups left on a checkpoint floor; null when the floor has no budget. */
export function retriesLeft(wipes: number | undefined, maxWipes: number | undefined): number | null {
  if (maxWipes === undefined || !(maxWipes > 0)) return null;
  return Math.max(0, maxWipes - Math.max(0, wipes ?? 0));
}

export function retriesText(left: number): string {
  if (left === 0) return 'No retries left';
  return `${left} ${left === 1 ? 'retry' : 'retries'} left`;
}

export type BossOpening = 'boss' | 'regroup' | 'resume';

/** A boss fight after a wipe on the same floor regroups; one that starts at a checkpoint without a new wipe resumes a saved run. */
export function bossOpening(resumedFromPhase: number, wipes: number, previousWipes: number | null): BossOpening {
  if (previousWipes !== null && wipes > previousWipes) return 'regroup';
  return resumedFromPhase > 0 ? 'resume' : 'boss';
}

export interface MonsterLevelBadge {
  level: number;
  con: LevelCon;
  label: string;
  glyph: string;
}

/** Badge for an authored monster level, coloured by the gap to the viewer; derived levels get none. */
export function monsterLevelBadge(
  info: { level?: number; levelSource?: MonsterLevelSource } | undefined,
  viewerLevel: number | undefined,
): MonsterLevelBadge | null {
  if (!info || info.levelSource !== 'authored' || !info.level || !(info.level > 0)) return null;
  const con = levelCon(info.level, viewerLevel ?? info.level);
  return { level: info.level, con, ...LEVEL_CON_INFO[con] };
}

export const TIER_INFO: Record<MonsterTier, { label: string; glyph: string }> = {
  trash: { label: 'Normal', glyph: '' },
  elite: { label: 'Elite', glyph: '◆' },
  boss: { label: 'Boss', glyph: '♛' },
  raid: { label: 'Raid boss', glyph: '♛' },
};

export function isBossOrRaid(tier: MonsterTier | undefined): boolean {
  return tier === 'boss' || tier === 'raid';
}

export function hasToughTier(tier: MonsterTier | undefined): boolean {
  return tier === 'elite' || isBossOrRaid(tier);
}

/** "★★☆☆☆ +4 % · 212 / 250 kills", or "★★★★★ Mastered · +10 %". */
export function masteryLine(entry: Pick<MasteryEntry, 'rank' | 'maxRank' | 'kills' | 'nextAt' | 'bonusPct'>): string {
  const maxRank = Math.max(1, entry.maxRank);
  const rank = Math.max(0, Math.min(maxRank, entry.rank));
  const stars = '★'.repeat(rank) + '☆'.repeat(maxRank - rank);
  const bonus = entry.bonusPct > 0 ? ` · +${Math.round(entry.bonusPct)} %` : '';
  if (entry.nextAt === null) return `${stars} Mastered${bonus}`;
  return `${stars}${bonus} · ${entry.kills.toLocaleString('en-US')} / ${entry.nextAt.toLocaleString('en-US')} kills`;
}
