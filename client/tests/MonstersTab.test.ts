import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MONSTER_SKILL_CATALOG } from '@idle-party-rpg/shared';
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
});
