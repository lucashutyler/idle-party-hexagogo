import type { Combatant, EngineAdapter } from '../engines.js';
import type { Equipment, Region } from '../policy.js';
import { CLASS_SEATS, buildGearTable, chooseHires, chooseLoadout, defaultSeats, humanSeats, xpMultiplier } from '../policy.js';
import type { ClassName, HireSpec } from '../types.js';
import type { MemberRole, XpComp, XpSnapshot } from './types.js';

export interface PartyMember {
  className: ClassName;
  level: number;
  role: MemberRole;
}

export interface BuiltParty {
  players: Combatant[];
  members: PartyMember[];
  hires: string[];
  xpMult: number;
  /** The party can't be formed on this map. */
  unavailable?: string;
}

function lowerMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : Infinity;
}

/** The last region whose median zone midpoint is at or below `level`, else the first. */
export function gearRegionIndex(level: number, regionMidpoints: readonly number[]): number {
  let index = 0;
  regionMidpoints.forEach((mid, i) => {
    if (mid <= level) index = i;
  });
  return index;
}

export function regionMidpoints(content: XpSnapshot, regions: readonly Region[]): number[] {
  return regions.map(region => lowerMedian(region.zoneIds.map(id => {
    const range = content.zones[id].levelRange;
    return (range[0] + range[1]) / 2;
  })));
}

function pickHireOfClass(pool: readonly any[], className: ClassName, level: number): any | null {
  const candidates = pool.filter(h => h.className === className);
  const below = candidates.filter(h => h.level <= level).sort((a, b) => b.level - a.level || a.id.localeCompare(b.id));
  if (below.length) return below[0];
  return candidates.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id))[0] ?? null;
}

const ROLE_FIRST: readonly ClassName[] = ['Knight', 'Priest'];
const GRID_SEATS = 9;

/** The highest-level hires on the map, a tank and a healer first if the humans have none. */
export function strongestHires(pool: readonly any[], count: number, humans: readonly ClassName[]): any[] {
  const byLevel = [...pool].sort((a, b) => b.level - a.level || a.id.localeCompare(b.id));
  const picks: any[] = [];
  for (const className of ROLE_FIRST) {
    if (humans.includes(className)) continue;
    const pick = byLevel.find(h => h.className === className);
    if (pick && picks.length < count) picks.push(pick);
  }
  for (const hire of byLevel) {
    if (picks.length >= count) break;
    if (!picks.includes(hire)) picks.push(hire);
  }
  return picks;
}

function freeSeat(className: ClassName, taken: ReadonlySet<number>): number {
  return [...CLASS_SEATS[className], 0, 1, 2, 3, 4, 5, 6, 7, 8].find(s => !taken.has(s))!;
}

export class PartyBuilder {
  private readonly gear: Map<string, Record<ClassName, Equipment>>;
  private readonly midpoints: number[];
  private readonly loadouts = new Map<string, (string | null)[]>();
  private readonly cache = new Map<string, BuiltParty>();
  private readonly hireableByLevel = new Map<number, XpSnapshot>();

  constructor(private readonly content: XpSnapshot, private readonly regions: readonly Region[], private readonly engine: EngineAdapter) {
    this.gear = buildGearTable(content, regions);
    this.midpoints = regionMidpoints(content, regions);
  }

  gearFor(level: number, className: ClassName): Equipment {
    return this.gear.get(this.regions[gearRegionIndex(level, this.midpoints)].id)![className];
  }

  build(comp: XpComp, level: number, region: Region): BuiltParty {
    const key = `${comp.id}|${level}|${region.id}`;
    let party = this.cache.get(key);
    if (!party) {
      party = this.assemble(comp, level, region);
      this.cache.set(key, party);
    }
    return party;
  }

  private loadout(className: ClassName, level: number): (string | null)[] {
    const key = `${className}|${level}`;
    let loadout = this.loadouts.get(key);
    if (!loadout) {
      loadout = chooseLoadout(this.content, className, level);
      this.loadouts.set(key, loadout);
    }
    return loadout;
  }

  /** Swaps the member's last unlocked passive for the class's best xp_bonus, if one is unlocked. */
  private withXpBonus(className: ClassName, level: number, loadout: (string | null)[]): (string | null)[] {
    const { content } = this;
    const flat = (skill: any): number => (skill.passiveEffects ?? []).reduce((sum: number, e: any) => sum + (e.kind === 'xp_bonus' ? e.flatValue ?? 0 : 0), 0);
    const bonus = (Object.values(content.skills) as any[])
      .filter(s => s.className === className && s.type === 'passive' && typeof s.unlockLevel === 'number' && s.unlockLevel <= level && flat(s) > 0)
      .sort((a, b) => flat(b) - flat(a) || a.id.localeCompare(b.id))[0];
    if (!bonus || loadout.includes(bonus.id)) return loadout;
    let slot = -1;
    (content.skillSlotSchedules[className] ?? []).forEach((s: any, i: number) => {
      if (s.type === 'passive' && s.unlocksAtLevel <= level) slot = i;
    });
    if (slot < 0) return loadout;
    const swapped = [...loadout];
    swapped[slot] = bonus.id;
    return swapped;
  }

