import type { CodexKind, CodexMonster, CodexRef, CodexShop, ItemDefinition, ServerStateMessage, WorldTileDefinition } from '@idle-party-rpg/shared';
import { buildMasteryEntry, codexRefKey, getEquippedItemIds } from '@idle-party-rpg/shared';
import { levelBadge, masteryStars, nextRankText, TIER_BADGES } from '../BestiaryModal';
import { codexLinkHtml, codexTargetAttr } from '../codexLinks';
import { RARITY_COLORS, SLOT_LABELS, escapeHtml, getItemInitials } from '../ItemIcon';
import { renderItemPopupContent } from '../ItemPopup';
import { artworkUrl, placeholderUrl, renderAssetImg, renderTrackedImg } from '../assets';
import { ROOM_ICONS } from '../RoomActions';
import { isLevelDanger, levelBandText, partyBestLevel, travelLevelNote } from '../roomLevels';
import type { CodexIndex, CodexItemEntry, CodexSort, CodexTravelBlock, CodexWorld } from './codexModel';
import {
  closestRooms,
  hasCodexEntry,
  itemQuestLines,
  monsterKills,
  ownedItemIds,
  partyRoom,
  roomGroups,
  roomName,
  searchCodex,
  sortItems,
  sortMonsters,
  sortShops,
  travelBlock,
} from './codexModel';

export const CODEX_PAGE = 100;
export const CODEX_HOME_RECENT = 8;
export const CODEX_SEARCH_PREVIEW = 5;
export const CODEX_ROOM_PREVIEW = 10;

export const LIST_TITLES: Readonly<Record<CodexKind, string>> = {
  monster: 'Monsters',
  item: 'Items',
  room: 'Rooms',
  shop: 'Shops',
};

const LIST_ORDER: readonly CodexKind[] = ['monster', 'item', 'room', 'shop'];
const NOTHING_YET = 'Nothing here yet. Fight, explore and shop, and what you find is written down here.';

const MISSING_HINTS: Readonly<Record<CodexKind, string>> = {
  monster: "Monsters appear here once you've fought them.",
  item: "Items appear here once you've had one, or seen it in a shop or a recipe.",
  room: "Rooms appear here once you've found them on the map.",
  shop: 'Shops appear here once your party has stood in their room.',
};

export const TRAVEL_BLOCK_TEXT: Readonly<Record<Exclude<CodexTravelBlock, null>, string>> = {
  dungeon: 'Leave the dungeon before traveling',
  not_leader: 'Only the party owner or a leader can move',
};

export interface CodexViewContext {
  index: CodexIndex;
  state: ServerStateMessage | null;
  world: CodexWorld;
}

export interface CodexHomeOptions {
  query: string;
  newKeys: ReadonlySet<string>;
}

export interface CodexListOptions {
  query: string;
  sort: CodexSort;
  shown: number;
  /** Zone keys (`codexZoneKey`) the player opened or closed; others follow the party's zone. */
  zones: ReadonlyMap<string, boolean>;
  zoneShown: ReadonlyMap<string, number>;
}

const n = (value: number): string => value.toLocaleString('en-US');
const plural = (count: number, one: string, many: string): string => `${n(count)} ${count === 1 ? one : many}`;
const times = (count: number): string => plural(count, 'time', 'times');

export function codexZoneKey(mapId: string, zoneId: string): string {
  return `${mapId}|${zoneId}`;
}

function section(title: string, body: string, className = ''): string {
  return `<section class="codex-section${className ? ` ${className}` : ''}"><h3 class="codex-section-title">${escapeHtml(title)}</h3>${body}</section>`;
}

function lines(items: readonly string[]): string {
  return `<ul class="codex-lines">${items.map(item => `<li class="codex-line">${item}</li>`).join('')}</ul>`;
}

function meta(text: string): string {
  return `<span class="codex-meta">${escapeHtml(text)}</span>`;
}

function emptyLine(text: string): string {
  return `<p class="codex-empty">${escapeHtml(text)}</p>`;
}

function moreButton(left: number, key: string): string {
  return `<button type="button" class="codex-more" data-codex-more="${escapeHtml(key)}">Show more (${n(left)} left)</button>`;
}

