import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface SectionChange {
  section: string;
  /** Entries in this section, after. */
  total: number;
  added: number;
  removed: number;
  changed: number;
  /** Entries changed per field path; array indexes read as []. */
  fields: Record<string, number>;
}

export interface ReworkResult {
  sha1: string;
  changes: SectionChange[];
}

export type ReworkFn = (snapshot: any) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function entryKey(value: unknown, index: number): string {
  if (isRecord(value)) {
    if (typeof value.id === 'string') return value.id;
    if (typeof value.className === 'string') return value.className;
  }
  return `#${index}`;
}

/** Field paths where these two differ. Arrays compare by value, element by element, so a path never names one entry. */
function differingFields(before: unknown, after: unknown, path: string, into: Set<string>): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (isRecord(before) && isRecord(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) differingFields(before[key], after[key], path ? `${path}.${key}` : key, into);
    return;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((value, i) => differingFields(value, after[i], `${path}[]`, into));
    return;
  }
  into.add(path || '(value)');
}

function keyed(value: unknown): Map<string, unknown> | null {
  if (Array.isArray(value)) return new Map(value.map((entry, i) => [entryKey(entry, i), entry]));
  if (isRecord(value) && Object.values(value).every(v => isRecord(v) || Array.isArray(v))) return new Map(Object.entries(value));
  return null;
}

function changeOfSection(section: string, before: unknown, after: unknown): SectionChange {
  const a = keyed(before);
  const b = keyed(after);
  const change: SectionChange = { section, total: 0, added: 0, removed: 0, changed: 0, fields: {} };
  if (!a || !b) {
    change.total = 1;
    const fields = new Set<string>();
    differingFields(before, after, '', fields);
    if (fields.size) change.changed = 1;
    for (const field of fields) change.fields[field] = 1;
    return change;
  }
  change.total = b.size;
  for (const [key, value] of b) {
    if (!a.has(key)) {
      change.added++;
      continue;
    }
    const fields = new Set<string>();
    differingFields(a.get(key), value, '', fields);
    if (fields.size) change.changed++;
    for (const field of fields) change.fields[field] = (change.fields[field] ?? 0) + 1;
  }
  for (const key of a.keys()) if (!b.has(key)) change.removed++;
  return change;
}

/** Counts per section and field, and nothing about whether they are good. `world` splits into maps and tiles so a tile edit doesn't read as one change. */
export function changeSummary(before: Record<string, any>, after: Record<string, any>): SectionChange[] {
  const out: SectionChange[] = [];
  for (const section of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (section === 'world' && isRecord(before.world) && isRecord(after.world)) {
      for (const part of [...new Set([...Object.keys(before.world), ...Object.keys(after.world)])].sort()) out.push(changeOfSection(`world.${part}`, before.world[part], after.world[part]));
      continue;
    }
    out.push(changeOfSection(section, before[section], after[section]));
  }
  return out;
}

export function renderChangeSummary(input: string, moduleName: string, result: ReworkResult): string {
  const moved = result.changes.filter(c => c.added || c.removed || c.changed);
  return [
    `# Rework: ${moduleName}`,
    '',
    `From ${input}. New snapshot sha1 ${result.sha1}.`,
    '',
    moved.length ? '| section | entries after | added | removed | changed | fields changed, entries |' : 'Nothing changed.',
    ...(moved.length ? ['| --- | --- | --- | --- | --- | --- |'] : []),
    ...moved.map(c => `| ${c.section} | ${c.total} | ${c.added} | ${c.removed} | ${c.changed} | ${Object.entries(c.fields).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([field, n]) => `${field} ${n}`).join(', ') || '-'} |`),
    '',
  ].join('\n');
}

export function applyRework(snapshot: Record<string, any>, rework: ReworkFn): { after: Record<string, any>; changes: SectionChange[] } {
  const before = JSON.parse(JSON.stringify(snapshot)) as Record<string, any>;
  const returned = rework(snapshot);
  const after = (returned ?? snapshot) as Record<string, any>;
  if (!isRecord(after) || !after.monsters || !after.world) throw new Error('rework must return the snapshot, or change the one it was given');
  return { after, changes: changeSummary(before, JSON.parse(JSON.stringify(after))) };
}

/** Any path works: tsx compiles the module wherever it lives, and repo-resolve.mjs finds its bare imports in this repository. */
export async function loadRework(path: string): Promise<ReworkFn> {
  const mod = await import(pathToFileURL(resolve(path)).href);
  const fn = mod.rework ?? mod.default?.rework ?? (typeof mod.default === 'function' ? mod.default : undefined);
  if (typeof fn !== 'function') throw new Error(`${path} does not export rework(snapshot)`);
  return fn as ReworkFn;
}

/** Writes `<out>` and `<out>.changes.md`. */
export async function runRework(snapshotPath: string, modulePath: string, out: string): Promise<{ summary: string; summaryPath: string }> {
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as Record<string, any>;
  const { after, changes } = applyRework(snapshot, await loadRework(modulePath));
  const raw = JSON.stringify(after);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, raw);
  const summary = renderChangeSummary(snapshotPath, modulePath, { sha1: createHash('sha1').update(raw).digest('hex'), changes });
  const summaryPath = `${out}.changes.md`;
  writeFileSync(summaryPath, summary);
  return { summary, summaryPath };
}
