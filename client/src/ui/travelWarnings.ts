import type { RouteWarning, ServerStateMessage, WorldMapMeta } from '@idle-party-rpg/shared';

export const NO_WAY_BACK_TEXT = 'Your party knows no way back from there.';

/** "Your hired fighters (A, B) stay behind when your party leaves Somewhere." */
export function hiresLeaveText(names: readonly string[], mapName: string): string {
  return names.length === 1
    ? `Your hired fighter (${names[0]}) stays behind when your party leaves ${mapName}.`
    : `Your hired fighters (${names.join(', ')}) stay behind when your party leaves ${mapName}.`;
}

/** The body of the "Set off?" dialog: one sentence per warning. */
export function routeConfirmBody(warnings: readonly RouteWarning[]): string {
  return warnings.map(w => (w.kind === 'hires_leave' ? hiresLeaveText(w.names, w.mapName) : NO_WAY_BACK_TEXT)).join(' ');
}

/** What a door to `toMapId` costs the party's hires, or null when it keeps them. */
export function doorHiresText(
  state: ServerStateMessage | null,
  maps: readonly WorldMapMeta[],
  toMapId: string | undefined,
): string | null {
  if (!state || !toMapId || toMapId === state.currentMapId) return null;
  const hires = state.social?.party?.henchmen ?? [];
  if (hires.length === 0) return null;
  const mapName = maps.find(m => m.id === state.currentMapId)?.name || 'this map';
  return hiresLeaveText(hires.map(h => h.name ?? 'your henchman'), mapName);
}

/** A hire made now won't last the party's route. */
export function hireLeftBehindText(name: string): string {
  return `${name} will be left behind: your party's route leads to another map.`;
}

/** Whether the party's route still has a door to another map ahead. */
export function routeLeavesMap(state: ServerStateMessage | null): boolean {
  return state?.party?.route?.leavesMap === true;
}
