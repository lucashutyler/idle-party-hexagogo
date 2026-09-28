import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENRAGE_STEP_SECONDS, MONSTER_SKILL_CATALOG, suggestMonsterStats } from '@idle-party-rpg/shared';
import type { MonsterDefinition } from '@idle-party-rpg/shared';
import { MonstersTab } from '../src/admin/tabs/MonstersTab';
import type { AdminContext } from '../src/admin/AdminContext';
import type { ContentData } from '../src/admin/types';
import { closeAllModals } from '../src/admin/components/Modal';

const SHAMAN = {
  id: 'test_shaman',
  name: 'Test Shaman',
  hp: 18,
  damage: 3,
  damageType: 'holy',
  xp: 9,
  goldMin: 2,
  goldMax: 4,
  attackInterval: 1.25,
  resistances: [{ damageType: 'magical', flatReduction: 1, percentReduction: 10 }],
  skills: [
    { skillId: 'fireball', value: 4, cooldown: 5, castTime: 2 },
    { skillId: 'heal', value: 8, cooldown: 0 },
  ],
  description: 'Mutters at the fire.',
  futureField: { keep: 'me' },
} as unknown as MonsterDefinition;

function makeCtx(monsters: MonsterDefinition[] = [SHAMAN]): AdminContext {
  const content = {
    monsters: Object.fromEntries(monsters.map(m => [m.id, structuredClone(m)])),
    items: {},
  } as unknown as ContentData;
  return {
    me: null,
    overview: null,
    accounts: [],
    versions: [],
    activeVersionId: null,
    selectedVersionId: null,
    versionContent: content,
    getDisplayContent: () => content,
    isReadOnly: () => false,
    versionQueryParam: () => '',
    refresh: async () => {},
    refreshVersions: async () => {},
    selectVersion: async () => {},
    rerenderTab: vi.fn(),
    patchVersionContent: vi.fn(),
    refreshStatusBar: () => {},
  };
}

function stubPut(): { bodies: Record<string, unknown>[] } {
  const captured = { bodies: [] as Record<string, unknown>[] };
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    captured.bodies.push(JSON.parse(String(init?.body)));
    return { ok: true, status: 200, json: async () => ({ monsters: {} }) };
  }));
  return captured;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function openEdit(container: HTMLElement, id: string): HTMLElement {
  container.querySelector<HTMLButtonElement>(`.monster-edit-btn[data-id="${id}"]`)!.click();
  const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
  applySelectedAttributes(modal);
  return modal;
}

// happy-dom 15 resolves an <option selected> attribute to the wrong option; browsers don't.
function applySelectedAttributes(root: HTMLElement): void {
  root.querySelectorAll('select').forEach(select => {
    const marked = select.querySelector<HTMLOptionElement>('option[selected]');
    if (marked) select.value = marked.value;
  });
}