/** Drops seen, and how many there are; seen drops of items since taken off the monster still count. */
function dropCounts(monster: Pick<CodexMonster, 'drops' | 'dropKinds'>): { found: number; kinds: number } {
  return { found: monster.drops.length, kinds: Math.max(monster.dropKinds, monster.drops.length) };
}

function tierChip(monster: Pick<CodexMonster, 'tier'>): string {
  const tier = TIER_BADGES[monster.tier];
  return tier ? `<span class="bestiary-tier" data-tier="${escapeHtml(monster.tier)}">${tier.glyph} ${tier.label}</span>` : '';
}

function monsterLevel(monster: Pick<CodexMonster, 'level'>, state: ServerStateMessage | null): string {
  return monster.level !== undefined ? levelBadge(monster.level, state?.character?.level) : '';
}

function itemArt(def: ItemDefinition): string {
  const color = RARITY_COLORS[def.rarity] ?? RARITY_COLORS.common;
  const inner = def.iconEmoji
    ? `<span class="codex-item-emoji">${escapeHtml(def.iconEmoji)}</span>`
    : `${renderTrackedImg(artworkUrl('item', def.id), { className: 'codex-item-img', lazy: true })}<span class="codex-item-initials">${escapeHtml(getItemInitials(def.name))}</span>`;
  return `<span class="codex-row-art codex-item-art" style="--rarity:${color}" aria-hidden="true">${inner}</span>`;
}

function itemKindText(def: ItemDefinition): string {
  if (def.equipSlot) return SLOT_LABELS[def.equipSlot] ?? def.equipSlot;
  return def.consumable ? 'Consumable' : 'Material';
}

function ownedText(itemId: string, state: ServerStateMessage | null): string {
  const count = state?.character?.inventory?.[itemId] ?? 0;
  const equipped = getEquippedItemIds(state?.character?.equipment ?? {}).has(itemId);
  return [count > 0 ? `You have ${n(count)}` : '', equipped ? 'Equipped' : ''].filter(Boolean).join(' · ');
}

function rowButton(ref: CodexRef, art: string, title: string, sub: string, tags = ''): string {
  return `<button type="button" class="codex-row" data-codex="${codexTargetAttr(ref)}">`
    + art
    + `<span class="codex-row-main"><span class="codex-row-title">${title}${tags}</span>`
    + (sub ? `<span class="codex-row-sub">${sub}</span>` : '')
    + '</span><span class="codex-row-chevron" aria-hidden="true">›</span></button>';
}

function monsterRow(monster: CodexMonster, ctx: CodexViewContext, tags = ''): string {
  const art = `<span class="codex-row-art" aria-hidden="true">${renderAssetImg('monster', monster.id, { label: monster.name, width: 80, height: 80, alt: '' })}</span>`;
  const kills = monsterKills(monster, ctx.state);
  const drops = dropCounts(monster);
  const parts = [
    monster.passive ? '' : kills > 0 ? `${n(kills)} defeated` : 'Not defeated yet',
    drops.kinds > 0 ? `${n(drops.found)} of ${n(drops.kinds)} drops found` : '',
  ].filter(Boolean);
  const title = `<span class="codex-row-name">${escapeHtml(monster.name)}</span>${monsterLevel(monster, ctx.state)}${tierChip(monster)}`;
  return rowButton({ kind: 'monster', id: monster.id }, art, title, escapeHtml(parts.join(' · ')), tags);
}

function itemRow(entry: CodexItemEntry, ctx: CodexViewContext, tags = ''): string {
  const { def } = entry;
  const owned = ownedText(def.id, ctx.state);
  const status = owned || (entry.found ? 'Found' : 'Not found yet');
  const color = RARITY_COLORS[def.rarity] ?? RARITY_COLORS.common;
  const title = `<span class="codex-row-name" style="color:${color}">${escapeHtml(def.name)}</span>`;
  return rowButton({ kind: 'item', id: def.id }, itemArt(def), title, escapeHtml(`${itemKindText(def)} · ${status}`), tags);
}

