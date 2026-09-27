import type { ClientCombatStatus, CombatEvent } from '@idle-party-rpg/shared';

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
