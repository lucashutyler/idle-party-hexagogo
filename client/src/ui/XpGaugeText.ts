import { roundToTwoFigures } from '@idle-party-rpg/shared';
import type { ClientXpGauge } from '@idle-party-rpg/shared';

export interface XpGaugeLines {
  rate: string;
  /** Null inside a dungeon. */
  level: string | null;
}

const SUFFIXES: readonly [number, string][] = [[1e12, 't'], [1e9, 'b'], [1e6, 'm'], [1e3, 'k']];

/** Two significant figures with a k/m/b/t suffix: 36k, 1.2m. */
export function formatXpAmount(value: number): string {
  const rounded = roundToTwoFigures(value);
  for (const [size, suffix] of SUFFIXES) {
    if (rounded >= size) return `${Number((rounded / size).toPrecision(2))}${suffix}`;
  }
  return String(rounded);
}

/** Time to the next level in a bucket a player can read at a glance. */
export function levelEtaText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'not at this rate';
  const minutes = seconds / 60;
  if (minutes < 57.5) {
    const whole = Math.max(1, Math.round(minutes));
    return `about ${whole < 10 ? whole : Math.round(whole / 5) * 5} min`;
  }
  const hours = minutes / 60;
  if (hours < 23.5) return `about ${Math.round(hours)} h`;
  const days = Math.round(hours / 24);
  if (hours / 24 < 30.5) return `about ${days} ${days === 1 ? 'day' : 'days'}`;
  return 'over a month';
}

export function xpGaugeLines(
  gauge: ClientXpGauge | undefined,
  char: { level: number; xp: number; xpForNextLevel: number },
  longFight: boolean,
): XpGaugeLines {
  const next = `Level ${char.level + 1}`;
  if (gauge?.noXp) return { rate: '0 XP/hr: this room pays no XP', level: `${next}: not from here` };
  if (gauge?.basis === 'run') {
    return { rate: gauge.perHour === undefined ? 'Measuring' : `${formatXpAmount(gauge.perHour)} XP/hr this run so far`, level: null };
  }
  if (!gauge || gauge.basis === 'measuring' || gauge.perHour === undefined) return { rate: 'Measuring', level: `${next}: measuring` };
  const figure = `${formatXpAmount(gauge.perHour)} XP/hr`;
  let rate = gauge.basis === 'steady' ? figure : `about ${figure}`;
  if (longFight) rate += ' (long fight under way)';
  else if (gauge.losing) rate += ' (mostly losing here)';
  const seconds = gauge.perHour > 0 ? (Math.max(0, char.xpForNextLevel - char.xp) / gauge.perHour) * 3600 : null;
  const eta = levelEtaText(seconds);
  return { rate, level: seconds === null ? `${next}: ${eta}` : `${next} in ${eta}` };
}

/** The reset counter: everything earned since the reset, quests included. */
export function xpSinceLine(startTime: number, totalXp: number, now = Date.now()): string {
  const start = new Date(startTime);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const clock = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  const when = start.toDateString() === new Date(now).toDateString() ? clock : `${pad(start.getMonth() + 1)}/${pad(start.getDate())} ${clock}`;
  return `Since ${when}: ${formatXpAmount(totalXp)} XP in ${elapsedText(now - startTime)}`;
}

function elapsedText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}
