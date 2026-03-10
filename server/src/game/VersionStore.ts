import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { MonsterDefinition, ItemDefinition, ZoneDefinition, WorldData } from '@idle-party-rpg/shared';

export type VersionStatus = 'draft' | 'published';

export interface ContentSnapshot {
  monsters: MonsterDefinition[];
  items: ItemDefinition[];
  zones: ZoneDefinition[];
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
    return JSON.parse(raw);
  }

  async saveSnapshot(id: string, snapshot: ContentSnapshot): Promise<void> {
    await fs.mkdir(VERSIONS_DIR, { recursive: true });
    await fs.writeFile(this.snapshotPath(id), JSON.stringify(snapshot, null, 2));
  }

  private snapshotPath(id: string): string {
    return path.join(VERSIONS_DIR, `${id}.json`);
  }
}