  private assemble(comp: XpComp, level: number, region: Region): BuiltParty {
    const { content, engine } = this;
    const classes = comp.members.map(m => m.className);
    const handedOut = comp.seating === 'default' ? defaultSeats(GRID_SEATS) : undefined;
    const seats = humanSeats(classes, comp.hires !== 'none', handedOut?.slice(0, classes.length));
    const skillIds: (string | null)[] = [];
    const members: PartyMember[] = [];
    const players: Combatant[] = seats.map((spec, i) => {
      const member = comp.members[i];
      const memberLevel = level + member.levelOffset;
      const base = comp.skills === 'default' ? this.loadout(member.className, memberLevel) : [];
      const loadout = comp.xpBonus ? this.withXpBonus(member.className, memberLevel, base) : base;
      skillIds.push(...loadout);
      members.push({ className: member.className, level: memberLevel, role: member.role });
      const equipment = comp.gear === 'level' ? this.gearFor(memberLevel, member.className) : {};
      return engine.buildHuman({ ...spec, level: memberLevel, equipment, skillIds: loadout }, content);
    });

    const hireSpecs = this.chooseHireSpecs(comp, level, region, players);
    if (typeof hireSpecs === 'string') return { players, members, hires: [], xpMult: 1, unavailable: hireSpecs };
    const reserved = new Set(players.map(p => p.username));
    hireSpecs.forEach((hire, i) => {
      const def = content.henchmen[hire.henchmanId];
      let name = def.name;
      for (let n = 2; reserved.has(name); n++) name = `${def.name} #${n}`;
      reserved.add(name);
      const seated = handedOut ? { ...hire, gridPosition: handedOut[classes.length + i] as HireSpec['gridPosition'] } : hire;
      players.push(engine.buildHire(seated, def, content, name));
      skillIds.push(...def.skillIds);
    });
    if (comp.swapSeats) this.swapSeats(players, comp.swapSeats);
    const xpMult = xpMultiplier(skillIds, content.skills);
    const unavailable = comp.xpBonus && xpMult <= 1 ? 'no xp_bonus passive unlocked at this level' : undefined;
    return { players, members, hires: hireSpecs.map(h => h.henchmanId), xpMult, unavailable };
  }

  /** Only the hires within the level limit of this top human level, as PlayerManager and the fight roster allow. */
  private hireable(topLevel: number): XpSnapshot {
    let content = this.hireableByLevel.get(topLevel);
    if (!content) {
      const within = Object.entries(this.content.henchmen).filter(([, h]) => this.engine.module.isHireWithinLevelLimit(h.level, topLevel));
      content = { ...this.content, henchmen: Object.fromEntries(within) };
      this.hireableByLevel.set(topLevel, content);
    }
    return content;
  }

  private chooseHireSpecs(comp: XpComp, level: number, region: Region, players: readonly Combatant[]): HireSpec[] | string {
    if (comp.hires === 'none') return [];
    const offered = region.shopIds.some(id => (this.content.shops[id].henchmanIds ?? []).some(h => this.content.henchmen[h]));
    if (!offered) return 'no hires offered on this map';
    const content = this.hireable(Math.max(...comp.members.map(m => level + m.levelOffset)));
    const noneFits = (anyWithoutLimit: boolean): string => (anyWithoutLimit ? 'every hire on this map that fits is over the hire level limit' : 'no hire on this map fits this party');
    if (comp.hires === 'usual') {
      const hires = chooseHires(content, region, comp.members[0].className, level, players[0].gridPosition);
      if (hires.length) return hires;
      return noneFits(chooseHires(this.content, region, comp.members[0].className, level, players[0].gridPosition).length > 0);
    }
    const poolOf = (from: XpSnapshot) => [...new Set(region.shopIds.flatMap(id => from.shops[id].henchmanIds ?? []))].map(id => from.henchmen[id]).filter(Boolean);
    const pool = poolOf(content);
    if ('fill' in comp.hires) {
      const classes = comp.members.map(m => m.className);
      const picks = strongestHires(pool, comp.hires.fill, classes);
      if (picks.length === 0) return noneFits(strongestHires(poolOf(this.content), comp.hires.fill, classes).length > 0);
      const taken = new Set(players.map(p => p.gridPosition as number));
      return picks.map(pick => {
        const gridPosition = freeSeat(pick.className, taken);
        taken.add(gridPosition);
        return { henchmanId: pick.id, gridPosition: gridPosition as HireSpec['gridPosition'] };
      });
    }
    const pick = pickHireOfClass(pool, comp.hires.className, level);
    if (!pick) return `no ${comp.hires.className} hire on this map within the hire level limit`;
    const taken = new Set(players.map(p => p.gridPosition as number));
    return [{ henchmanId: pick.id, gridPosition: freeSeat(comp.hires.className, taken) }];
  }

  private swapSeats(players: Combatant[], [a, b]: [ClassName, ClassName]): void {
    const first = players.find(p => p.className === a);
    const second = players.find(p => p.className === b);
    if (!first || !second) return;
    const seat = first.gridPosition;
    first.gridPosition = second.gridPosition;
    second.gridPosition = seat;
  }
}
