import type {
  MonsterDefinition,
  ItemDefinition,
  ZoneDefinition,
  EncounterDefinition,
  WorldData,
  SetDefinition,
  ShopDefinition,
  TileTypeDefinition,
  RecipeDefinition,
  NpcDefinition,
  QuestDefinition,
  DungeonDefinition,
  SkillDefinition,
  SkillSlot,
} from '@idle-party-rpg/shared';

export interface OverviewData {
  onlinePlayers: number;
  totalSessions: number;
  totalConnections: number;
  totalAccounts: number;
  uptime: number;
}

export interface SessionRecord {
  deviceToken: string;
  ip: string;
  userAgent: string;
  timestamp: string;
}

export interface AccountData {
  email: string;
  username: string | null;
  verified: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  isOnline: boolean;
  className: string | null;
  level: number | null;
  deactivated: boolean;
  hasReactivationRequest: boolean;
  reactivationRequest: string | null;
  sessionHistory: SessionRecord[];
}

export type AccountSortColumn = 'username' | 'email' | 'status' | 'level' | 'class' | 'created' | 'lastActive';
export type SortDirection = 'asc' | 'desc';

export interface InviteListData {
  inviteOnly: boolean;
  emails: string[];
}

export interface ContentData {
  monsters: Record<string, MonsterDefinition>;
  items: Record<string, ItemDefinition>;
  zones: Record<string, ZoneDefinition>;
  encounters: Record<string, EncounterDefinition>;
  sets: Record<string, SetDefinition>;
  shops: Record<string, ShopDefinition>;
  tileTypes: Record<string, TileTypeDefinition>;
  recipes: Record<string, RecipeDefinition>;
  npcs: Record<string, NpcDefinition>;
  quests: Record<string, QuestDefinition>;
  dungeons: Record<string, DungeonDefinition>;
  skills: Record<string, SkillDefinition>;
  skillSlotSchedules: Record<string, SkillSlot[]>;
  world: WorldData;
}

export interface ContentVersion {
  id: string;
  name: string;
  status: 'draft' | 'published';
  isActive: boolean;
  createdAt: string;
  createdFrom: string | null;
  publishedAt: string | null;
}

export type TabId =
  | 'overview'
  | 'accounts'
  | 'invite-list'
  | 'monsters'
  | 'items'
  | 'sets'
  | 'shops'
  | 'recipes'
  | 'npcs'
  | 'quests'
  | 'zones'
  | 'encounters'
  | 'tile-types'
  | 'dungeons'
  | 'maps'
  | 'map'
  | 'versions'
  | 'skills'
  | 'xp-table';

export interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

export const TABS: TabDef[] = [
  { id: 'overview',   label: 'Overview',   icon: '≡' },
  { id: 'accounts',   label: 'Accounts',   icon: '⌂' },
  { id: 'invite-list', label: 'Invite List', icon: '✉' },
  { id: 'monsters',   label: 'Monsters',   icon: '☠' },
  { id: 'items',      label: 'Items',      icon: '❖' },
  { id: 'sets',       label: 'Sets',       icon: '✦' },
  { id: 'shops',      label: 'Shops',      icon: '¤' },
  { id: 'recipes',    label: 'Recipes',    icon: '⚒' },
  { id: 'npcs',       label: 'NPCs',       icon: '☺' },
  { id: 'quests',     label: 'Quests',     icon: '!' },
  { id: 'zones',      label: 'Zones',      icon: '○' },
  { id: 'encounters', label: 'Encounters', icon: '⚔' },
  { id: 'tile-types', label: 'Tile Types', icon: '■' },
  { id: 'dungeons',   label: 'Dungeons',   icon: '⛬' },
  { id: 'maps',       label: 'Maps',       icon: '▤' },
  { id: 'map',        label: 'Map Editor', icon: '⌖' },
  { id: 'versions',   label: 'Versions',   icon: '⧉' },
  { id: 'skills',     label: 'Skills',     icon: '✥' },
  { id: 'xp-table',   label: 'XP Table',   icon: '✨' },
];

export type UiSize = 'small' | 'medium' | 'large' | 'xlarge';
