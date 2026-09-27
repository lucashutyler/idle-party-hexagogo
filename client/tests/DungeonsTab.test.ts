import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DungeonDefinition, EncounterDefinition, MonsterDefinition } from '@idle-party-rpg/shared';
import { DungeonsTab } from '../src/admin/tabs/DungeonsTab';
import type { AdminContext } from '../src/admin/AdminContext';
import type { ContentData } from '../src/admin/types';
import { closeAllModals } from '../src/admin/components/Modal';

const BOSS = { id: 'chief', name: 'Chief', hp: 900, damage: 9, damageType: 'physical', xp: 50, goldMin: 5, goldMax: 9, tier: 'boss' } as MonsterDefinition;
const GRUNT = { id: 'grunt', name: 'Grunt', hp: 20, damage: 2, damageType: 'physical', xp: 2, goldMin: 0, goldMax: 1 } as MonsterDefinition;

const COURT: EncounterDefinition = {
  id: 'court', name: 'Court', type: 'explicit',
  placements: [{ monsterId: 'chief', gridPosition: 4 }, { monsterId: 'grunt', gridPosition: 1 }],
};
const PACK: EncounterDefinition = {
  id: 'pack', name: 'Pack', type: 'random', monsterPool: [{ monsterId: 'grunt', min: 1, max: 2 }],
};

const DUNGEON = {
  id: 'keep',
  name: 'Keep',
  description: 'A keep.',
  futureDungeonField: 42,
  entryRequirements: { minLevel: 3, futureRequirement: 'x' },
  floors: [
    {
      floorNumber: 1,
      gridShape: { cols: 3, rows: 3, futureShape: true },
      encounterTable: [{ encounterId: 'pack', weight: 1 }],
      futureFloorField: 'keep',
    },
    {
      floorNumber: 2,
      gridShape: { cols: 3, rows: 3 },
      encounterTable: [{ encounterId: 'court', weight: 1 }],
      isBoss: true,
      checkpoints: [0.66, 0.33],
      maxWipes: 2,
      checkpointRewardFraction: 0.2,
    },
  ],
} as unknown as DungeonDefinition;

function makeCtx(dungeon: DungeonDefinition = DUNGEON): AdminContext {
  const content = {
    dungeons: { [dungeon.id]: structuredClone(dungeon) },
    encounters: { court: COURT, pack: PACK },
    monsters: { chief: BOSS, grunt: GRUNT },
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
    return { ok: true, status: 200, json: async () => ({ dungeons: {} }) };
  }));
  return captured;
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

// happy-dom 15 resolves an <option selected> attribute to the wrong option; browsers don't.
function applySelectedAttributes(root: HTMLElement): void {
  root.querySelectorAll('select').forEach(select => {
    const marked = select.querySelector<HTMLOptionElement>('option[selected]');
    if (marked) select.value = marked.value;
  });
}

function openEdit(container: HTMLElement): HTMLElement {
  container.querySelector<HTMLButtonElement>('.dungeon-edit-btn')!.click();
  const modal = document.body.querySelector<HTMLElement>('.admin-modal')!;
  applySelectedAttributes(modal);
  return modal;
}

function floorEl(modal: HTMLElement, index: number): HTMLElement {
  return modal.querySelectorAll<HTMLElement>('.df-floor')[index];
}

function setInput(root: HTMLElement, selector: string, value: string): void {
  root.querySelector<HTMLInputElement>(selector)!.value = value;
}

async function save(modal: HTMLElement): Promise<void> {
  modal.querySelector<HTMLButtonElement>('#df-save')!.click();
  await flush();
}

