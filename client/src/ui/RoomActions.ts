import type {
  DungeonDefinition,
  MapTransitionLink,
  NpcDefinition,
  ServerStateMessage,
  ShopSummary,
  WorldMapMeta,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import { levelBandText } from './roomLevels';
import type { LevelBand } from './roomLevels';

export type RoomActionKind = 'npc' | 'shop' | 'dungeon' | 'travel';

export interface RoomAction {
  kind: RoomActionKind;
  icon: string;
  name: string;
  detail?: string;
  /** NPC, shop or dungeon id; for travel, the destination tile GUID. */
  targetId: string;
  questReady?: boolean;
  questAvailable?: boolean;
  /** NPC only: one of the quests it can hand out now moves the main story on. */
  questMain?: boolean;
  /** Travel only: the client's preview says this exit would refuse the party. */
  locked?: boolean;
  /** Travel only: the monsters behind this exit are far above the party. */
  danger?: boolean;
}

export interface QuestMarks {
  ready: ReadonlySet<string>;
  available: ReadonlySet<string>;
  /** The main story's quests and the guide's steps toward it. */
  main: ReadonlySet<string>;
}

export interface RoomActionLookups {
  getNpc(id: string): NpcDefinition | undefined;
  getShop(id: string): ShopSummary | undefined;
  getDungeon(id: string): DungeonDefinition | undefined;
  getTileByGuid(id: string): WorldTileDefinition | undefined;
  getMaps(): WorldMapMeta[];
  /** Without it, exits carry no monster level. */
  getRoomLevels?(def: WorldTileDefinition): LevelBand | undefined;
  /** Without it, no exit is marked as far above the party. */
  isLevelDanger?(band: LevelBand): boolean;
}

export type RoomContents = Pick<WorldTileDefinition, 'npcId' | 'shopId' | 'dungeonId' | 'transitions'>;

export const ROOM_ICONS = {
  shop: '🪙',
  hire: '🤝',
  dungeon: '🗝️',
  travel: '🌀',
  players: '👥',
  lock: '🔒',
} as const;

export const LOCKED_DETAIL = 'Locked';

export const QUEST_READY_DETAIL = 'Quest ready to turn in';
export const QUEST_AVAILABLE_DETAIL = 'New quest available';
export const QUEST_MAIN_DETAIL = 'Main story quest available';
export const HIRE_DETAIL = 'Henchmen for hire';
export const LEVEL_DANGER_TEXT = 'Far above your party';

const NO_QUEST_MARKS: QuestMarks = { ready: new Set(), available: new Set(), main: new Set() };

/** Everything a room offers, in display order: NPC, shop, dungeon, then one entry per exit. */
export function getRoomActions(
  room: RoomContents,
  lookups: RoomActionLookups,
  quests: QuestMarks = NO_QUEST_MARKS,
): RoomAction[] {
  const actions: RoomAction[] = [];

  const npc = room.npcId ? lookups.getNpc(room.npcId) : undefined;
  if (npc) actions.push(npcAction(npc, quests));

  const shop = room.shopId ? lookups.getShop(room.shopId) : undefined;
  if (shop) actions.push(shopAction(shop));

  const dungeon = room.dungeonId ? lookups.getDungeon(room.dungeonId) : undefined;
  if (dungeon) {
    actions.push({ kind: 'dungeon', icon: ROOM_ICONS.dungeon, name: dungeon.name, targetId: dungeon.id });
  }

  for (const link of room.transitions ?? []) {
    const dest = lookups.getTileByGuid(link.tileId);
    const levels = dest ? lookups.getRoomLevels?.(dest) : undefined;
    actions.push({
      kind: 'travel',
      icon: ROOM_ICONS.travel,
      name: transitionName(link, dest, lookups),
      targetId: link.tileId,
      ...(levels ? { detail: levelBandText(levels) } : {}),
      ...(levels && lookups.isLevelDanger?.(levels) ? { danger: true } : {}),
    });
  }

  return actions;
}

/** Marks each travel action whose exit `isLocked` refuses; other actions pass through untouched. */
export function lockTravel(
  actions: RoomAction[],
  room: Pick<RoomContents, 'transitions'>,
  isLocked: (link: MapTransitionLink) => boolean,
): RoomAction[] {
  const links = room.transitions ?? [];
  if (links.length === 0) return actions;
  return actions.map(action => {
    if (action.kind !== 'travel') return action;
    const link = links.find(l => l.tileId === action.targetId);
    return link && isLocked(link) ? { ...action, locked: true } : action;
  });
}

/** Button/chip text for acting on a room action. */
export function actionLabel(action: RoomAction): string {
  switch (action.kind) {
    case 'npc': return `Talk to ${action.name}`;
    case 'shop': return action.name;
    case 'dungeon': return `Enter ${action.name}`;
    case 'travel': return `Travel to ${action.name}`;
  }
}

/** One word for where a chip has no room for the full label. */
export function actionShortLabel(action: RoomAction): string {
  switch (action.kind) {
    case 'npc': return 'Talk';
    case 'shop': return action.icon === ROOM_ICONS.hire ? 'Hire' : 'Shop';
    case 'dungeon': return 'Dungeon';
    case 'travel': return 'Travel';
  }
}

/** Quests ready to turn in, quests some NPC can hand out now and the main story's, from the latest state push. */
export function questMarks(state?: ServerStateMessage | null): QuestMarks {
  const ready = (state?.activeQuests ?? []).filter(q => q.status === 'ready').map(q => q.questId);
  const guide = state?.questGuide;
  const main = [...(guide?.mainQuestIds ?? []), ...(guide?.steps ?? []).map(step => step.questId)];
  return { ready: new Set(ready), available: new Set(state?.availableQuestIds ?? []), main: new Set(main) };
}

/** A turn-in wins over a new main-story quest, which wins over any other new quest. */
export function questPipClass(action: RoomAction): string {
  if (action.questReady) return 'quest-ready-pip';
  if (action.questMain) return 'quest-main-pip';
  if (action.questAvailable) return 'quest-available-pip';
  return '';
}

function npcAction(npc: NpcDefinition, quests: QuestMarks): RoomAction {
  const action: RoomAction = { kind: 'npc', icon: npc.emoji, name: npc.name, targetId: npc.id };
  const questIds = npc.questIds ?? [];
  if (questIds.some(id => quests.ready.has(id))) return { ...action, detail: QUEST_READY_DETAIL, questReady: true };
  const available = questIds.filter(id => quests.available.has(id));
  if (available.some(id => quests.main.has(id))) return { ...action, detail: QUEST_MAIN_DETAIL, questAvailable: true, questMain: true };
  if (available.length > 0) return { ...action, detail: QUEST_AVAILABLE_DETAIL, questAvailable: true };
  return action;
}

function shopAction(shop: ShopSummary): RoomAction {
  const hireOnly = shop.hiresHenchmen && !shop.sellsItems;
  return {
    kind: 'shop',
    icon: hireOnly ? ROOM_ICONS.hire : ROOM_ICONS.shop,
    name: shop.name,
    targetId: shop.id,
    ...(shop.sellsItems && shop.hiresHenchmen ? { detail: HIRE_DETAIL } : {}),
  };
}

function transitionName(link: MapTransitionLink, dest: WorldTileDefinition | undefined, lookups: RoomActionLookups): string {
  if (dest?.name) return dest.name;
  return lookups.getMaps().find(m => m.id === link.mapId)?.name ?? 'a passage';
}
