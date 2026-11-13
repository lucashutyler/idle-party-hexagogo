import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Keyed = Record<string, any>;

const DATA_SECTIONS: Record<string, string> = {
  dungeons: 'dungeons.json',
  encounters: 'encounters.json',
  henchmen: 'henchmen.json',
  items: 'items.json',
  monsters: 'monsters.json',
  npcs: 'npcs.json',
  quests: 'quests.json',
  recipes: 'recipes.json',
  sets: 'sets.json',
  shops: 'shops.json',
  skills: 'skills.json',
  tileTypes: 'tile-types.json',
  zones: 'zones.json',
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const record = value as Keyed;
    return Object.fromEntries(Object.keys(record).sort().map(k => [k, canonical(record[k])]));
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function readKeyed(path: string): Keyed {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(raw) ? Object.fromEntries(raw.map((x: any) => [x.id, x])) : raw;
}

/** A server data folder keeps slot schedules as a list of { className, slots }, an export as a map. */
function readSlots(path: string): Keyed {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Array.isArray(raw) ? Object.fromEntries(raw.map((x: any) => [x.className, x.slots])) : raw;
}

/** `base` with its skills and slot schedules replaced, every other section untouched. */
export function mergeSkills(basePath: string, skillsPath: string, slotsPath: string, outPath: string): { skills: number; attackSkills: number } {
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  base.skills = readKeyed(skillsPath);
  base.skillSlotSchedules = readSlots(slotsPath);
  writeFileSync(outPath, JSON.stringify(base));
  const skills = Object.values(base.skills) as any[];
  return { skills: skills.length, attackSkills: skills.filter(s => s.type === 'attack').length };
}

export function compareDataFolder(basePath: string, dataDir: string): string[] {
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const lines: string[] = [];
  for (const [section, file] of Object.entries(DATA_SECTIONS)) {
    const path = join(dataDir, file);
    if (!existsSync(path)) {
      lines.push(`- ${section}: no ${file} in the data folder`);
      continue;
    }
    const data = readKeyed(path);
    const exported: Keyed = base[section] ?? {};
    const ids = Object.keys(data);
    const differ = ids.filter(id => id in exported && !same(data[id], exported[id]));
    const onlyData = ids.filter(id => !(id in exported));
    const onlyExport = Object.keys(exported).filter(id => !(id in data));
    const detail = [
      differ.length ? `${differ.length} differ (${differ.slice(0, 40).join(', ')})` : '',
      onlyData.length ? `only in the data folder: ${onlyData.slice(0, 40).join(', ')}` : '',
      onlyExport.length ? `only in the export: ${onlyExport.slice(0, 40).join(', ')}` : '',
    ].filter(Boolean).join('; ');
    lines.push(`- ${section}: ${ids.length} vs ${Object.keys(exported).length}, ${detail || 'identical'}`);
  }
  const worldPath = join(dataDir, 'world.json');
  if (existsSync(worldPath)) lines.push(`- world: ${same(JSON.parse(readFileSync(worldPath, 'utf8')), base.world) ? 'identical' : 'DIFFERS'}`);
  const slotsPath = join(dataDir, 'skill-slots.json');
  if (existsSync(slotsPath)) {
    const slots = readSlots(slotsPath);
    const differ = Object.keys(slots).filter(c => !same(slots[c], base.skillSlotSchedules?.[c]));
    lines.push(`- skillSlotSchedules: ${differ.length ? `differ for ${differ.join(', ')}` : 'identical'}`);
  }
  return lines;
}

interface AuditRow {
  id: string;
  xp: number;
  hp: number | null;
  level: string;
  tier: string;
}

/** Monster rows of a markdown audit table with the columns id, name, lvl, tier, hp, xp. */
function parseAudit(text: string): AuditRow[] {
  const rows: AuditRow[] = [];
  for (const line of text.split('\n')) {
    const cols = line.split('|').map(c => c.trim());
    if (cols.length < 8 || cols[1] === 'id' || /^-+$/.test(cols[1])) continue;
    const xp = Number(cols[6]);
    const hp = Number(cols[5]);
    if (!cols[1] || !Number.isFinite(xp) || !Number.isFinite(hp) || !/^(\d+|no level)$/.test(cols[3])) continue;
    rows.push({ id: cols[1], xp, hp, level: cols[3], tier: cols[4] });
  }
  return rows;
}

/** An audit may shorten long ids to their first characters. */
function resolveAuditId(id: string, monsters: Keyed): string | undefined {
  if (monsters[id]) return id;
  const matches = Object.keys(monsters).filter(key => key.startsWith(`${id}-`));
  return matches.length === 1 ? matches[0] : undefined;
}

export function compareMonsterAudit(basePath: string, auditPath: string): string[] {
  const monsters: Keyed = JSON.parse(readFileSync(basePath, 'utf8')).monsters;
  const rows = parseAudit(readFileSync(auditPath, 'utf8'));
  const resolved = rows.map(row => ({ row, id: resolveAuditId(row.id, monsters) }));
  const seen = new Set(resolved.map(r => r.id));
  const missing = resolved.filter(r => !r.id);
  const found = resolved.filter((r): r is { row: AuditRow; id: string } => !!r.id);
  const xpDiffers = found.filter(r => (monsters[r.id].xp ?? 0) !== r.row.xp);
  const hpDiffers = found.filter(r => monsters[r.id].hp !== r.row.hp);
  const notAudited = Object.keys(monsters).filter(id => !seen.has(id));
  return [
    `- audit rows: ${rows.length}; monsters in the private copy: ${Object.keys(monsters).length}`,
    `- XP differences: ${xpDiffers.length}${xpDiffers.length ? ` (${xpDiffers.slice(0, 20).map(r => `${r.id}: audit ${r.row.xp}, copy ${monsters[r.id].xp}`).join('; ')})` : ''}`,
    `- HP differences: ${hpDiffers.length}${hpDiffers.length ? ` (${hpDiffers.slice(0, 20).map(r => `${r.id}: audit ${r.row.hp}, copy ${monsters[r.id].hp}`).join('; ')})` : ''}`,
    `- in the audit but not the copy: ${missing.length}${missing.length ? ` (${missing.map(r => r.row.id).join(', ')})` : ''}`,
    `- in the copy but not the audit: ${notAudited.length}${notAudited.length ? ` (${notAudited.map(id => `${id}: xp ${monsters[id].xp ?? 0}${monsters[id].passive ? ', passive' : ''}`).join('; ')})` : ''}`,
  ];
}
