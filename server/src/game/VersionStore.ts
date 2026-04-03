import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { MonsterDefinition, ItemDefinition, ZoneDefinition, WorldData, EncounterDefinition, EncounterTableEntry, SetDefinition, ShopDefinition } from '@idle-party-rpg/shared';

export type VersionStatus = 'draft' | 'published';

export interface ContentSnapshot {
  monsters: MonsterDefinition[];
  items: ItemDefinition[];
  zones: ZoneDefinition[];
  encounters?: EncounterDefinition[];
  sets?: SetDefinition[];
  shops?: ShopDefinition[];
  world: WorldData;
}

export interface ContentVersion {
  id: string;
  name: string;
  status: VersionStatus;
  isActive: boolean;
  createdAt: string;
  createdFrom: string | null;
  publishedAt: string | null;
}

interface VersionManifest {
  versions: ContentVersion[];
  activeVersionId: string | null;
}

const VERSIONS_DIR = path.resolve('data', 'versions');
const MANIFEST_FILE = path.join(VERSIONS_DIR, 'manifest.json');

/**
 * Manages content version snapshots.
 * Each version is a complete freeze of all game content (monsters, items, zones, world).
 */
export class VersionStore {
  private manifest: VersionManifest = { versions: [], activeVersionId: null };

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(MANIFEST_FILE, 'utf-8');
      this.manifest = JSON.parse(raw);
      console.log(`[VersionStore] Loaded ${this.manifest.versions.length} versions`);
    } catch {
      // No manifest yet — start empty
      console.log('[VersionStore] No versions found — starting fresh');
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(VERSIONS_DIR, { recursive: true });
    await fs.writeFile(MANIFEST_FILE, JSON.stringify(this.manifest, null, 2));
  }

  getAll(): ContentVersion[] {
    return this.manifest.versions;
  }

  get(id: string): ContentVersion | undefined {
    return this.manifest.versions.find(v => v.id === id);
  }

  getActive(): ContentVersion | undefined {
    if (!this.manifest.activeVersionId) return undefined;
    return this.get(this.manifest.activeVersionId);
  }

  getActiveVersionId(): string | null {
    return this.manifest.activeVersionId;
  }

  async createDraft(name: string, fromVersionId: string | null, snapshot: ContentSnapshot): Promise<ContentVersion> {
    const id = crypto.randomUUID();
    const version: ContentVersion = {
      id,
      name,
      status: 'draft',
      isActive: false,
      createdAt: new Date().toISOString(),
      createdFrom: fromVersionId,
      publishedAt: null,
    };

    await this.saveSnapshot(id, snapshot);
    this.manifest.versions.push(version);
    await this.save();

    console.log(`[VersionStore] Created draft "${name}" (${id})`);
    return version;
  }

  async publish(id: string): Promise<{ success: boolean; version?: ContentVersion; error?: string }> {
    const version = this.get(id);
    if (!version) return { success: false, error: 'Version not found.' };
    if (version.status !== 'draft') return { success: false, error: 'Only drafts can be published.' };

    version.status = 'published';
    version.publishedAt = new Date().toISOString();
    await this.save();

    console.log(`[VersionStore] Published "${version.name}" (${id})`);
    return { success: true, version };
  }

  async setActive(id: string): Promise<void> {
    // Clear old active
    for (const v of this.manifest.versions) {
      v.isActive = false;
    }
    const version = this.get(id);
    if (version) {
      version.isActive = true;
    }
    this.manifest.activeVersionId = id;
    await this.save();
  }

  async deleteVersion(id: string): Promise<{ success: boolean; error?: string }> {
    const version = this.get(id);
    if (!version) return { success: false, error: 'Version not found.' };
    if (version.isActive) return { success: false, error: 'Cannot delete the active version.' };

    // Remove snapshot file
    try {
      await fs.unlink(this.snapshotPath(id));
    } catch {
      // File may not exist
    }

    this.manifest.versions = this.manifest.versions.filter(v => v.id !== id);
    await this.save();

    console.log(`[VersionStore] Deleted "${version.name}" (${id})`);
    return { success: true };
  }

  async loadSnapshot(id: string): Promise<ContentSnapshot> {
    const raw = await fs.readFile(this.snapshotPath(id), 'utf-8');
    const snapshot: ContentSnapshot = JSON.parse(raw);
    let needsSave = false;

    // Migrate: assign GUIDs to any tiles missing an id
    let guidsMigrated = 0;
    for (const tile of snapshot.world.tiles) {
      if (!tile.id) {
        tile.id = crypto.randomUUID();
        guidsMigrated++;
      }
    }
    if (guidsMigrated > 0) {
      console.log(`[VersionStore] Assigned GUIDs to ${guidsMigrated} tiles in version ${id}`);
      needsSave = true;
    }

    // Default missing content arrays for backward compatibility
    if (!snapshot.encounters) {
      snapshot.encounters = [];
    }
    if (!snapshot.sets) {
      snapshot.sets = [];
    }
    if (!snapshot.shops) {
      snapshot.shops = [];
    }
    const encountersMigrated = migrateSnapshotEncounterTables(snapshot);
    if (encountersMigrated) {
      console.log(`[VersionStore] Migrated encounter tables in version ${id}`);
      needsSave = true;
    }

    if (needsSave) {
      await this.saveSnapshot(id, snapshot);
    }

    return snapshot;
  }

  async saveSnapshot(id: string, snapshot: ContentSnapshot): Promise<void> {
    await fs.mkdir(VERSIONS_DIR, { recursive: true });
    await fs.writeFile(this.snapshotPath(id), JSON.stringify(snapshot, null, 2));
  }

  private snapshotPath(id: string): string {
    return path.join(VERSIONS_DIR, `${id}.json`);
  }
}