function roomIcons(tile: WorldTileDefinition, ctx: CodexViewContext): string {
  const shop = tile.shopId ? ctx.world.getShop(tile.shopId) : undefined;
  const npc = tile.npcId ? ctx.world.getNpc(tile.npcId) : undefined;
  const icons = [
    shop ? (shop.sellsItems ? ROOM_ICONS.shop : ROOM_ICONS.hire) : '',
    npc?.emoji ?? '',
    tile.dungeonId && ctx.world.getDungeon(tile.dungeonId) ? ROOM_ICONS.dungeon : '',
  ].filter(Boolean);
  return icons.length > 0 ? `<span class="codex-row-icons" aria-hidden="true">${icons.map(escapeHtml).join('')}</span>` : '';
}

function mapName(world: CodexWorld, mapId: string): string {
  return world.getMaps().find(m => m.id === mapId)?.name || mapId;
}

function placeText(tile: WorldTileDefinition, world: CodexWorld): string {
  return [tile.zoneName, mapName(world, tile.mapId)].filter(Boolean).join(' · ');
}

function roomRow(tile: WorldTileDefinition, ctx: CodexViewContext, withPlace: boolean): string {
  const here = partyRoom(ctx.state, ctx.world)?.id === tile.id;
  const band = ctx.world.getRoomLevels(tile);
  const sub = [band ? levelBandText(band) : '', withPlace ? placeText(tile, ctx.world) : ''].filter(Boolean).join(' · ');
  const chip = here ? '<span class="codex-chip codex-chip-here">You are here</span>' : '';
  const title = `<span class="codex-row-name">${escapeHtml(roomName(tile))}</span>${roomIcons(tile, ctx)}${chip}`;
  return rowButton({ kind: 'room', id: tile.id }, '', title, escapeHtml(sub));
}

function shopSummaryText(shop: CodexShop, ctx: CodexViewContext): string {
  const rooms = ctx.index.roomsOfShop.get(shop.id)?.length ?? 0;
  return [
    shop.stock.length > 0 ? `Sells ${plural(shop.stock.length, 'item', 'items')}` : '',
    shop.hires.length > 0 ? 'Hires fighters' : '',
    rooms > 0 ? `In ${plural(rooms, 'room', 'rooms')}` : '',
  ].filter(Boolean).join(' · ');
}

function shopRow(shop: CodexShop, ctx: CodexViewContext, tags = ''): string {
  const art = `<span class="codex-row-art" aria-hidden="true">${renderAssetImg('shop', shop.id, { label: shop.name, width: 80, height: 80, alt: '' })}</span>`;
  const title = `<span class="codex-row-name">${escapeHtml(shop.name)}</span>`;
  return rowButton({ kind: 'shop', id: shop.id }, art, title, escapeHtml(shopSummaryText(shop, ctx)), tags);
}

function refRow(ref: CodexRef, ctx: CodexViewContext, tags = ''): string {
  switch (ref.kind) {
    case 'monster': {
      const monster = ctx.index.monsters.get(ref.id);
      return monster ? monsterRow(monster, ctx, tags) : '';
    }
    case 'item': {
      const item = ctx.index.items.get(ref.id);
      return item ? itemRow(item, ctx, tags) : '';
    }
    case 'room': {
      const tile = ctx.index.rooms.get(ref.id);
      return tile ? roomRow(tile, ctx, true) : '';
    }
    case 'shop': {
      const shop = ctx.index.shops.get(ref.id);
      return shop ? shopRow(shop, ctx, tags) : '';
    }
  }
}

/** A link when `ref` has an entry, else the name as plain text. */
function linkOrText(ref: CodexRef, label: string, ctx: CodexViewContext): string {
  return hasCodexEntry(ctx.index, ref) ? codexLinkHtml(ref, label) : escapeHtml(label);
}

function goButton(roomId: string, label: string, block: CodexTravelBlock, className = 'codex-btn codex-btn-primary'): string {
  const disabled = block ? ' disabled' : '';
  return `<button type="button" class="${className}" data-codex-go="${escapeHtml(roomId)}"${disabled}>${escapeHtml(label)}</button>`;
}

function blockNote(block: CodexTravelBlock): string {
  return block ? `<p class="codex-note">${escapeHtml(TRAVEL_BLOCK_TEXT[block])}</p>` : '';
}

