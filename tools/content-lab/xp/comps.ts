import { classSubsets } from '../policy.js';
import type { ClassName } from '../types.js';
import type { CompFamily, CompMember, HirePolicy, MemberRole, XpComp } from './types.js';

const CLASS_BY_INITIAL: Record<string, ClassName> = { K: 'Knight', A: 'Archer', P: 'Priest', M: 'Mage', B: 'Bard' };
export const SOLO_ID_BY_CLASS: Record<ClassName, string> = { Knight: 'K', Archer: 'A', Priest: 'P', Mage: 'M', Bard: 'B' };

/** Party level minus room level. The room gates stop a member reaching rooms beyond the low end; I1 names any party this ever cuts short. */
export const CORE_BAND: [number, number] = [-30, 60];
export const STALL_BAND: [number, number] = [-10, 10];
/** Carrier level minus room level: on-level, up to well over it. */
export const CARRY_BAND: [number, number] = [-5, 20];

const SOLO_IDS = ['K', 'A', 'P', 'M', 'B'];
const CORE_PARTY_IDS = ['K+P', 'K+A', 'K+P+M', 'K+A+P+M+B'];
export const ARCHER_HIRED_KNIGHT = 'A+hK';
export const DEFAULT_SEAT_PREFIX = 'D:';
export const XP_BONUS_PREFIX = 'I:';
export const FULL_PARTY = 'K+A+P+M+B';
export const TYPICAL_PARTY = 'K+P+M';
const DUO_REFERENCE = 'K+P';
const STACK_PARTY = 'K+P+Bx3';
/** Stacked Mage and Bard parties. An older atlas lacks them, and the card says so beside what it reads about who leads. */
export const MAGE_BARD_PARTIES = ['K+M+Bx3', 'Mx2+Bx3', 'Mx3+Bx2', 'K+Mx3+B', 'A+M+Bx3', 'P+M+Bx3'];
/** Other shapes that lead somewhere when every party shape is simulated: low levels, magic-resistant rooms, harder rooms. */
const LEADING_PARTIES = ['Ax3+Bx2', 'Ax4+B', 'Kx2+Bx3', 'K+A+Bx3', 'K+P+M+Bx2', 'Kx2+Px2+B'];
export const SOLO_FILL_HIRES = 4;
export const DUO_FILL_HIRES = 3;

function expand(id: string): string {
  return id.split('+').flatMap(part => {
    const match = /^([KAPMB])x(\d)$/.exec(part);
    return match ? Array.from({ length: Number(match[2]) }, () => match[1]) : [part];
  }).join('+');
}

function members(id: string, role: MemberRole = 'member', levelOffset = 0): CompMember[] {
  return expand(id).split('+').map(initial => ({ className: CLASS_BY_INITIAL[initial], levelOffset, role }));
}

function comp(id: string, family: CompFamily, memberList: CompMember[], band: [number, number], extra: Partial<XpComp> = {}): XpComp {
  const hires: HirePolicy = extra.hires ?? 'none';
  return { id, family, members: memberList, hires, gear: 'level', skills: 'default', band, ...extra };
}

const HIRED_KNIGHT: Partial<XpComp> = { hires: { className: 'Knight' } };

function coreComps(): XpComp[] {
  return [
    ...[...SOLO_IDS, ...CORE_PARTY_IDS].map(id => comp(id, 'core', members(id), CORE_BAND)),
    ...SOLO_IDS.map(id => comp(`${id}+hires`, 'core', members(id), CORE_BAND, { hires: 'usual' })),
    comp(ARCHER_HIRED_KNIGHT, 'core', members('A'), CORE_BAND, HIRED_KNIGHT),
  ];
}

function extendedComps(): XpComp[] {
  const core = new Set([...SOLO_IDS, ...CORE_PARTY_IDS]);
  const balancedFor: Record<string, string> = { 'P+B': DUO_REFERENCE, Px3: TYPICAL_PARTY, Px5: FULL_PARTY };
  const ids = [
    ...classSubsets().filter(s => !core.has(s.id)).map(s => s.id),
    ...SOLO_IDS.map(i => `${i}x5`),
    'Px3',
    'Kx3',
    STACK_PARTY,
    ...MAGE_BARD_PARTIES,
    ...LEADING_PARTIES,
  ];
  return ids.map(id => comp(id, 'extended', members(id), CORE_BAND, balancedFor[id] ? { reference: balancedFor[id] } : {}));
}

const CARRY_OFFSETS = [10, 20, 40];

