import type { ItemDefinition } from './ItemTypes.js';
import type { MonsterTier } from './MonsterTypes.js';
import type { WorldTileDefinition } from '../hex/MapSchema.js';

export const CODEX_KINDS = ['monster', 'item', 'room', 'shop'] as const;
export type CodexKind = typeof CODEX_KINDS[number];

export interface CodexRef {
  kind: CodexKind;
  id: string;
}

export const CODEX_ID_MAX_LENGTH = 200;
export const CODEX_RECENT_MAX = 20;
export const CODEX_DROP_TALLY_MAX = 1_000_000_000;
export const CODEX_CAPS = {
  monsters: 5000,
  encounters: 5000,
  items: 10000,
  shops: 1000,
  dungeons: 1000,
  dropPairs: 20000,
} as const;

/** One player's saved Codex knowledge. Every part is optional: absent means empty. Lists are in discovery order. */
export interface CodexSaveData {
  /** Monsters met in a fight as a human fighter, any outcome. */
  monsters?: string[];
  /** Overworld encounters fought, anywhere. */
  encounters?: string[];
  /** Items that have been in this player's bags. */
  items?: string[];
  /** Shops whose room this player fought in. */
  shops?: string[];
  /** Dungeons this player fought in. */
  dungeons?: string[];
  /** monsterId -> itemId -> times that drop reached this player's bags. */
  drops?: Record<string, Record<string, number>>;
  /** Newest first; monster, item and shop refs only. */
  recent?: CodexRef[];
}

export interface ClientRequestCodexMessage {
  type: 'request_codex';
}

export interface CodexMonsterDrop {
  itemId: string;
  seen: number;
}

export interface CodexMonster {
  id: string;
  name: string;
  /** Authored levels only, clamped. */
  level?: number;
  tier: MonsterTier;
  description?: string;
  passive?: true;
  kills: number;
  /** Drops received, existing items only, most seen first. */
  drops: CodexMonsterDrop[];
  /** Distinct existing items in the definition's drops with chance > 0. */
  dropKinds: number;
}

export interface CodexItem {
  def: ItemDefinition;
  /** Has been in this player's bags. */
  found: boolean;
}

export interface CodexShopStock {
  itemId: string;
  price: number;
}

export interface CodexShopHire {
  name: string;
  emoji: string;
  level: number;
}

export interface CodexShop {
  id: string;
  name: string;
  /** Existing items only, in shop order. */
  stock: CodexShopStock[];
  hires: CodexShopHire[];
}

/** One encounter table that at least one found room uses. */
export interface CodexTable {
  /** `codexTableKey` of the rooms that use it. */
  key: string;
  /** Met monsters this table can spawn. */
  monsters: string[];
  /** Indexes into `ServerCodexMessage.fights`. */
  fights: number[];
}

export interface CodexDungeon {
  id: string;
  /** Met monsters its floors can spawn. */
  monsters: string[];
}

export interface ServerCodexMessage {
  type: 'codex';
  /** Equals `character.codexVersion` when the reply was built. */
  version: string;
  monsters: CodexMonster[];
  /** Items held, then stock of visited shops not held. */
  items: CodexItem[];
  shops: CodexShop[];
  /** Each fought encounter as its met monsters; identical lists merged. */
  fights: string[][];
  tables: CodexTable[];
  dungeons: CodexDungeon[];
  recent: CodexRef[];
}

/** `r:<roomId>` when the room has its own encounter table, else `z:<zoneId>`: the table a fight there rolls from. */
export function codexTableKey(room: Pick<WorldTileDefinition, 'id' | 'zone' | 'encounterTable'>): string {
  return room.encounterTable && room.encounterTable.length > 0 ? `r:${room.id}` : `z:${room.zone}`;
}

/** `kind:id`, the value of a `data-codex` attribute. */
export function codexRefKey(ref: CodexRef): string {
  return `${ref.kind}:${ref.id}`;
}

export function isCodexKind(raw: unknown): raw is CodexKind {
  return typeof raw === 'string' && (CODEX_KINDS as readonly string[]).includes(raw);
}

/** A string of 1..CODEX_ID_MAX_LENGTH characters. */
export function isCodexId(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= 1 && raw.length <= CODEX_ID_MAX_LENGTH;
}

/** The inverse of `codexRefKey`; null for an unknown kind or an id outside 1..CODEX_ID_MAX_LENGTH. Splits at the first ':'. */
export function parseCodexRefKey(key: string): CodexRef | null {
  if (typeof key !== 'string') return null;
  const at = key.indexOf(':');
  if (at < 0) return null;
  const kind = key.slice(0, at);
  const id = key.slice(at + 1);
  return isCodexKind(kind) && isCodexId(id) ? { kind, id } : null;
}

/** Kind and id checks shared by the save sanitiser and the link parser. */
export function isCodexRef(raw: unknown): raw is CodexRef {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const ref = raw as { kind?: unknown; id?: unknown };
  return isCodexKind(ref.kind) && isCodexId(ref.id);
}