export function codexLoadingHtml(): string {
  return '<p class="codex-status">Opening your Codex…</p>';
}

export function codexMissingHtml(kind: CodexKind): string {
  return '<div class="codex-missing">'
    + '<p class="codex-missing-title">You haven\'t discovered this yet.</p>'
    + `<p class="codex-missing-hint">${escapeHtml(MISSING_HINTS[kind])}</p></div>`;
}

function searchResultsHtml(ctx: CodexViewContext, query: string): string {
  const found = searchCodex(ctx.index, query);
  const groups = LIST_ORDER.filter(kind => found[kind].length > 0).map(kind => {
    const refs = found[kind];
    const rows = refs.slice(0, CODEX_SEARCH_PREVIEW).map(ref => refRow(ref, ctx)).join('');
    const more = refs.length > CODEX_SEARCH_PREVIEW
      ? `<button type="button" class="codex-more" data-codex-see="${kind}">See all ${n(refs.length)}</button>`
      : '';
    return section(LIST_TITLES[kind], `<div class="codex-rows">${rows}</div>${more}`);
  });
  return groups.length > 0 ? groups.join('') : emptyLine(`Nothing you've discovered matches “${query.trim()}”.`);
}

export function codexHomeHtml(ctx: CodexViewContext, opts: CodexHomeOptions): string {
  if (opts.query.trim()) return searchResultsHtml(ctx, opts.query);
  const { index } = ctx;
  const empty = index.monsters.size === 0 && index.items.size === 0 && index.shops.size === 0;
  const recent = index.recent.slice(0, CODEX_HOME_RECENT).map(ref => {
    const tag = opts.newKeys.has(codexRefKey(ref)) ? '<span class="codex-chip codex-chip-new">New</span>' : '';
    return refRow(ref, ctx, tag);
  }).join('');
  const top = empty
    ? emptyLine(NOTHING_YET)
    : recent ? section('Recently found', `<div class="codex-rows">${recent}</div>`, 'codex-recent') : '';
  const counts: Record<CodexKind, number> = {
    monster: index.monsters.size,
    item: index.items.size,
    room: index.rooms.size,
    shop: index.shops.size,
  };
  const lists = LIST_ORDER.map(kind =>
    `<button type="button" class="codex-list-link" data-codex="${codexTargetAttr({ kind: 'list', list: kind })}">`
    + `<span class="codex-list-name">${LIST_TITLES[kind]}</span><span class="codex-list-count">${n(counts[kind])}</span>`
    + '<span class="codex-row-chevron" aria-hidden="true">›</span></button>').join('');
  return `${top}<nav class="codex-lists" aria-label="Codex sections">${lists}</nav>`
    + '<p class="codex-footnote">Drops, fights and shop visits are added as you play.</p>';
}

function pagedRows(rows: readonly string[], shown: number, key: string): string {
  const left = rows.length - shown;
  return `<div class="codex-rows">${rows.slice(0, shown).join('')}</div>${left > 0 ? moreButton(left, key) : ''}`;
}

function matches(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || name.toLowerCase().includes(q);
}

function noMatchHtml(query: string): string {
  return emptyLine(`Nothing you've discovered matches “${query.trim()}”.`);
}

function roomListHtml(ctx: CodexViewContext, opts: CodexListOptions): string {
  const rooms = [...ctx.index.rooms.values()];
  if (opts.query.trim()) {
    const refs = searchCodex(ctx.index, opts.query, 'room').room;
    if (refs.length === 0) return noMatchHtml(opts.query);
    return pagedRows(refs.map(ref => roomRow(ctx.index.rooms.get(ref.id)!, ctx, true)), opts.shown, 'list');
  }
  const here = partyRoom(ctx.state, ctx.world);
  const hereKey = here ? codexZoneKey(here.mapId, here.zone) : '';
  return roomGroups(rooms, ctx.world).map(map => {
    const zones = map.zones.map(zone => {
      const key = codexZoneKey(map.mapId, zone.zoneId);
      const open = opts.zones.get(key) ?? key === hereKey;
      const toggle = `<button type="button" class="codex-zone" data-codex-zone="${escapeHtml(key)}" aria-expanded="${open}">`
        + `<span class="codex-zone-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>`
        + `<span class="codex-zone-name">${escapeHtml(zone.zoneName)}</span>`
        + `<span class="codex-zone-count">${plural(zone.rooms.length, 'room', 'rooms')}</span></button>`;
      if (!open) return toggle;
      const shown = opts.zoneShown.get(key) ?? CODEX_PAGE;
      return toggle + pagedRows(zone.rooms.map(tile => roomRow(tile, ctx, false)), shown, `zone:${key}`);
    }).join('');
    return `<div class="codex-map"><h3 class="codex-map-title">${escapeHtml(map.mapName)} · ${plural(map.count, 'room', 'rooms')}</h3>${zones}</div>`;
  }).join('');
}

