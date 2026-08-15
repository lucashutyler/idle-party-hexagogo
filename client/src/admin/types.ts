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
  DesignNote,
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

/** Mirrors server/src/auth/AdminRoles.ts. */
export type AdminRole = 'admin' | 'superadmin';

/** GET /api/admin/me — who the dashboard is signed in as. */
export interface AdminMe {
  email: string;
  username: string | null;
  role: AdminRole;
  isSuperAdmin: boolean;
  via: 'session' | 'token';
}

/** An API token as the dashboard sees it. The secret itself is only ever shown once, at creation. */
export interface ApiTokenData {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
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
  /** Granted admin role, or null. Suspended admins keep their grant until it's cleared. */
  role: AdminRole | null;
  /** True when the role comes from ADMIN_EMAILS and can't be edited here. */
  roleLocked: boolean;
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
  designNotes: Record<string, DesignNote>;
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
  | 'xp-table'
  | 'api-tokens';

export interface TabDef {
  id: TabId;
  label: string;
  icon: string;
  /** Renders in the sidebar's utility cluster at the bottom, alongside UI Size and Refresh. */
  footer?: boolean;
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
  { id: 'api-tokens', label: 'API Tokens', icon: '⚿', footer: true },
];

export type UiSize = 'small' | 'medium' | 'large' | 'xlarge';
