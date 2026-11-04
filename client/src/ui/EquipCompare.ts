import type { ItemDefinition } from '@idle-party-rpg/shared';
import { getItemsDisplacedByEquip } from '@idle-party-rpg/shared';
import { RARITY_COLORS, escapeHtml } from './ItemIcon';

type StatKey = 'atk' | 'dr' | 'mr';

interface StatRange {
  lo: number;
  hi: number;
}

const STATS: { key: StatKey; label: string }[] = [
  { key: 'atk', label: 'ATK' },
  { key: 'dr', label: 'DR' },
  { key: 'mr', label: 'MR' },
];

const DASH = '<span class="compare-dash">—</span>';

/**
 * Stat comparison between `newDef` and everything equipping it would displace (both hands for a
 * two-handed weapon). '' when nothing would be displaced.
 */
export function renderEquipCompareBlock(
  newDef: ItemDefinition,
  equipment: Record<string, string | null>,
  itemDefs: Record<string, ItemDefinition>,
): string {
  const displaced = getItemsDisplacedByEquip(newDef, equipment)
    .map(id => itemDefs[id])
    .filter((def): def is ItemDefinition => !!def);
  if (displaced.length === 0) return '';

  const rows = STATS.map(({ key, label }) => {
    const next = sumStat([newDef], key);
    const current = sumStat(displaced, key);
    const newText = formatStat(next, key);
    const oldText = formatStat(current, key);
    if (newText === null && oldText === null) return '';
    const arrow = newText !== null && oldText !== null ? compareArrow(next, current) : '';
    return `
        <div class="compare-row">
          <div class="compare-cell-label">${label}</div>
          <div class="compare-cell-new">${newText ?? DASH}</div>
          <div class="compare-cell-arrow">${arrow}</div>
          <div class="compare-cell-old">${oldText ?? DASH}</div>
        </div>
      `;
  }).join('');

  const names = displaced
    .map(def => `<span style="color:${RARITY_COLORS[def.rarity ?? 'common'] ?? '#e8e8e8'}">${escapeHtml(def.name)}</span>`)
    .join(' + ');

  return `
      <div class="item-popup-compare">
        <div class="compare-block-header">
          <span class="compare-block-label">Replaces equipped</span>
          <span class="compare-block-old-name">${names}</span>
        </div>
        <div class="compare-block-subhead">
          <span class="compare-cell-label">Stat</span>
          <span class="compare-side-label">This</span>
          <span></span>
          <span class="compare-side-label">Equipped</span>
        </div>
        <div class="compare-grid">${rows || '<div class="compare-dash" style="text-align:center;grid-column:1/-1">No combat stats</div>'}</div>
      </div>
    `;
}

function sumStat(defs: ItemDefinition[], key: StatKey): StatRange {
  const range = { lo: 0, hi: 0 };
  for (const def of defs) {
    if (key === 'atk') {
      range.lo += def.bonusAttackMin ?? 0;
      range.hi += def.bonusAttackMax ?? 0;
    } else if (key === 'dr') {
      range.lo += def.damageReductionMin ?? 0;
      range.hi += def.damageReductionMax ?? 0;
    } else {
      range.lo += def.magicReductionMin ?? 0;
      range.hi += def.magicReductionMax ?? 0;
    }
  }
  return range;
}

function formatStat({ lo, hi }: StatRange, key: StatKey): string | null {
  if (lo === 0 && hi === 0) return null;
  const sign = key === 'atk' ? '+' : '';
  return lo === hi ? `${sign}${lo}` : `${sign}${lo}-${hi}`;
}

function compareArrow(next: StatRange, current: StatRange): string {
  const nextMid = (next.lo + next.hi) / 2;
  const currentMid = (current.lo + current.hi) / 2;
  if (nextMid > currentMid) return '<span class="compare-up">↑</span>';
  if (nextMid < currentMid) return '<span class="compare-down">↓</span>';
  return '<span class="compare-eq">=</span>';
}