export function codexListHtml(kind: CodexKind, ctx: CodexViewContext, opts: CodexListOptions): string {
  const { index } = ctx;
  if (kind === 'room') {
    return index.rooms.size === 0 ? emptyLine(NOTHING_YET) : roomListHtml(ctx, opts);
  }
  let rows: string[];
  if (kind === 'monster') {
    rows = sortMonsters([...index.monsters.values()].filter(m => matches(m.name, opts.query)), opts.sort).map(m => monsterRow(m, ctx));
  } else if (kind === 'item') {
    rows = sortItems([...index.items.values()].filter(i => matches(i.def.name, opts.query)), opts.sort).map(i => itemRow(i, ctx));
  } else {
    rows = sortShops([...index.shops.values()].filter(s => matches(s.name, opts.query)), opts.sort).map(s => shopRow(s, ctx));
  }
  if (rows.length === 0) {
    return opts.query.trim() ? noMatchHtml(opts.query) : emptyLine(NOTHING_YET);
  }
  return pagedRows(rows, opts.shown, 'list');
}

function heroHtml(art: string, name: string, tags = ''): string {
  return `<div class="codex-hero"><span class="codex-hero-art" aria-hidden="true">${art}</span>`
    + `<div class="codex-hero-main"><h2 class="codex-hero-name">${escapeHtml(name)}</h2>${tags ? `<div class="codex-hero-tags">${tags}</div>` : ''}</div></div>`;
}

function dungeonLine(dungeonId: string, ctx: CodexViewContext, text: (name: string) => string): string {
  const name = ctx.world.getDungeon(dungeonId)?.name;
  if (!name) return '';
  const entrance = (ctx.index.entrancesOfDungeon.get(dungeonId) ?? [])[0];
  return entrance ? codexLinkHtml({ kind: 'room', id: entrance }, text(name)) : escapeHtml(text(name));
}