/**
 * Migrate old-format encounter tables in a snapshot.
 * Detects entries with `monsterId` instead of `encounterId` and auto-creates encounter definitions.
 */
function migrateSnapshotEncounterTables(snapshot: ContentSnapshot): boolean {
  let migrated = false;
  const encounters = snapshot.encounters ?? [];
  const encounterMap = new Map<string, EncounterDefinition>();
  for (const e of encounters) encounterMap.set(e.id, e);

  const monsterMap = new Map<string, MonsterDefinition>();
  for (const m of snapshot.monsters) monsterMap.set(m.id, m);

  const isOldFormat = (entry: Record<string, unknown>): boolean => {
    return 'monsterId' in entry && !('encounterId' in entry);
  };

  const getOrCreateEncounter = (entry: { monsterId: string; weight: number; minCount: number; maxCount: number }): string => {
    const encId = `auto_${entry.monsterId}`;
    if (!encounterMap.has(encId)) {
      const monsterDef = monsterMap.get(entry.monsterId);
      const name = monsterDef ? `${monsterDef.name}s` : entry.monsterId;
      const enc: EncounterDefinition = {
        id: encId,
        name,
        type: 'random',
        monsterPool: [{ monsterId: entry.monsterId, min: entry.minCount, max: entry.maxCount }],
        roomMax: 9,
      };
      encounterMap.set(encId, enc);
    }
    return encId;
  };

  for (const zone of snapshot.zones) {
    if (zone.encounterTable.length > 0 && isOldFormat(zone.encounterTable[0] as unknown as Record<string, unknown>)) {
      const oldTable = zone.encounterTable as unknown as { monsterId: string; weight: number; minCount: number; maxCount: number }[];
      const newTable: EncounterTableEntry[] = oldTable.map(entry => ({
        encounterId: getOrCreateEncounter(entry),
        weight: entry.weight,
      }));
      zone.encounterTable = newTable;
      migrated = true;
    }
  }

  for (const tile of snapshot.world.tiles) {
    if (tile.encounterTable && tile.encounterTable.length > 0 && isOldFormat(tile.encounterTable[0] as unknown as Record<string, unknown>)) {
      const oldTable = tile.encounterTable as unknown as { monsterId: string; weight: number; minCount: number; maxCount: number }[];
      const newTable: EncounterTableEntry[] = oldTable.map(entry => ({
        encounterId: getOrCreateEncounter(entry),
        weight: entry.weight,
      }));
      tile.encounterTable = newTable;
      migrated = true;
    }
  }

  if (migrated) {
    snapshot.encounters = Array.from(encounterMap.values());
  }

  return migrated;
}
