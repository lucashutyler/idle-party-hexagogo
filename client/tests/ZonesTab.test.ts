import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZoneDefinition } from '@idle-party-rpg/shared';
import { ZonesTab } from '../src/admin/tabs/ZonesTab';
import type { AdminContext } from '../src/admin/AdminContext';
import type { ContentData } from '../src/admin/types';
import { closeAllModals } from '../src/admin/components/Modal';

const PLAIN: ZoneDefinition = { id: 'plain', displayName: 'Plain', levelRange: [1, 2], encounterTable: [] };
const STARTER: ZoneDefinition = { id: 'starter', displayName: 'Starter Isle', levelRange: [1, 2], encounterTable: [], starterZone: true };

function makeCtx(): AdminContext {
  const content = { zones: { plain: { ...PLAIN }, starter: { ...STARTER } }, encounters: {} } as unknown as ContentData;
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

describe('ZonesTab starter zone field', () => {
  let container: HTMLElement;
  let bodies: ZoneDefinition[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    bodies = [];
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({ zones: {} }) };
    }));
    new ZonesTab().render(container, makeCtx());
  });

  afterEach(() => {
    closeAllModals();
    container.remove();
    vi.unstubAllGlobals();
  });

  function open(id: string): HTMLElement {
    container.querySelector<HTMLButtonElement>(`.zone-edit-btn[data-id="${id}"]`)!.click();
    return document.body.querySelector<HTMLElement>('.admin-modal')!;
  }

  async function save(modal: HTMLElement): Promise<void> {
    modal.querySelector<HTMLButtonElement>('#zf-save')!.click();
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  it('marks a starter zone in the table', () => {
    const pill = (name: string) => [...container.querySelectorAll('tbody tr')]
      .find(r => r.textContent?.includes(name))!
      .querySelector('.admin-pill')?.textContent;
    expect(pill('Starter Isle')).toBe('Starter');
    expect(pill('Plain')).toBeUndefined();
  });

  it('keeps the field through an unchanged save', async () => {
    await save(open('starter'));
    expect(bodies[0].starterZone).toBe(true);
  });

  it('leaves the field out when it is off, and clears it when unchecked', async () => {
    await save(open('plain'));
    expect('starterZone' in bodies[0]).toBe(false);
    closeAllModals();

    const modal = open('starter');
    modal.querySelector<HTMLInputElement>('#zf-starter')!.checked = false;
    await save(modal);
    expect('starterZone' in bodies[1]).toBe(false);
  });

  it('sets the field when checked', async () => {
    const modal = open('plain');
    modal.querySelector<HTMLInputElement>('#zf-starter')!.checked = true;
    await save(modal);
    expect(bodies[0].starterZone).toBe(true);
  });
});