export function codexMonsterHtml(monsterId: string, ctx: CodexViewContext, expanded: boolean): string {
  const monster = ctx.index.monsters.get(monsterId);
  if (!monster) return codexMissingHtml('monster');
  const { state, world, index } = ctx;
  const art = renderAssetImg('monster', monster.id, { label: monster.name, width: 192, height: 192, alt: '' });
  const parts = [heroHtml(art, monster.name, monsterLevel(monster, state) + tierChip(monster))];
  if (monster.description) parts.push(`<p class="codex-desc">${escapeHtml(monster.description)}</p>`);

  if (!monster.passive) {
    const kills = monsterKills(monster, state);
    if (kills > 0) {
      const entry = buildMasteryEntry(monster.id, kills, { name: monster.name, tier: monster.tier });
      parts.push('<div class="codex-record">'
        + `<span>Defeated ${times(kills)}</span>`
        + `<span class="bestiary-stars" role="img" aria-label="Rank ${entry.rank} of ${entry.maxRank}">${masteryStars(entry)}</span>`
        + `<span class="codex-meta">${escapeHtml(nextRankText(entry))}</span></div>`);
    } else {
      parts.push('<div class="codex-record">Not defeated yet.</div>');
    }
  }

  const counts = dropCounts(monster);
  if (counts.kinds > 0) {
    const body = monster.drops.length > 0
      ? lines(monster.drops.map(d => `${linkOrText({ kind: 'item', id: d.itemId }, index.items.get(d.itemId)?.def.name ?? 'Unknown item', ctx)}${meta(`seen ${times(d.seen)}`)}`))
      : emptyLine('No drops found yet. Drops are added when they land in your bags.');
    parts.push(section(`Drops · ${n(counts.found)} of ${n(counts.kinds)} found`, body));
  }

  const roomIds = closestRooms(index.roomsOfMonster.get(monster.id) ?? [], state, world);
  const dungeons = (index.dungeonsOfMonster.get(monster.id) ?? [])
    .map(id => dungeonLine(id, ctx, name => `In ${name} (dungeon)`)).filter(Boolean);
  const where: string[] = [];
  if (roomIds.length > 0) {
    const hereId = partyRoom(state, world)?.id;
    if (hereId && roomIds.includes(hereId)) {
      where.push('<p class="codex-note">It lives here, in the room your party is in.</p>');
    } else {
      const block = travelBlock(state);
      const nearest = index.rooms.get(roomIds[0])!;
      where.push(`<div class="codex-actions">${goButton(nearest.id, `Go to the nearest: ${roomName(nearest)}`, block)}</div>${blockNote(block)}`);
    }
    const shown = expanded ? roomIds : roomIds.slice(0, CODEX_ROOM_PREVIEW);
    where.push(lines(shown.map(id => {
      const tile = index.rooms.get(id)!;
      return codexLinkHtml({ kind: 'room', id }, roomName(tile)) + meta(placeText(tile, world));
    })));
    if (shown.length < roomIds.length) {
      where.push(`<button type="button" class="codex-more" data-codex-expand="1">Show all ${n(roomIds.length)}</button>`);
    }
  }
  if (dungeons.length > 0) where.push(lines(dungeons));
  if (where.length === 0) where.push(emptyLine("You haven't found where it lives yet."));
  parts.push(section('Where it lives', where.join('')));
  return `<div class="codex-entry">${parts.join('')}</div>`;
}

export function codexItemHtml(itemId: string, ctx: CodexViewContext): string {
  const entry = ctx.index.items.get(itemId);
  if (!entry) return codexMissingHtml('item');
  const { state, world, index } = ctx;
  const { def } = entry;
  const itemDefs: Record<string, ItemDefinition> = {};
  for (const [id, item] of index.items) itemDefs[id] = item.def;
  const card = renderItemPopupContent(def, {
    itemDefs,
    setDefs: state?.setDefinitions ?? {},
    ownedItemIds: ownedItemIds(state),
    equippedItemIds: getEquippedItemIds(state?.character?.equipment ?? {}),
    className: state?.character?.className ?? null,
    skills: world.getSkillContent().skills,
  });
  const parts = [`<div class="codex-item-card">${card}</div>`];
  const owned = ownedText(def.id, state);
  if (owned) parts.push(`<p class="codex-owned">${escapeHtml(owned)}</p>`);

  const sources: string[] = [];
  const droppedBy = (index.droppedBy.get(itemId) ?? []).filter(d => index.monsters.has(d.monsterId));
  if (droppedBy.length > 0) {
    sources.push(section('Dropped by', lines(droppedBy.map(d =>
      codexLinkHtml({ kind: 'monster', id: d.monsterId }, index.monsters.get(d.monsterId)!.name) + meta(`seen ${times(d.seen)}`)))));
  }
  const soldAt = (index.soldAt.get(itemId) ?? []).filter(s => index.shops.has(s.shopId));
  if (soldAt.length > 0) {
    sources.push(section('Sold at', lines(soldAt.map(s =>
      codexLinkHtml({ kind: 'shop', id: s.shopId }, index.shops.get(s.shopId)!.name) + meta(`${n(s.price)} gold`)))));
  }
  const making = index.recipesMaking.get(itemId) ?? [];
  if (making.length > 0) {
    const recipes = making.map(recipe => {
      const ingredients = recipe.ingredients.map(ing => {
        const ingDef = index.items.get(ing.itemId)?.def;
        return `${linkOrText({ kind: 'item', id: ing.itemId }, ingDef?.name ?? 'Unknown item', ctx)}${meta(`×${n(ing.quantity)}`)}`;
      });
      const level = recipe.requiredLevel ? `<p class="codex-meta">Requires level ${n(recipe.requiredLevel)}</p>` : '';
      return `<div class="codex-recipe"><div class="codex-recipe-name">${escapeHtml(recipe.name)}</div>${lines(ingredients)}${level}</div>`;
    }).join('');
    sources.push(section('Crafted from', `${recipes}<div class="codex-actions"><button type="button" class="codex-btn" data-codex-craft="1">Open Craft</button></div>`));
  }
  const using = [...new Set((index.recipesUsing.get(itemId) ?? []).map(r => r.result.itemId))];
  if (using.length > 0) {
    sources.push(section('Used to craft', lines(using.map(id =>
      linkOrText({ kind: 'item', id }, index.items.get(id)?.def.name ?? 'Unknown item', ctx)))));
  }
  const quests = itemQuestLines(itemId, state);
  if (quests.length > 0) {
    sources.push(section('Quests', lines(quests.map(q =>
      escapeHtml(q.kind === 'needed' ? `Needed for ${q.title}` : `Reward from ${q.title}${q.active ? ' (in progress)' : ''}`)))));
  }
  const dungeons = (index.dungeonsRewarding.get(itemId) ?? [])
    .map(id => dungeonLine(id, ctx, name => `Reward in ${name} (dungeon)`)).filter(Boolean);
  if (dungeons.length > 0) sources.push(section('Dungeon reward', lines(dungeons)));

  parts.push(sources.length > 0 ? sources.join('') : emptyLine("You haven't found where this comes from yet."));
  return `<div class="codex-entry">${parts.join('')}</div>`;
}

