import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { dismissTop } from '../src/ui/ModalStack';
import type { GameClient } from '../src/network/GameClient';


function fakeClient(opts: { pct?: number; role?: 'owner' | 'leader' | 'member'; policy?: number } = {}) {
  return {
    lastState: {
      username: 'me',
      character: opts.pct === undefined ? { level: 3 } : { level: 3, combatPrefs: { autoRetreatBelowPct: opts.pct } },
      social: {
        party: {
          members: [{ username: 'me', role: opts.role ?? 'owner' }, { username: 'boss', role: 'owner' }],
          ...(opts.policy !== undefined ? { autoRetreat: { belowPct: opts.policy, setBy: 'boss' } } : {}),
        },
      },
    },
    sendSetCombatPrefs: vi.fn(),
    listeners: [] as (() => void)[],
    subscribe(cb: () => void) {
      this.listeners.push(cb);
      return () => { this.listeners = this.listeners.filter(l => l !== cb); };
    },
  };
}

function open(client: ReturnType<typeof fakeClient>): HTMLElement {
  const container = document.createElement('div');
  container.id = 'screen-settings';
  document.body.appendChild(container);
  const screen = new SettingsScreen('screen-settings', client as unknown as GameClient);
  screen.openPlayerOptions();
  return document.querySelector('.player-options-overlay') as HTMLElement;
}

function pressed(overlay: HTMLElement): string[] {
  return [...overlay.querySelectorAll<HTMLButtonElement>('.settings-seg-btn[aria-checked="true"]')].map(b => b.dataset.retreat!);
}

describe('Player Options auto-retreat', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('offers Off / 25 / 40 / 60 and defaults to 25', () => {
    const overlay = open(fakeClient());
    const buttons = [...overlay.querySelectorAll<HTMLButtonElement>('.settings-seg-btn')];
    expect(buttons.map(b => b.textContent)).toEqual(['Off', '25 %', '40 %', '60 %']);
    expect(pressed(overlay)).toEqual(['25']);
  });

  it('shows the saved setting and sends changes without waiting for the server', () => {
    const client = fakeClient({ pct: 60 });
    const overlay = open(client);
    expect(pressed(overlay)).toEqual(['60']);
    (overlay.querySelector('.settings-seg-btn[data-retreat="0"]') as HTMLButtonElement).click();
    expect(client.sendSetCombatPrefs).toHaveBeenCalledWith(0);
    expect(pressed(overlay)).toEqual(['0']);
  });

  it('moves the choice with the arrow keys and ignores re-selecting the current value', () => {
    const client = fakeClient({ pct: 25 });
    const overlay = open(client);
    const group = overlay.querySelector('.settings-segmented') as HTMLElement;
    (overlay.querySelector('.settings-seg-btn[data-retreat="25"]') as HTMLButtonElement).click();
    expect(client.sendSetCombatPrefs).not.toHaveBeenCalled();
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(pressed(overlay)).toEqual(['40']);
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(pressed(overlay)).toEqual(['0']);
    expect(client.sendSetCombatPrefs.mock.calls.map(c => c[0])).toEqual([40, 25, 0]);
    const tabbable = [...overlay.querySelectorAll<HTMLButtonElement>('.settings-seg-btn')].filter(b => b.tabIndex === 0);
    expect(tabbable.map(b => b.dataset.retreat)).toEqual(['0']);
  });

  it('tells non-owners that the party owner decides', () => {
    const overlay = open(fakeClient({ role: 'member', policy: 40 }));
    expect(overlay.querySelector('.settings-option-note')!.textContent).toBe('Your party owner\'s setting is used (below 40 %).');
    document.body.innerHTML = '';
    const owner = open(fakeClient({ role: 'owner' }));
    expect(owner.querySelector('.settings-option-note')).toBeNull();
  });

  it('keeps the owner note current while the window is open and stops listening once closed', () => {
    const client = fakeClient({ role: 'member', policy: 40 });
    const overlay = open(client);
    const party = client.lastState.social.party as { members: { username: string; role: string }[]; autoRetreat?: { belowPct: number; setBy: string } };
    party.autoRetreat = { belowPct: 60, setBy: 'boss' };
    client.listeners.forEach(l => l());
    expect(overlay.querySelector('.settings-option-note')!.textContent).toBe('Your party owner\'s setting is used (below 60 %).');
    party.members[0].role = 'owner';
    client.listeners.forEach(l => l());
    expect(overlay.querySelector('.settings-option-note')).toBeNull();
    (overlay.querySelector('.player-options-close') as HTMLButtonElement).click();
    expect(client.listeners).toHaveLength(0);
  });

  it('brings an already open Player Options to the front instead of opening a second one', () => {
    const client = fakeClient();
    const container = document.createElement('div');
    container.id = 'screen-settings';
    document.body.appendChild(container);
    const screen = new SettingsScreen('screen-settings', client as unknown as GameClient);
    screen.openPlayerOptions();
    const first = document.querySelector('.player-options-overlay') as HTMLElement;
    const z = parseInt(first.style.zIndex, 10);
    screen.openPlayerOptions();
    expect(document.querySelectorAll('.player-options-overlay')).toHaveLength(1);
    expect(parseInt(first.style.zIndex, 10)).toBeGreaterThan(z);
  });
});

describe('Settings list', () => {
  function mount(client: ReturnType<typeof fakeClient>): SettingsScreen {
    document.body.innerHTML = '<div id="screen-settings"></div>';
    return new SettingsScreen('screen-settings', client as unknown as GameClient);
  }

  const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();

  it('groups its rows and shows the current values', () => {
    const screen = mount(fakeClient({ pct: 40 }));
    screen.onActivate();
    expect([...document.querySelectorAll('.settings-group')].map(g => g.querySelectorAll('.settings-row').length)).toEqual([2, 1, 1]);
    expect(document.querySelector('#btn-player-options .ui-row-sub')!.textContent).toBe('Auto-retreat: below 40 %');
    expect(document.querySelector('#btn-sign-out .ui-row-sub')!.textContent).toBe('Signed in as me');
  });

  it('keeps row values current only while the screen is active', () => {
    const client = fakeClient({ pct: 40 });
    const screen = mount(client);
    screen.onActivate();
    client.lastState.character = { level: 3, combatPrefs: { autoRetreatBelowPct: 0 } };
    client.listeners.forEach(l => l());
    expect(document.querySelector('#btn-player-options .ui-row-sub')!.textContent).toBe('Auto-retreat: off');
    screen.onDeactivate();
    expect(client.listeners).toHaveLength(0);
  });

  it('builds patch notes only when opened, and closes them with Back', async () => {
    mount(fakeClient());
    expect(document.querySelector('.patch-note-entry')).toBeNull();
    click('#btn-patch-notes');
    click('#btn-patch-notes');
    await vi.waitFor(() => expect(document.querySelector('.patch-notes-modal .patch-note-entry')).not.toBeNull());
    click('#btn-patch-notes');
    expect(document.querySelectorAll('.patch-notes-modal')).toHaveLength(1);
    expect(dismissTop()).toBe(true);
    expect(document.querySelector('.patch-notes-modal')).toBeNull();
  });

  it('closes every sheet it opened when leaving the screen', async () => {
    const screen = mount(fakeClient());
    click('#btn-patch-notes');
    await vi.waitFor(() => expect(document.querySelector('.patch-notes-modal')).not.toBeNull());
    screen.openPlayerOptions();
    expect(document.querySelectorAll('.player-options-overlay')).toHaveLength(2);
    screen.onDeactivate();
    expect(document.querySelectorAll('.player-options-overlay')).toHaveLength(0);
  });
});