function carryComps(): XpComp[] {
  const shapes: { id: string; carriers: string; friends: string }[] = [
    { id: '1+1', carriers: 'K', friends: 'P' },
    { id: '1+1M', carriers: 'M', friends: 'P' },
    { id: '4+1', carriers: 'K+A+M+B', friends: 'P' },
    { id: '1+4', carriers: 'K', friends: 'A+P+M+B' },
  ];
  return shapes.flatMap(shape => CARRY_OFFSETS.map(offset => comp(
    `C${shape.id}:-${offset}`,
    'carry',
    [...members(shape.carriers, 'carrier'), ...members(shape.friends, 'friend', -offset)],
    CARRY_BAND,
  )));
}

/** Every party of distinct classes holding a Bard, so I1b can score each Bard addition wearing the perk, and the stacked Bard parties. */
function xpBonusPartyIds(): string[] {
  const subsets = classSubsets().filter(s => s.humans.includes('Bard')).map(s => s.id);
  return [...subsets, 'Bx5', STACK_PARTY, ...MAGE_BARD_PARTIES, ...LEADING_PARTIES];
}

function stallComps(): XpComp[] {
  const base = [...SOLO_IDS, 'K+P', TYPICAL_PARTY, FULL_PARTY];
  const variant = (prefix: string, id: string, extra: Partial<XpComp>, band: [number, number] = STALL_BAND): XpComp =>
    comp(`${prefix}${id}`, 'stall', members(id), band, { reference: id, ...extra });
  return [
    ...base.map(id => variant('U:', id, { gear: 'ungeared' })),
    comp(`U:${ARCHER_HIRED_KNIGHT}`, 'stall', members('A'), STALL_BAND, { reference: ARCHER_HIRED_KNIGHT, gear: 'ungeared', ...HIRED_KNIGHT }),
    ...base.map(id => variant('N:', id, { skills: 'attackOnly' })),
    comp(`N:${ARCHER_HIRED_KNIGHT}`, 'stall', members('A'), STALL_BAND, { reference: ARCHER_HIRED_KNIGHT, skills: 'attackOnly', ...HIRED_KNIGHT }),
    ...['K+P', TYPICAL_PARTY, FULL_PARTY].map(id => variant('S:', id, { swapSeats: ['Knight', 'Priest'] })),
    comp(`S:${ARCHER_HIRED_KNIGHT}`, 'stall', members('A'), STALL_BAND, { reference: ARCHER_HIRED_KNIGHT, swapSeats: ['Archer', 'Knight'], ...HIRED_KNIGHT }),
    comp('Px2', 'stall', members('Px2'), STALL_BAND, { reference: DUO_REFERENCE }),
    comp('Px2+B', 'stall', members('Px2+B'), STALL_BAND, { reference: TYPICAL_PARTY }),
    comp('Px3+Bx2', 'stall', members('Px3+Bx2'), STALL_BAND, { reference: FULL_PARTY }),
    ...xpBonusPartyIds().map(id => variant(XP_BONUS_PREFIX, id, { xpBonus: true }, CORE_BAND)),
  ];
}

function seatingComps(): XpComp[] {
  const seated: Partial<XpComp> = { seating: 'default' };
  return [
    ...[...SOLO_IDS, ...CORE_PARTY_IDS].map(id => comp(`${DEFAULT_SEAT_PREFIX}${id}`, 'seating', members(id), CORE_BAND, { ...seated, reference: id })),
    ...SOLO_IDS.map(id => comp(`${DEFAULT_SEAT_PREFIX}${id}+hires`, 'seating', members(id), CORE_BAND, { ...seated, hires: 'usual', reference: `${id}+hires` })),
    comp(`${DEFAULT_SEAT_PREFIX}${ARCHER_HIRED_KNIGHT}`, 'seating', members('A'), CORE_BAND, { ...seated, ...HIRED_KNIGHT, reference: ARCHER_HIRED_KNIGHT }),
  ];
}

function hiredComps(): XpComp[] {
  const pairs = classSubsets().filter(s => s.humans.length === 2).map(s => s.id);
  return [
    ...SOLO_IDS.map(id => comp(`${id}+h${SOLO_FILL_HIRES}`, 'hired', members(id), CORE_BAND, { hires: { fill: SOLO_FILL_HIRES } })),
    ...pairs.map(id => comp(`${id}+h${DUO_FILL_HIRES}`, 'hired', members(id), CORE_BAND, { hires: { fill: DUO_FILL_HIRES } })),
  ];
}

export function buildComps(families: readonly CompFamily[]): XpComp[] {
  const all = [...coreComps(), ...extendedComps(), ...carryComps(), ...stallComps(), ...seatingComps(), ...hiredComps()];
  return all.filter(c => families.includes(c.family));
}

export const ALL_FAMILIES: readonly CompFamily[] = ['core', 'extended', 'carry', 'stall', 'seating', 'hired'];