function roomHereLines(tile: WorldTileDefinition, ctx: CodexViewContext): string[] {
  const { world, index } = ctx;
  const out: string[] = [];
  const npc = tile.npcId ? world.getNpc(tile.npcId) : undefined;
  if (npc) out.push(`<span class="codex-icon" aria-hidden="true">${escapeHtml(npc.emoji)}</span>${escapeHtml(npc.name)}`);
  if (tile.shopId) {
    const summary = world.getShop(tile.shopId);
    const shop = index.shops.get(tile.shopId);
    const name = shop?.name ?? summary?.name;
    const icon = `<span class="codex-icon" aria-hidden="true">${summary && !summary.sellsItems ? ROOM_ICONS.hire : ROOM_ICONS.shop}</span>`;
    if (shop) out.push(icon + codexLinkHtml({ kind: 'shop', id: shop.id }, shop.name));
    else if (name) out.push(icon + escapeHtml(`${name}: visit it to see what it sells.`));
  }
  const dungeon = tile.dungeonId ? world.getDungeon(tile.dungeonId) : undefined;
  if (dungeon) out.push(`<span class="codex-icon" aria-hidden="true">${ROOM_ICONS.dungeon}</span>${escapeHtml(`${dungeon.name} (dungeon)`)}`);
  for (const link of tile.transitions ?? []) {
    const dest = index.rooms.get(link.tileId);
    const icon = `<span class="codex-icon" aria-hidden="true">${ROOM_ICONS.travel}</span>`;
    out.push(dest
      ? `${icon}<span>Door to ${codexLinkHtml({ kind: 'room', id: dest.id }, roomName(dest))}</span>`
      : `${icon}A door to a room you haven't found`);
  }
  return out;
}

