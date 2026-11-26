import { XP_LEVEL_GAP } from '@idle-party-rpg/shared';
import type { ServerStateMessage } from '@idle-party-rpg/shared';

/** Lowest and highest authored monster level, as `/api/world` sends it. */
export type LevelBand = readonly [number, number];

/** A line about a room's monsters next to the party's own level. */
export interface LevelNote {
  text: string;
  /** The monsters are far enough above the party to say so in red. */
  danger: boolean;
}

type LevelState = Pick<ServerStateMessage, 'character' | 'social' | 'username'>;

/** "Lv 16", or "Lv 16–17" for a band. */
export function levelBandText([min, max]: LevelBand): string {
  return min === max ? `Lv ${min}` : `Lv ${min}–${max}`;
}

/** The highest level among the party's players, the viewer included; henchmen never count. Null before the character loads. */
export function partyBestLevel(state: LevelState | null | undefined): number | null {
  const own = state?.character?.level;
  if (!own) return null;
  let best = own;
  for (const member of state?.social?.party?.members ?? []) {
    if (member.level && member.level > best) best = member.level;
  }
  return best;
}

/** Past the levels where a harder monster still pays more, the party is outmatched. */
export function isLevelDanger(band: LevelBand, partyBest: number | null): boolean {
  return partyBest !== null && band[0] - partyBest > XP_LEVEL_GAP.challengeLevels;
}

/** "Monsters there are level 16. Your party's best is level 6.", or null when the room's levels are unknown. */
export function travelLevelNote(band: LevelBand | undefined, state: LevelState | null | undefined): LevelNote | null {
  const best = partyBestLevel(state);
  if (!band || best === null) return null;
  const monsters = band[0] === band[1] ? `level ${band[0]}` : `level ${band[0]}–${band[1]}`;
  const solo = !(state?.social?.party?.members ?? []).some(m => m.username !== state?.username);
  const party = solo ? `You're level ${best}.` : `Your party's best is level ${best}.`;
  return { text: `Monsters there are ${monsters}. ${party}`, danger: isLevelDanger(band, best) };
}