function setValue(root: HTMLElement, selector: string, value: string): void {
  const el = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('MonstersTab', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('alert', vi.fn());
  });

  afterEach(() => {
    closeAllModals();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('saving an unchanged monster preserves every field, including ones the form does not render', async () => {
    const put = stubPut();
    new MonstersTab().render(container, makeCtx());
    const modal = openEdit(container, 'test_shaman');
    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();

    expect(alert).not.toHaveBeenCalled();
    expect(put.bodies).toHaveLength(1);
    expect(put.bodies[0]).toEqual(JSON.parse(JSON.stringify(SHAMAN)));
  });

  it('offers the holy damage type and an attack interval input', () => {
    new MonstersTab().render(container, makeCtx());
    const modal = openEdit(container, 'test_shaman');
    const type = modal.querySelector<HTMLSelectElement>('#mf-damageType')!;
    expect([...type.options].map(o => o.value)).toEqual(['physical', 'magical', 'holy']);
    expect(type.value).toBe('holy');

    const interval = modal.querySelector<HTMLInputElement>('#mf-attackInterval')!;
    expect(interval.value).toBe('1.25');
    expect(interval.min).toBe('0.3');
  });

  it('blank attack interval removes the field; below 0.3 s is rejected', async () => {
    const put = stubPut();
    new MonstersTab().render(container, makeCtx());
    let modal = openEdit(container, 'test_shaman');
    setValue(modal, '#mf-attackInterval', '0.2');
    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();
    expect(put.bodies).toHaveLength(0);
    expect(alert).toHaveBeenCalledTimes(1);

    closeAllModals();
    modal = openEdit(container, 'test_shaman');
    setValue(modal, '#mf-attackInterval', '');
    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();
    expect(put.bodies).toHaveLength(1);
    expect('attackInterval' in put.bodies[0]).toBe(false);
  });

  it('shows per-skill cast time with the catalog default as placeholder and saves seconds', async () => {
    const put = stubPut();
    new MonstersTab().render(container, makeCtx());
    const modal = openEdit(container, 'test_shaman');
    const rows = modal.querySelectorAll<HTMLElement>('.monster-skill-row');
    expect(rows).toHaveLength(2);

    const healCast = rows[1].querySelector<HTMLInputElement>('.mf-skill-cast')!;
    expect(healCast.value).toBe('');
    expect(healCast.placeholder).toBe(String(MONSTER_SKILL_CATALOG.heal.castTime));
    expect(rows[1].querySelector<HTMLInputElement>('.mf-skill-cd')!.min).toBe('0');

    setValue(rows[0], '.mf-skill-cd', '2.5');
    setValue(rows[0], '.mf-skill-cast', '');
    setValue(rows[1], '.mf-skill-cast', '0');
    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();

    expect(put.bodies[0].skills).toEqual([
      { skillId: 'fireball', value: 4, cooldown: 2.5 },
      { skillId: 'heal', value: 8, cooldown: 0, castTime: 0 },
    ]);
  });

  it('refreshes the skill hint, cast placeholder and cooldown when the skill changes', () => {
    new MonstersTab().render(container, makeCtx());
    const modal = openEdit(container, 'test_shaman');
    const row = modal.querySelectorAll<HTMLElement>('.monster-skill-row')[1];
    setValue(row, '.mf-skill-id', 'assassinate');

    const assassinate = MONSTER_SKILL_CATALOG.assassinate;
    expect(row.querySelector('.mf-skill-info')!.textContent).toContain(assassinate.description);
    expect(row.querySelector<HTMLInputElement>('.mf-skill-cast')!.placeholder).toBe(String(assassinate.castTime));
    expect(row.querySelector<HTMLInputElement>('.mf-skill-cd')!.value).toBe(String(assassinate.cooldown));
  });

  it('keeps an unknown skill id selected instead of silently swapping it', async () => {
    const put = stubPut();
    const odd = { ...SHAMAN, skills: [{ skillId: 'meteor', value: 9, cooldown: 4 }] } as MonsterDefinition;
    new MonstersTab().render(container, makeCtx([odd]));
    const modal = openEdit(container, 'test_shaman');
    const row = modal.querySelector<HTMLElement>('.monster-skill-row')!;
    expect(row.querySelector<HTMLSelectElement>('.mf-skill-id')!.value).toBe('meteor');
    expect(row.querySelector('.mf-skill-info')!.textContent).toContain('Not in the skill catalog');

    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();
    expect(put.bodies[0].skills).toEqual([{ skillId: 'meteor', value: 9, cooldown: 4 }]);
  });

  it('shows level and tier columns, with "not set" for a monster without a level', () => {
    const boss = { ...SHAMAN, id: 'test_boss', name: 'Test Boss', level: 12, tier: 'boss' } as MonsterDefinition;
    new MonstersTab().render(container, makeCtx([SHAMAN, boss]));
    const headers = [...container.querySelectorAll('thead th')].map(th => th.textContent);
    expect(headers).toContain('Level');
    expect(headers).toContain('Tier');
    const [shamanRow, bossRow] = [...container.querySelectorAll('tbody tr')];
    expect(shamanRow.querySelector('.monster-level-cell span')!.getAttribute('title')).toBe('not set — no level scaling');
    expect(shamanRow.querySelector('.monster-tier-cell')!.textContent).toBe('trash');
    expect(bossRow.querySelector('.monster-level-cell')!.textContent).toBe('12');
    expect(bossRow.querySelector('.monster-tier-cell')!.textContent).toBe('boss');
  });

  it('blank level stays unset; a level outside 1-200 or a fraction is rejected', async () => {
    const put = stubPut();
    new MonstersTab().render(container, makeCtx());
    let modal = openEdit(container, 'test_shaman');
    const level = modal.querySelector<HTMLInputElement>('#mf-level')!;
    expect(level.value).toBe('');
    expect(level.placeholder).toBe('not set — no level scaling');

    for (const bad of ['0', '201', '2.5']) {
      setValue(modal, '#mf-level', bad);
      modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
      await flush();
    }
    expect(put.bodies).toHaveLength(0);
    expect(alert).toHaveBeenCalledTimes(3);

    closeAllModals();
    modal = openEdit(container, 'test_shaman');
    setValue(modal, '#mf-level', '7');
    setValue(modal, '#mf-tier', 'elite');
    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();
    expect(put.bodies[0]).toMatchObject({ level: 7, tier: 'elite', futureField: { keep: 'me' } });
    expect('enrage' in put.bodies[0]).toBe(false);
  });

  it('shows enrage fields only for boss and raid tiers, with tier defaults as placeholders', async () => {
    const put = stubPut();
    new MonstersTab().render(container, makeCtx());
    const modal = openEdit(container, 'test_shaman');
    const fieldset = modal.querySelector<HTMLElement>('#mf-enrage-fieldset')!;
    expect(fieldset.hidden).toBe(true);

    setValue(modal, '#mf-tier', 'raid');
    expect(fieldset.hidden).toBe(false);
    expect(modal.querySelector<HTMLInputElement>('#mf-enrage-after')!.placeholder).toBe('3600');
    expect(modal.querySelector<HTMLInputElement>('#mf-enrage-step')!.placeholder).toBe(String(ENRAGE_STEP_SECONDS));

    setValue(modal, '#mf-enrage-percent', '0.2');
    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();
    expect(put.bodies[0].tier).toBe('raid');
    expect(put.bodies[0].enrage).toEqual({ afterSeconds: 3600, stepPercent: 0.2 });
  });

  it('drops enrage input typed while the tier was boss once the tier is back to trash', async () => {
    const put = stubPut();
    new MonstersTab().render(container, makeCtx());
    const modal = openEdit(container, 'test_shaman');
    setValue(modal, '#mf-tier', 'boss');
    setValue(modal, '#mf-enrage-after', '120');
    setValue(modal, '#mf-tier', 'trash');
    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();
    expect('enrage' in put.bodies[0]).toBe(false);
    expect('tier' in put.bodies[0]).toBe(false);
  });

  it('rejects an out-of-range enrage field', async () => {
    const put = stubPut();
    const boss = { ...SHAMAN, tier: 'boss' } as MonsterDefinition;
    new MonstersTab().render(container, makeCtx([boss]));
    const modal = openEdit(container, 'test_shaman');
    setValue(modal, '#mf-tier', 'boss');
    expect(modal.querySelector<HTMLElement>('#mf-enrage-fieldset')!.hidden).toBe(false);
    setValue(modal, '#mf-enrage-percent', '5');
    modal.querySelector<HTMLButtonElement>('#mf-save')!.click();
    await flush();
    expect(put.bodies).toHaveLength(0);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it('Suggest stats needs a level, then fills stats for the level, tier and role', () => {
    new MonstersTab().render(container, makeCtx());
    const modal = openEdit(container, 'test_shaman');
    modal.querySelector<HTMLButtonElement>('#mf-suggest')!.click();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(modal.querySelector<HTMLInputElement>('#mf-hp')!.value).toBe('18');

    setValue(modal, '#mf-level', '20');
    setValue(modal, '#mf-tier', 'elite');
    setValue(modal, '#mf-role', 'bruiser');
    modal.querySelector<HTMLButtonElement>('#mf-suggest')!.click();
    const stats = suggestMonsterStats(20, 'elite', 'bruiser');
    expect(modal.querySelector<HTMLInputElement>('#mf-hp')!.value).toBe(String(stats.hp));
    expect(modal.querySelector<HTMLInputElement>('#mf-damage')!.value).toBe(String(stats.damage));
    expect(modal.querySelector<HTMLInputElement>('#mf-attackInterval')!.value).toBe(String(stats.attackInterval));
    expect(modal.querySelector<HTMLInputElement>('#mf-xp')!.value).toBe(String(stats.xp));
    expect(modal.querySelector<HTMLInputElement>('#mf-goldMin')!.value).toBe(String(stats.goldMin));
    expect(modal.querySelector<HTMLInputElement>('#mf-goldMax')!.value).toBe(String(stats.goldMax));
    expect(modal.querySelector('#mf-tier-hint')!.textContent).toBe('');
  });

  it('hints a tier from HP when it differs from the selected tier', () => {
    new MonstersTab().render(container, makeCtx());
    const modal = openEdit(container, 'test_shaman');
    const hint = modal.querySelector('#mf-tier-hint')!;
    expect(hint.textContent).toBe('');

    const boss = suggestMonsterStats(10, 'boss');
    setValue(modal, '#mf-level', '10');
    const hp = modal.querySelector<HTMLInputElement>('#mf-hp')!;
    hp.value = String(boss.hp);
    hp.dispatchEvent(new Event('input'));
    expect(hint.textContent).toBe('suggested: boss');

    setValue(modal, '#mf-tier', 'boss');
    expect(hint.textContent).toBe('');
  });

  it('escapes non-numeric authored values instead of injecting markup', () => {
    const payload = '"><img id="pwn" src="x">';
    const hostile = {
      ...structuredClone(SHAMAN), tier: 'boss', level: payload, hp: payload, damage: payload, damageType: payload,
      xp: payload, goldMin: payload, goldMax: payload, attackInterval: payload,
      enrage: { afterSeconds: payload, stepSeconds: payload, stepPercent: payload, maxStacks: payload },
    } as unknown as MonsterDefinition;
    new MonstersTab().render(container, makeCtx([hostile]));
    expect(document.getElementById('pwn')).toBeNull();
    openEdit(container, 'test_shaman');
    expect(document.getElementById('pwn')).toBeNull();
  });
});
