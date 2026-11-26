import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { displayPath, isMissingFileError } from './JsonFiles.js';

export const BOOT_BACKUPS_KEPT = 10;
const BOOT_BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function bootBackupsDir(dataDir: string): string {
  return path.join(dataDir, 'boot-backups');
}

/** An ISO time with `:` and `.` swapped for `-`, so Windows can hold it as a folder name and names sort by time. */
export function bootBackupName(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-');
}

/**
 * Copy every file in `files` that exists, byte for byte and damaged or not, into
 * `<dataDir>/boot-backups/<time>/` at its path inside `dataDir`, then keep the newest
 * {@link BOOT_BACKUPS_KEPT}. Skipped when the files match the newest backup, so a crash loop
 * can't push older backups out. Never throws. See docs/architecture/persistence.md.
 */
export async function backUpDataFiles(dataDir: string, files: readonly string[], at: Date = new Date()): Promise<string | undefined> {
  try {
    const root = bootBackupsDir(dataDir);
    const current = await Promise.all(files.map(readIfPresent));
    if (current.every(bytes => bytes === undefined)) return undefined;

    const previous = await backupNames(root);
    const newest = previous[previous.length - 1];
    if (newest && await sameAsBackup(dataDir, files, current, path.join(root, newest))) return undefined;

    const target = path.join(root, bootBackupName(at));
    let copied = 0;
    for (const [i, file] of files.entries()) {
      const bytes = current[i];
      if (bytes === undefined) continue;
      const copy = path.join(target, path.relative(dataDir, file));
      try {
        await mkdir(path.dirname(copy), { recursive: true });
        await writeFile(copy, bytes, { flag: 'wx' });
        copied++;
      } catch (err) {
        console.error(`[BootBackup] Could not copy ${displayPath(file)} to ${displayPath(copy)}:`, err);
      }
    }
    await pruneBackups(root);
    console.log(`[BootBackup] Copied ${copied} data file(s) to ${displayPath(target)}`);
    return target;
  } catch (err) {
    console.error('[BootBackup] The boot backup failed; starting anyway:', err);
    return undefined;
  }
}

async function readIfPresent(file: string): Promise<Buffer | undefined> {
  try {
    return await readFile(file);
  } catch (err) {
    if (!isMissingFileError(err)) console.error(`[BootBackup] Could not read ${displayPath(file)}:`, err);
    return undefined;
  }
}

async function backupNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && BOOT_BACKUP_NAME.test(entry.name)).map(entry => entry.name).sort();
  } catch (err) {
    if (isMissingFileError(err)) return [];
    throw err;
  }
}

async function sameAsBackup(dataDir: string, files: readonly string[], current: (Buffer | undefined)[], backupDir: string): Promise<boolean> {
  for (const [i, file] of files.entries()) {
    const backedUp = await readIfPresent(path.join(backupDir, path.relative(dataDir, file)));
    const now = current[i];
    if (now === undefined && backedUp === undefined) continue;
    if (now === undefined || backedUp === undefined || !now.equals(backedUp)) return false;
  }
  return true;
}

async function pruneBackups(root: string): Promise<void> {
  const names = await backupNames(root);
  for (const name of names.slice(0, Math.max(0, names.length - BOOT_BACKUPS_KEPT))) {
    await rm(path.join(root, name), { recursive: true, force: true });
  }
}
