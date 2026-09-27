import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import {
  ENRAGE_MAX_STACKS,
  ENRAGE_STEP_PERCENT,
  ENRAGE_STEP_SECONDS,
  ENRAGE_TIER_DEFAULTS,
  MIN_MONSTER_ACTION_INTERVAL_MS,
  MONSTER_SKILL_CATALOG,
  MONSTER_TIERS,
  isAuthoredMonsterLevel,
  isBossTier,
  suggestMonsterStats,
  suggestTierFromHp,
} from '@idle-party-rpg/shared';
import type {
  MonsterDefinition,
  MonsterEnrage,
  MonsterRole,
  MonsterTier,
  ItemDefinition,
  Resistance,
  MonsterSkillEntry,
  DamageType,
} from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';
import { renderArtworkSection, wireArtworkSection } from '../components/ArtworkSection';

const MIN_ATTACK_INTERVAL_SECONDS = MIN_MONSTER_ACTION_INTERVAL_MS / 1000;
const MONSTER_LEVEL_MIN = 1;
const MONSTER_LEVEL_MAX = 200;
const LEVEL_NOT_SET = 'not set — no level scaling';
const MONSTER_ROLES: readonly MonsterRole[] = ['bruiser', 'caster', 'skirmisher'];

type EnrageKey = keyof MonsterEnrage;
interface EnrageField {
  key: EnrageKey;
  id: string;
  label: string;
  min: number;
  max: number;
  step: string;
  integer: boolean;
}
const ENRAGE_FIELDS: readonly EnrageField[] = [
  { key: 'afterSeconds', id: 'mf-enrage-after', label: 'Starts after (s)', min: 0, max: 86_400, step: '1', integer: false },
  { key: 'stepSeconds', id: 'mf-enrage-step', label: 'Stack every (s)', min: 1, max: 3_600, step: '1', integer: false },
  { key: 'stepPercent', id: 'mf-enrage-percent', label: 'Per stack (0.1 = +10 %)', min: 0, max: 1, step: '0.01', integer: false },
  { key: 'maxStacks', id: 'mf-enrage-max', label: 'Max stacks', min: 0, max: 1_000, step: '1', integer: true },
];