export function codexRoomHtml(roomId: string, ctx: CodexViewContext): string {
  const tile = ctx.index.rooms.get(roomId);
  if (!tile) return codexMissingHtml('room');
  const { state, world, index } = ctx;
  const zoneName = tile.zoneName || tile.zone;
  const art = renderTrackedImg(artworkUrl('tile', tile.id), {
    className: 'codex-room-img',
    alt: '',
    fallback: placeholderUrl(zoneName, { w: 640, h: 360 }),
  });
  const parts = [`<div class="codex-room-art" aria-hidden="true">${art}</div>`,
    `<h2 class="codex-hero-name">${escapeHtml(roomName(tile))}</h2>`,
    `<p class="codex-sub">${escapeHtml(placeText(tile, world))}</p>`];

  const band = world.getRoomLevels(tile);
  if (band) {
    const danger = isLevelDanger(band, partyBestLevel(state));
    parts.push(`<p class="codex-level"${danger ? ' data-danger="1"' : ''}>${escapeHtml(levelBandText(band))}</p>`);
    const note = danger ? travelLevelNote(band, state) : null;
    if (note) parts.push(`<p class="codex-note" data-danger="1">${escapeHtml(note.text)}</p>`);
  }

  const here = partyRoom(state, world)?.id === tile.id;
  const block = travelBlock(state);
  const go = here ? '<span class="codex-chip codex-chip-here">You are here</span>' : goButton(tile.id, 'Go there', block);
  parts.push(`<div class="codex-actions">${go}<button type="button" class="codex-btn" data-codex-show="${escapeHtml(tile.id)}">Show on map</button></div>`);
  if (!here) parts.push(blockNote(block));

  const hereLines = roomHereLines(tile, ctx);
  if (hereLines.length > 0) parts.push(section('Here', lines(hereLines)));

  const { fights, others } = index.fightsOfRoom(tile.id);
  const monsterLink = (id: string) => codexLinkHtml({ kind: 'monster', id }, index.monsters.get(id)!.name);
  if (fights.length > 0) {
    parts.push(section('Fights you know here', lines(fights.map(fight => `<span>${fight.map(monsterLink).join(', ')}</span>`))));
  }
  if (others.length > 0) {
    const title = fights.length > 0 ? "Other monsters you've met that live here" : "Monsters you've met that live here";
    parts.push(section(title, lines(others.map(monsterLink))));
  }
  if (fights.length === 0 && others.length === 0) parts.push(emptyLine("You haven't met anything that lives here yet."));
  return `<div class="codex-entry codex-room">${parts.join('')}</div>`;
}

export function codexShopHtml(shopId: string, ctx: CodexViewContext): string {
  const shop = ctx.index.shops.get(shopId);
  if (!shop) return codexMissingHtml('shop');
  const { state, world, index } = ctx;
  const art = renderAssetImg('shop', shop.id, { label: shop.name, width: 192, height: 192, alt: '' });
  const parts = [heroHtml(art, shop.name)];

  const roomIds = closestRooms(index.roomsOfShop.get(shop.id) ?? [], state, world);
  if (roomIds.length > 0) {
    const block = travelBlock(state);
    const hereId = partyRoom(state, world)?.id;
    parts.push(section('Found in', lines(roomIds.map(id => {
      const tile = index.rooms.get(id)!;
      const go = id === hereId
        ? '<span class="codex-chip codex-chip-here">You are here</span>'
        : goButton(id, 'Go', block, 'codex-btn codex-btn-small');
      return `${codexLinkHtml({ kind: 'room', id }, roomName(tile))}${meta(placeText(tile, world))}${go}`;
    })) + blockNote(block)));
  }

  const stock = shop.stock.filter(s => index.items.has(s.itemId)).sort((a, b) => a.price - b.price);
  if (stock.length > 0) {
    parts.push(section('Sells', lines(stock.map(s =>
      `${itemArt(index.items.get(s.itemId)!.def)}${codexLinkHtml({ kind: 'item', id: s.itemId }, index.items.get(s.itemId)!.def.name)}${meta(`${n(s.price)} gold`)}`))));
  }
  if (shop.hires.length > 0) {
    parts.push(section('Hires', lines(shop.hires.map(h =>
      `<span class="codex-icon" aria-hidden="true">${escapeHtml(h.emoji)}</span>${escapeHtml(h.name)}${meta(`Level ${n(h.level)}`)}`))));
  }
  return `<div class="codex-entry">${parts.join('')}</div>`;
}

export function codexEntryHtml(ref: CodexRef, ctx: CodexViewContext, expanded: boolean): string {
  switch (ref.kind) {
    case 'monster': return codexMonsterHtml(ref.id, ctx, expanded);
    case 'item': return codexItemHtml(ref.id, ctx);
    case 'room': return codexRoomHtml(ref.id, ctx);
    case 'shop': return codexShopHtml(ref.id, ctx);
  }
}