describe('DungeonsTab', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('confirm', vi.fn(() => true));
  });

  afterEach(() => {
    closeAllModals();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('saving an unchanged dungeon preserves every field, including ones the form does not render', async () => {
    const put = stubPut();
    new DungeonsTab().render(container, makeCtx());
    await save(openEdit(container));

    expect(alert).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(put.bodies).toEqual([JSON.parse(JSON.stringify(DUNGEON))]);
  });

  it('notes checkpoint floors in the table', () => {
    new DungeonsTab().render(container, makeCtx());
    expect(container.querySelector('tbody tr td:nth-child(2)')!.textContent).toContain('checkpoints on 1');
  });

  it('renders the checkpoint fields with defaults as placeholders', () => {
    new DungeonsTab().render(container, makeCtx());
    const modal = openEdit(container);
    const first = floorEl(modal, 0);
    expect(first.querySelector<HTMLInputElement>('.df-floor-checkpoints')!.value).toBe('');
    expect(first.querySelector<HTMLInputElement>('.df-floor-max-wipes')!.placeholder).toBe('3 (default)');
    expect(first.querySelector<HTMLInputElement>('.df-floor-checkpoint-reward')!.placeholder).toBe('0.15 (default)');
    const boss = floorEl(modal, 1);
    expect(boss.querySelector<HTMLInputElement>('.df-floor-checkpoints')!.value).toBe('0.66, 0.33');
    expect(boss.querySelector<HTMLInputElement>('.df-floor-max-wipes')!.value).toBe('2');
  });

  it('saves edited checkpoints and removes cleared ones', async () => {
    const put = stubPut();
    new DungeonsTab().render(container, makeCtx());
    const modal = openEdit(container);
    const boss = floorEl(modal, 1);
    setInput(boss, '.df-floor-checkpoints', ' 0.8, 0.6 ,0.4, 0.2 ');
    setInput(boss, '.df-floor-max-wipes', '');
    setInput(boss, '.df-floor-checkpoint-reward', '0');
    await save(modal);

    const floors = put.bodies[0].floors as Record<string, unknown>[];
    expect(floors[1].checkpoints).toEqual([0.8, 0.6, 0.4, 0.2]);
    expect('maxWipes' in floors[1]).toBe(false);
    expect(floors[1].checkpointRewardFraction).toBe(0);

    closeAllModals();
    const again = openEdit(container);
    setInput(floorEl(again, 1), '.df-floor-checkpoints', '');
    await save(again);
    expect('checkpoints' in (put.bodies[1].floors as Record<string, unknown>[])[1]).toBe(false);
  });

  it.each([
    ['.df-floor-checkpoints', '0.33, 0.66'],
    ['.df-floor-checkpoints', '1, 0.5'],
    ['.df-floor-checkpoints', 'half'],
    ['.df-floor-max-wipes', '1.5'],
    ['.df-floor-max-wipes', '21'],
    ['.df-floor-checkpoint-reward', '1.5'],
  ])('rejects %s = %s', async (selector, value) => {
    const put = stubPut();
    new DungeonsTab().render(container, makeCtx());
    const modal = openEdit(container);
    setInput(floorEl(modal, 1), selector, value);
    await save(modal);
    expect(put.bodies).toHaveLength(0);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(alert).mock.calls[0][0]).toContain('Floor 2');
  });

  it('asks before saving checkpoints on a floor without a boss encounter', async () => {
    const put = stubPut();
    vi.stubGlobal('confirm', vi.fn(() => false));
    new DungeonsTab().render(container, makeCtx());
    const modal = openEdit(container);
    setInput(floorEl(modal, 0), '.df-floor-checkpoints', '0.5');
    await save(modal);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain('Floor 1');
    expect(put.bodies).toHaveLength(0);
  });

  it('gives a floor added after a removal its own encounter list', async () => {
    const put = stubPut();
    new DungeonsTab().render(container, makeCtx());
    const modal = openEdit(container);
    floorEl(modal, 0).querySelector<HTMLButtonElement>('.df-floor-remove')!.click();
    modal.querySelector<HTMLButtonElement>('#df-add-floor')!.click();
    const added = floorEl(modal, 1);
    expect(added.dataset.floorIndex).not.toBe(floorEl(modal, 0).dataset.floorIndex);
    added.querySelector<HTMLButtonElement>('.df-floor-add-enc')!.click();
    expect(added.querySelectorAll('.df-enc-row')).toHaveLength(1);
    expect(floorEl(modal, 0).querySelectorAll('.df-enc-row')).toHaveLength(1);
    await save(modal);
    const floors = put.bodies[0].floors as Record<string, unknown>[];
    expect(floors).toHaveLength(2);
    expect(floors[0].checkpoints).toEqual([0.66, 0.33]);
    expect('futureFloorField' in floors[1]).toBe(false);
  });
});