export class MonstersTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const monsters = Object.values(content.monsters);
    const items = content.items;
    const readOnly = ctx.isReadOnly();

    const rows = monsters.map(m => {
      const drops = m.drops?.map(d => {
        const item = items[d.itemId];
        return `${item?.name ?? d.itemId} (${(d.chance * 100).toFixed(3)}%)`;
      }).join(', ') ?? 'None';

      const actions = readOnly
        ? `<td class="admin-actions-cell"><button class="admin-btn admin-btn-sm monster-view-btn" data-id="${m.id}">View</button></td>`
        : `<td class="admin-actions-cell">
            <button class="admin-btn admin-btn-sm monster-edit-btn" data-id="${m.id}">Edit</button>
            <button class="admin-btn admin-btn-sm admin-btn-danger monster-delete-btn" data-id="${m.id}">Del</button>
          </td>`;

      const level = isAuthoredMonsterLevel(m.level)
        ? String(m.level)
        : `<span class="admin-muted" title="${LEVEL_NOT_SET}">—</span>`;
      const tier = m.tier && m.tier !== 'trash'
        ? `<span class="admin-pill${isBossTier(m.tier) ? ' admin-pill-gold' : ''}">${escapeHtml(String(m.tier))}</span>`
        : '<span class="admin-muted">trash</span>';
      return `
        <tr>
          <td>${escapeHtml(m.name)}${m.passive ? ' <span class="admin-pill">passive</span>' : ''}</td>
          <td class="monster-level-cell">${level}</td>
          <td class="monster-tier-cell">${tier}</td>
          <td>${m.hp}</td>
          <td>${m.damage}${m.attackInterval != null && m.attackInterval !== 1 ? ` <span class="admin-muted">/ ${m.attackInterval}s</span>` : ''}</td>
          <td>${m.damageType}</td>
          <td>${m.xp}</td>
          <td>${m.goldMin}-${m.goldMax}</td>
          <td>${escapeHtml(drops)}</td>
          <td>${m.resistances?.length ?? 0} res, ${m.skills?.length ?? 0} skills</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="monster-add-btn">+ Add Monster</button>';
    const actionsHeader = '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Monsters <span class="admin-count-badge">${monsters.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Level</th>
                <th>Tier</th>
                <th>HP</th>
                <th>Dmg / Speed</th>
                <th>Type</th>
                <th>XP</th>
                <th>Gold</th>
                <th>Drops</th>
                <th>Mods</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#monster-add-btn')?.addEventListener('click', () => {
      this.openForm(null, ctx);
    });
    container.querySelectorAll<HTMLButtonElement>('.monster-edit-btn, .monster-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        const monster = ctx.getDisplayContent()?.monsters[id];
        if (monster) this.openForm(monster, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.monster-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        this.deleteMonster(ctx, id);
      });
    });
  }

  private openForm(monster: MonsterDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;

    const isNew = !monster;
    const readOnly = ctx.isReadOnly();
    const m: MonsterDefinition = monster ?? {
      id: '', name: '', hp: 10, damage: 3, damageType: 'physical',
      xp: 5, goldMin: 1, goldMax: 2, drops: [],
    };
    const items = Object.values(content.items);

    const dropRows = (m.drops ?? []).map((d, i) => this.dropRowHtml(i, d.itemId, d.chance, items)).join('');
    const resistanceRows = (m.resistances ?? []).map((r, i) => this.resistanceRowHtml(i, r)).join('');
    const skillRows = (m.skills ?? []).map((s, i) => this.skillRowHtml(i, s)).join('');

    const bodyHtml = `
      <input type="hidden" id="mf-id" value="${escapeHtml(m.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="mf-name" value="${escapeHtml(m.name)}"></label>
        <label>HP<input type="number" id="mf-hp" value="${m.hp}" min="1"></label>
        <label>Damage<input type="number" id="mf-damage" value="${m.damage}" min="0"></label>
        <label>Type
          <select id="mf-damageType">
            <option value="physical" ${m.damageType === 'physical' ? 'selected' : ''}>Physical</option>
            <option value="magical" ${m.damageType === 'magical' ? 'selected' : ''}>Magical</option>
            <option value="holy" ${m.damageType === 'holy' ? 'selected' : ''}>Holy</option>
          </select>
        </label>
        <label>Attack interval (s)
          <input type="number" id="mf-attackInterval" value="${m.attackInterval ?? ''}" min="${MIN_ATTACK_INTERVAL_SECONDS}" step="0.05" placeholder="1 (default)">
        </label>
        <label>XP<input type="number" id="mf-xp" value="${m.xp}" min="0"></label>
        <label>Gold Min<input type="number" id="mf-goldMin" value="${m.goldMin}" min="0"></label>
        <label>Gold Max<input type="number" id="mf-goldMax" value="${m.goldMax}" min="0"></label>
        <label class="admin-form-checkbox">
          <input type="checkbox" id="mf-passive" ${m.passive ? 'checked' : ''}>
          Passive (wall — never attacks, doesn't count toward victory)
        </label>
      </div>
      ${this.scalingHtml(m)}
      <label class="admin-form-fullrow">Description (optional)
        <textarea id="mf-description" rows="3">${escapeHtml(m.description ?? '')}</textarea>
      </label>
      <fieldset class="admin-form-fieldset">
        <legend>Drops ${readOnly ? '' : '<button class="admin-btn admin-btn-sm" id="mf-add-drop" type="button">+ Drop</button>'}</legend>
        <div id="mf-drops-list">${dropRows}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Resistances ${readOnly ? '' : '<button class="admin-btn admin-btn-sm" id="mf-add-resistance" type="button">+ Resistance</button>'}</legend>
        <div id="mf-resistances-list">${resistanceRows}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Skills ${readOnly ? '' : '<button class="admin-btn admin-btn-sm" id="mf-add-skill" type="button">+ Skill</button>'}</legend>
        <div class="admin-form-hint">On each action the monster uses the first listed skill that is off cooldown and has something to do, otherwise it attacks. Cooldown and cast time are in seconds; cooldown 0 = every action; blank cast time = the skill's default.</div>
        <div id="mf-skills-list">${skillRows}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Artwork</legend>
        ${renderArtworkSection({ kind: 'monster', id: m.id })}
      </fieldset>
    `;
    const actionsHtml = readOnly
      ? `<div class="admin-modal-actions admin-modal-actions-readonly">
          <span class="admin-form-hint admin-modal-readonly-hint">* Create a new draft to edit</span>
          <button class="admin-btn admin-btn-secondary" id="mf-cancel" type="button">Close</button>
        </div>`
      : `<div class="admin-modal-actions">
          <button class="admin-btn" id="mf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="mf-cancel" type="button">Cancel</button>
        </div>`;
    const wrappedBody = readOnly
      ? `<fieldset class="admin-form-readonly-wrap" disabled>${bodyHtml}</fieldset>${actionsHtml}`
      : `${bodyHtml}${actionsHtml}`;
    const titlePrefix = isNew ? 'Add' : (readOnly ? 'View' : 'Edit');
    const modal = openModal({
      title: isNew ? 'Add Monster' : `${titlePrefix}: ${m.name}`,
      bodyHtml: wrappedBody,
      width: '720px',
    });
    const root = modal.body;

    root.querySelector('#mf-cancel')?.addEventListener('click', modal.close);

    root.querySelector('#mf-add-drop')?.addEventListener('click', () => {
      const list = root.querySelector('#mf-drops-list');
      if (!list || items.length === 0) return;
      const index = list.querySelectorAll('.monster-drop-row').length;
      list.insertAdjacentHTML('beforeend', this.dropRowHtml(index, items[0].id, 0.1, items));
      this.wireRowRemovers(root, '.mf-drop-remove', '.monster-drop-row');
    });

    root.querySelector('#mf-add-resistance')?.addEventListener('click', () => {
      const list = root.querySelector('#mf-resistances-list');
      if (!list) return;
      const index = list.querySelectorAll('.monster-resistance-row').length;
      list.insertAdjacentHTML('beforeend', this.resistanceRowHtml(index, {
        damageType: 'physical', flatReduction: 0, percentReduction: 0,
      }));
      this.wireRowRemovers(root, '.mf-res-remove', '.monster-resistance-row');
    });

    root.querySelector('#mf-add-skill')?.addEventListener('click', () => {
      const list = root.querySelector('#mf-skills-list');
      if (!list) return;
      const index = list.querySelectorAll('.monster-skill-row').length;
      const firstSkillId = Object.keys(MONSTER_SKILL_CATALOG)[0];
      const defaultCd = MONSTER_SKILL_CATALOG[firstSkillId]?.cooldown ?? 3;
      list.insertAdjacentHTML('beforeend', this.skillRowHtml(index, {
        skillId: firstSkillId, value: 1, cooldown: defaultCd,
      }));
      this.wireRowRemovers(root, '.mf-skill-remove', '.monster-skill-row');
    });

    this.wireRowRemovers(root, '.mf-drop-remove', '.monster-drop-row');
    this.wireRowRemovers(root, '.mf-res-remove', '.monster-resistance-row');
    this.wireRowRemovers(root, '.mf-skill-remove', '.monster-skill-row');

    root.querySelector('#mf-skills-list')?.addEventListener('change', e => {
      const select = e.target as HTMLElement;
      if (!select.classList.contains('mf-skill-id')) return;
      const row = select.closest<HTMLElement>('.monster-skill-row');
      if (row) this.syncSkillRowDefaults(row);
    });

    root.querySelector('#mf-save')?.addEventListener('click', () => {
      this.saveForm(root, ctx, monster, modal.close);
    });

    this.wireScaling(root, m);

    wireArtworkSection(root, { kind: 'monster', id: m.id });
  }

  private scalingHtml(m: MonsterDefinition): string {
    const tier = m.tier ?? 'trash';
    const unknownTier = (MONSTER_TIERS as readonly string[]).includes(tier)
      ? ''
      : `<option value="${escapeHtml(String(tier))}" selected>Unknown: ${escapeHtml(String(tier))}</option>`;
    const tierOptions = MONSTER_TIERS.map(t =>
      `<option value="${t}" ${t === tier ? 'selected' : ''}>${t[0].toUpperCase()}${t.slice(1)}</option>`
    ).join('');
    const roleOptions = '<option value="">Standard</option>' + MONSTER_ROLES.map(r =>
      `<option value="${r}">${r[0].toUpperCase()}${r.slice(1)}</option>`
    ).join('');
    const enrageInputs = ENRAGE_FIELDS.map(f => {
      const value = m.enrage?.[f.key];
      return `<label>${f.label}<input type="number" id="${f.id}" value="${value ?? ''}" min="${f.min}" max="${f.max}" step="${f.step}"></label>`;
    }).join('');
    return `
      <fieldset class="admin-form-fieldset">
        <legend>Level &amp; tier</legend>
        <div class="admin-form-grid">
          <label>Level
            <input type="number" id="mf-level" value="${m.level ?? ''}" min="${MONSTER_LEVEL_MIN}" max="${MONSTER_LEVEL_MAX}" step="1" placeholder="${LEVEL_NOT_SET}">
          </label>
          <label>Tier
            <select id="mf-tier">${unknownTier}${tierOptions}</select>
            <span class="admin-form-hint" id="mf-tier-hint"></span>
          </label>
        </div>
        <div class="admin-form-hint">A level (${MONSTER_LEVEL_MIN}–${MONSTER_LEVEL_MAX}) turns on level scaling against players and shows players a level badge. Blank = ${LEVEL_NOT_SET}: the monster fights on its raw stats and players see no level. Boss and raid tiers get a boss bar, dungeon checkpoints and enrage.</div>
        <div class="admin-form-row">
          <label>Role<select id="mf-role">${roleOptions}</select></label>
          <button class="admin-btn admin-btn-sm" id="mf-suggest" type="button">Suggest stats</button>
          <span class="admin-form-hint">Fills HP, damage, attack interval, XP and gold with on-level starting values for the level and tier.</span>
        </div>
      </fieldset>
      <fieldset class="admin-form-fieldset" id="mf-enrage-fieldset">
        <legend>Enrage</legend>
        <div class="admin-form-hint">Outgoing damage × (1 + stacks × per stack). Blank fields use the default shown in grey; all blank = the tier default.</div>
        <div class="admin-form-grid">${enrageInputs}</div>
      </fieldset>
    `;
  }

  private wireScaling(root: HTMLElement, m: MonsterDefinition): void {
    const tierSelect = root.querySelector<HTMLSelectElement>('#mf-tier');
    if (!tierSelect) return;
    const refresh = () => {
      const tier = tierSelect.value as MonsterTier;
      this.refreshEnrage(root, tier, !!m.enrage);
      this.refreshTierHint(root, m, tier);
    };
    tierSelect.addEventListener('change', refresh);
    for (const id of ['#mf-hp', '#mf-damage', '#mf-attackInterval', '#mf-level']) {
      root.querySelector(id)?.addEventListener('input', refresh);
    }
    root.querySelector('#mf-suggest')?.addEventListener('click', () => this.applySuggestedStats(root));
    refresh();
  }

  private refreshEnrage(root: HTMLElement, tier: MonsterTier, hasEnrage: boolean): void {
    const fieldset = root.querySelector<HTMLElement>('#mf-enrage-fieldset');
    if (fieldset) fieldset.hidden = !isBossTier(tier) && !hasEnrage;
    const defaults: Record<EnrageKey, string> = {
      afterSeconds: ENRAGE_TIER_DEFAULTS[tier] ? String(ENRAGE_TIER_DEFAULTS[tier]!.afterSeconds) : 'required',
      stepSeconds: String(ENRAGE_STEP_SECONDS),
      stepPercent: String(ENRAGE_STEP_PERCENT),
      maxStacks: String(ENRAGE_MAX_STACKS),
    };
    for (const f of ENRAGE_FIELDS) {
      const input = root.querySelector<HTMLInputElement>(`#${f.id}`);
      if (input) input.placeholder = defaults[f.key];
    }
  }

  private refreshTierHint(root: HTMLElement, m: MonsterDefinition, tier: MonsterTier): void {
    const hint = root.querySelector<HTMLElement>('#mf-tier-hint');
    if (!hint) return;
    const levelRaw = (root.querySelector('#mf-level') as HTMLInputElement).value.trim();
    const intervalRaw = (root.querySelector('#mf-attackInterval') as HTMLInputElement).value.trim();
    const suggested = suggestTierFromHp({
      ...m,
      hp: Number((root.querySelector('#mf-hp') as HTMLInputElement).value),
      damage: Number((root.querySelector('#mf-damage') as HTMLInputElement).value),
      attackInterval: intervalRaw === '' ? undefined : Number(intervalRaw),
      level: levelRaw === '' ? undefined : Number(levelRaw),
      tier,
    });
    hint.textContent = suggested !== tier ? `suggested: ${suggested}` : '';
  }

  private applySuggestedStats(root: HTMLElement): void {
    const level = Number((root.querySelector('#mf-level') as HTMLInputElement).value.trim() || NaN);
    if (!this.isValidLevel(level)) {
      alert(`Set a level (${MONSTER_LEVEL_MIN}–${MONSTER_LEVEL_MAX}) first — stats are suggested for a level.`);
      return;
    }
    const tier = (root.querySelector('#mf-tier') as HTMLSelectElement).value as MonsterTier;
    if (!(MONSTER_TIERS as readonly string[]).includes(tier)) {
      alert('Pick a known tier first.');
      return;
    }
    const role = (root.querySelector('#mf-role') as HTMLSelectElement).value as MonsterRole | '';
    const stats = suggestMonsterStats(level, tier, role || undefined);
    const fill: [string, number][] = [
      ['#mf-hp', stats.hp],
      ['#mf-damage', stats.damage],
      ['#mf-attackInterval', stats.attackInterval],
      ['#mf-xp', stats.xp],
      ['#mf-goldMin', stats.goldMin],
      ['#mf-goldMax', stats.goldMax],
    ];
    for (const [selector, value] of fill) {
      (root.querySelector(selector) as HTMLInputElement).value = String(value);
    }
    root.querySelector('#mf-hp')?.dispatchEvent(new Event('input'));
  }

  private isValidLevel(level: number): boolean {
    return Number.isInteger(level) && level >= MONSTER_LEVEL_MIN && level <= MONSTER_LEVEL_MAX;
  }

  /** Reads the enrage inputs; undefined = no explicit enrage, string = validation error. */
  private readEnrage(root: HTMLElement, tier: MonsterTier, original: MonsterEnrage | undefined): MonsterEnrage | undefined | string {
    const raw = ENRAGE_FIELDS.map(f => ({ f, text: (root.querySelector(`#${f.id}`) as HTMLInputElement).value.trim() }));
    if (raw.every(r => r.text === '')) return undefined;
    const enrage: Record<string, unknown> = { ...original };
    for (const { f, text } of raw) {
      if (text === '') {
        delete enrage[f.key];
        continue;
      }
      const value = Number(text);
      if (!Number.isFinite(value) || value < f.min || value > f.max || (f.integer && !Number.isInteger(value))) {
        return `Enrage "${f.label}" must be ${f.integer ? 'a whole number' : 'a number'} from ${f.min} to ${f.max}.`;
      }
      enrage[f.key] = value;
    }
    if (enrage.afterSeconds === undefined) {
      const fallback = ENRAGE_TIER_DEFAULTS[tier]?.afterSeconds;
      if (fallback === undefined) return 'Enrage needs "Starts after (s)" on trash and elite monsters (they have no default).';
      enrage.afterSeconds = fallback;
    }
    return enrage as unknown as MonsterEnrage;
  }

  private wireRowRemovers(root: HTMLElement, btnSel: string, rowSel: string): void {
    root.querySelectorAll<HTMLButtonElement>(btnSel).forEach(btn => {
      btn.onclick = () => btn.closest(rowSel)?.remove();
    });
  }

  private dropRowHtml(index: number, itemId: string, chance: number, items: ItemDefinition[]): string {
    const options = items.map(i =>
      `<option value="${i.id}" ${i.id === itemId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`
    ).join('');
    const rateHint = chance > 0 ? `<span class="admin-form-hint">~${Math.round(1 / chance)} per kill</span>` : '';
    return `
      <div class="monster-drop-row admin-form-row" data-index="${index}">
        <select class="mf-drop-item">${options}</select>
        <input type="number" class="mf-drop-chance" value="${(chance * 100).toFixed(3)}" min="0.001" max="100" step="0.001">
        <span>%</span>
        ${rateHint}
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-drop-remove" type="button">×</button>
      </div>
    `;
  }

  private resistanceRowHtml(index: number, resistance: Resistance): string {
    return `
      <div class="monster-resistance-row admin-form-row" data-index="${index}">
        <select class="mf-res-type">
          <option value="physical" ${resistance.damageType === 'physical' ? 'selected' : ''}>Physical</option>
          <option value="magical" ${resistance.damageType === 'magical' ? 'selected' : ''}>Magical</option>
          <option value="holy" ${resistance.damageType === 'holy' ? 'selected' : ''}>Holy</option>
        </select>
        <label>Flat<input type="number" class="mf-res-flat" value="${resistance.flatReduction}" step="1"></label>
        <label>%<input type="number" class="mf-res-percent" value="${resistance.percentReduction}" step="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-res-remove" type="button">×</button>
      </div>
    `;
  }

  private skillRowHtml(index: number, entry: MonsterSkillEntry): string {
    const options = Object.values(MONSTER_SKILL_CATALOG).map(s =>
      `<option value="${s.id}" ${s.id === entry.skillId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`
    ).join('');
    const unknown = MONSTER_SKILL_CATALOG[entry.skillId]
      ? ''
      : `<option value="${escapeHtml(entry.skillId)}" selected>Unknown: ${escapeHtml(entry.skillId)}</option>`;
    const skillDef = MONSTER_SKILL_CATALOG[entry.skillId];
    return `
      <div class="monster-skill-row admin-form-row" data-index="${index}">
        <select class="mf-skill-id">${unknown}${options}</select>
        <label>Value<input type="number" class="mf-skill-value" value="${entry.value}" min="1"></label>
        <label>CD (s)<input type="number" class="mf-skill-cd" value="${entry.cooldown}" min="0" step="0.1"></label>
        <label>Cast (s)<input type="number" class="mf-skill-cast" value="${entry.castTime ?? ''}" min="0" max="10" step="0.1" placeholder="${skillDef?.castTime ?? 0}"></label>
        <span class="admin-form-hint mf-skill-info">${escapeHtml(this.skillInfo(entry.skillId))}</span>
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-skill-remove" type="button">×</button>
      </div>
    `;
  }

  private skillInfo(skillId: string): string {
    const def = MONSTER_SKILL_CATALOG[skillId];
    if (!def) return 'Not in the skill catalog — the monster will skip it';
    return `${def.targeting} / ${def.effect} — ${def.description}`;
  }

  private syncSkillRowDefaults(row: HTMLElement): void {
    const skillId = (row.querySelector('.mf-skill-id') as HTMLSelectElement).value;
    const def = MONSTER_SKILL_CATALOG[skillId];
    const info = row.querySelector<HTMLElement>('.mf-skill-info');
    if (info) info.textContent = this.skillInfo(skillId);
    const cast = row.querySelector<HTMLInputElement>('.mf-skill-cast');
    if (cast) cast.placeholder = String(def?.castTime ?? 0);
    const cd = row.querySelector<HTMLInputElement>('.mf-skill-cd');
    if (cd && def) cd.value = String(def.cooldown);
  }

  private async saveForm(
    root: HTMLElement,
    ctx: AdminContext,
    original: MonsterDefinition | null,
    close: () => void,
  ): Promise<void> {
    const existingId = (root.querySelector('#mf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#mf-name') as HTMLInputElement).value.trim();
    const hp = parseInt((root.querySelector('#mf-hp') as HTMLInputElement).value);
    const damage = parseInt((root.querySelector('#mf-damage') as HTMLInputElement).value);
    const damageType = (root.querySelector('#mf-damageType') as HTMLSelectElement).value as DamageType;
    const xp = parseInt((root.querySelector('#mf-xp') as HTMLInputElement).value);
    const goldMin = parseInt((root.querySelector('#mf-goldMin') as HTMLInputElement).value);
    const goldMax = parseInt((root.querySelector('#mf-goldMax') as HTMLInputElement).value);
    const attackIntervalRaw = (root.querySelector('#mf-attackInterval') as HTMLInputElement).value.trim();
    const attackInterval = attackIntervalRaw === '' ? undefined : parseFloat(attackIntervalRaw);

    const levelRaw = (root.querySelector('#mf-level') as HTMLInputElement).value.trim();
    const level = levelRaw === '' ? undefined : Number(levelRaw);
    const tierValue = (root.querySelector('#mf-tier') as HTMLSelectElement).value as MonsterTier;
    const tier = tierValue === 'trash' && original?.tier === undefined ? undefined : tierValue;

    if (!name) { alert('Name is required.'); return; }
    if (attackInterval !== undefined && !(attackInterval >= MIN_ATTACK_INTERVAL_SECONDS)) {
      alert(`Attack interval must be at least ${MIN_ATTACK_INTERVAL_SECONDS} seconds (blank = 1).`);
      return;
    }
    if (level !== undefined && !this.isValidLevel(level)) {
      alert(`Level must be a whole number from ${MONSTER_LEVEL_MIN} to ${MONSTER_LEVEL_MAX} (blank = ${LEVEL_NOT_SET}).`);
      return;
    }
    const enrageShown = !root.querySelector<HTMLElement>('#mf-enrage-fieldset')?.hidden;
    const enrage = enrageShown ? this.readEnrage(root, tierValue, original?.enrage) : undefined;
    if (typeof enrage === 'string') { alert(enrage); return; }

    const content = ctx.getDisplayContent();
    if (content) {
      const dup = Object.values(content.monsters).find(m => m.name === name && m.id !== existingId);
      if (dup) { alert(`A monster named "${name}" already exists.`); return; }
    }
    const id = existingId || crypto.randomUUID();

    const drops: { itemId: string; chance: number }[] = [];
    root.querySelectorAll('.monster-drop-row').forEach(row => {
      const itemId = (row.querySelector('.mf-drop-item') as HTMLSelectElement).value;
      const chance = parseFloat((row.querySelector('.mf-drop-chance') as HTMLInputElement).value) / 100;
      if (itemId && chance > 0) drops.push({ itemId, chance });
    });

    const resistances: Resistance[] = [];
    root.querySelectorAll('.monster-resistance-row').forEach(row => {
      const dt = (row.querySelector('.mf-res-type') as HTMLSelectElement).value as DamageType;
      const flatReduction = parseInt((row.querySelector('.mf-res-flat') as HTMLInputElement).value) || 0;
      const percentReduction = parseInt((row.querySelector('.mf-res-percent') as HTMLInputElement).value) || 0;
      resistances.push({ damageType: dt, flatReduction, percentReduction });
    });

    const skills: MonsterSkillEntry[] = [];
    root.querySelectorAll('.monster-skill-row').forEach(row => {
      const skillId = (row.querySelector('.mf-skill-id') as HTMLSelectElement).value;
      if (!skillId) return;
      const value = parseInt((row.querySelector('.mf-skill-value') as HTMLInputElement).value) || 1;
      const cooldownRaw = parseFloat((row.querySelector('.mf-skill-cd') as HTMLInputElement).value);
      const cooldown = Number.isFinite(cooldownRaw) && cooldownRaw >= 0
        ? cooldownRaw
        : (MONSTER_SKILL_CATALOG[skillId]?.cooldown ?? 3);
      const castTime = parseFloat((row.querySelector('.mf-skill-cast') as HTMLInputElement).value);
      const entry: MonsterSkillEntry = { skillId, value, cooldown };
      if (Number.isFinite(castTime) && castTime >= 0) entry.castTime = castTime;
      skills.push(entry);
    });

    const passive = (root.querySelector('#mf-passive') as HTMLInputElement).checked;
    const description = (root.querySelector('#mf-description') as HTMLTextAreaElement).value.trim();

    const monster: MonsterDefinition = {
      ...original,
      id, name, hp, damage, damageType, xp, goldMin, goldMax,
      attackInterval,
      drops: drops.length > 0 ? drops : undefined,
      resistances: resistances.length > 0 ? resistances : undefined,
      skills: skills.length > 0 ? skills : undefined,
      passive: passive ? true : undefined,
      description: description || undefined,
      level,
      tier,
      enrage,
    };

    try {
      const data = await putAdmin<{ monsters: Record<string, MonsterDefinition> }>(
        `/api/admin/monsters/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, monster);
      ctx.patchVersionContent({ monsters: data.monsters });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteMonster(ctx: AdminContext, id: string): Promise<void> {
    const monster = ctx.getDisplayContent()?.monsters[id];
    if (!monster) return;
    if (!confirm(`Delete monster "${monster.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ monsters: Record<string, MonsterDefinition> }>(
        `/api/admin/monsters/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ monsters: data.monsters });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
