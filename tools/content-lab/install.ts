import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentSnapshot } from './types.js';

/** DevSeed skips its merge once this dungeon exists; no room points at the copy written here. */
const DEV_SEED_BLOCKER_ID = 'dev_sunken_throne';

/** The files `ContentStore.load` reads, built from a snapshot, plus the blocker that keeps DevSeed out. */
export function contentFiles(content: ContentSnapshot): Record<string, unknown> {
  const dungeons = Object.values(content.dungeons);
  const blocker = dungeons[0] ? [{ ...dungeons[0], id: DEV_SEED_BLOCKER_ID, name: 'Dev seed blocker' }] : [];
  return {
    'monsters.json': Object.values(content.monsters),
    'items.json': Object.values(content.items),
    'zones.json': Object.values(content.zones),
    'world.json': content.world,
    'encounters.json': Object.values(content.encounters),
    'sets.json': Object.values(content.sets),
    'shops.json': Object.values(content.shops),
    'henchmen.json': Object.values(content.henchmen),
    'tile-types.json': Object.values(content.tileTypes),
    'recipes.json': Object.values(content.recipes),
    'npcs.json': Object.values(content.npcs),
    'quests.json': Object.values(content.quests),
    'dungeons.json': [...dungeons, ...blocker],
    'skills.json': Object.values(content.skills),
    'skill-slots.json': Object.entries(content.skillSlotSchedules).map(([className, slots]) => ({ className, slots })),
    'design-notes.json': Object.values(content.designNotes),
  };
}

export function installContent(content: ContentSnapshot, dataDir: string): string[] {
  mkdirSync(dataDir, { recursive: true });
  const files = contentFiles(content);
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dataDir, name), JSON.stringify(value, null, 2));
  }
  return Object.keys(files);
}
