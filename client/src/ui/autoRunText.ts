import { AUTO_RUN_ROOM_MS } from '@idle-party-rpg/shared';

const SECONDS = AUTO_RUN_ROOM_MS / 1000;
const PACE = SECONDS === 1 ? 'a room every second' : `a room every ${SECONDS} seconds`;

/** Tooltip for the Autorun buttons on the battle screen and the map. */
export function autoRunTitle(on: boolean): string {
  return on
    ? `Autorun is on: while it has somewhere to walk, the party moves ${PACE}`
    : `Autorun: travel ${PACE}`;
}
