/** Why the server would not send the party somewhere, besides a room's gate. */
export type RouteRefusal = 'no_party' | 'in_dungeon' | 'gone' | 'not_walkable' | 'no_route' | 'too_soon';

const ROUTE_REFUSAL_TEXT: Record<RouteRefusal, string> = {
  no_route: "Your party hasn't found a way there yet.",
  in_dungeon: 'Leave the dungeon before traveling',
  not_walkable: "You can't walk there",
  gone: 'That room is gone.',
  no_party: 'Your party is still getting ready. Try again in a moment.',
  too_soon: 'Give your party a moment between orders, then try again.',
};

/** What a member who isn't the owner or a leader is told when they try to steer the party. */
export const LEADERS_ONLY = {
  move: 'Only the party owner or a leader can move',
  autoRun: 'Only the party owner or a leader can change Autorun',
  travel: 'Only the party owner or a leader can travel',
  leaveDungeon: 'Only the party owner or a leader can leave a dungeon',
} as const;

export function moveRefusalText(reason: RouteRefusal): string {
  return ROUTE_REFUSAL_TEXT[reason];
}
