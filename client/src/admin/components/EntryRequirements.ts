import type { ItemDefinition, QuestDefinition, RoomEntryRequirements } from '@idle-party-rpg/shared';
import { escapeHtml } from '../api.js';

/**
 * Shared editor for a room / tile-type entry gate. Rendered by the Map editor's
 * room sidebar and the Tile Types form so both author the same model.
 *
 * The caller owns the object: {@link readEntryRequirements} reads the current
 * DOM state back out, returning undefined when nothing is set so an empty gate
 * is never persisted.
 */
export interface EntryRequirementsOptions {
  /** Prefix for every element id, so two editors can coexist on one page. */
  idPrefix: string;
  current: RoomEntryRequirements | undefined;
  items: ItemDefinition[];
  quests: QuestDefinition[];
  readOnly: boolean;
  /** Label + hint for the item select, which differs between rooms and types. */
  itemLabel: string;
  itemNoneLabel: string;
  hint: string;
}

export function entryRequirementsHtml(opts: EntryRequirementsOptions): string {
  const { idPrefix, current, items, quests, readOnly } = opts;
  const disabled = readOnly ? ' disabled' : '';
  const selectedQuests = new Set(current?.requiredQuestIds ?? []);

  const itemOptions = `<option value="">${escapeHtml(opts.itemNoneLabel)}</option>` + items.map(i =>
    `<option value="${escapeHtml(i.id)}"${i.id === (current?.requiredItemId ?? '') ? ' selected' : ''}>${escapeHtml(i.name)}</option>`
  ).join('');

  const questRows = quests.length
    ? quests.map(q =>
        `<label class="admin-checkbox"><input type="checkbox" data-${idPrefix}-quest="${escapeHtml(q.id)}"${selectedQuests.has(q.id) ? ' checked' : ''}${disabled}> ${escapeHtml(q.name)}</label>`
      ).join('')
    : `<div class="admin-form-hint">No quests defined yet.</div>`;

  return `
    <fieldset class="admin-form-fieldset">
      <legend>Entry Requirements</legend>
      <div class="admin-form-grid">
        <label>${escapeHtml(opts.itemLabel)}
          <select id="${idPrefix}-item"${disabled}>${itemOptions}</select>
        </label>
        <label>Min Level
          <input type="number" id="${idPrefix}-min-level" min="1" step="1" placeholder="(none)" value="${current?.minLevel ?? ''}"${disabled}>
        </label>
      </div>
      <div class="admin-form-label-text">Required Quests (all must be completed)</div>
      <div class="admin-checklist">${questRows}</div>
      <div class="admin-form-hint">${escapeHtml(opts.hint)}</div>
    </fieldset>`;
}

/**
 * Read the editor's current state back out of the DOM.
 * Returns undefined when the gate constrains nothing.
 */
export function readEntryRequirements(idPrefix: string, root: ParentNode = document): RoomEntryRequirements | undefined {
  const out: RoomEntryRequirements = {};

  const itemSelect = root.querySelector(`#${idPrefix}-item`) as HTMLSelectElement | null;
  if (itemSelect?.value) out.requiredItemId = itemSelect.value;

  const levelInput = root.querySelector(`#${idPrefix}-min-level`) as HTMLInputElement | null;
  const minLevel = Number(levelInput?.value);
  if (levelInput?.value && Number.isFinite(minLevel) && minLevel >= 1) out.minLevel = Math.floor(minLevel);

  const questIds: string[] = [];
  for (const el of root.querySelectorAll(`[data-${idPrefix}-quest]`)) {
    const box = el as HTMLInputElement;
    if (box.checked) questIds.push(box.getAttribute(`data-${idPrefix}-quest`) ?? '');
  }
  if (questIds.length > 0) out.requiredQuestIds = questIds.filter(Boolean);

  return Object.keys(out).length > 0 ? out : undefined;
}

/** One-line summary of a gate for list/card views. Empty string when ungated. */
export function summarizeEntryRequirements(
  reqs: RoomEntryRequirements | undefined,
  itemName: (id: string) => string,
  questName: (id: string) => string,
): string {
  if (!reqs) return '';
  const parts: string[] = [];
  if (reqs.requiredItemId) parts.push(`item:${itemName(reqs.requiredItemId)}`);
  if (reqs.minLevel !== undefined) parts.push(`lvl:${reqs.minLevel}`);
  for (const q of reqs.requiredQuestIds ?? []) parts.push(`quest:${questName(q)}`);
  return parts.join(', ');
}
