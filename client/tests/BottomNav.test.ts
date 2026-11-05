import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { BottomNav, readyQuestCount } from '../src/ui/BottomNav';
import { UtilityStrip } from '../src/ui/UtilityStrip';
import type { GameClient } from '../src/network/GameClient';

type StateListener = (state: ServerStateMessage) => void;

function setup() {
  document.body.innerHTML = '<div id="utility-strip"></div><nav id="bottom-nav"></nav>';
  const listeners = new Set<StateListener>();
  const gameClient = {
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
  } as unknown as GameClient;
  const push = (parts: Record<string, unknown> = {}) => {
    const state = {
      username: 'me',
      battle: { visual: 'none' },
      party: { path: [] },
      activeQuests: [],
      ...parts,
    } as unknown as ServerStateMessage;
    for (const l of listeners) l(state);
  };
  const onSelect = vi.fn();
  const nav = new BottomNav(
    [
      { id: 'map', label: 'Map', glyph: 'M' },
      { id: 'combat', label: 'Battle', glyph: 'B' },
      { id: 'social', label: 'Social', glyph: 'S' },
      { id: 'items', label: 'Hero', glyph: 'H' },
      { id: 'quests', label: 'Quests', glyph: 'Q', railOnly: true },
      { id: 'chat', label: 'Chat', glyph: 'C', railOnly: true },
    ],
    'combat',
    onSelect,
    gameClient,
  );
  const tab = (id: string) => document.querySelector(`.nav-tab[data-screen="${id}"]`) as HTMLButtonElement;
  const badge = (id: string) => tab(id).querySelector('.nav-badge') as HTMLElement;
  return { nav, gameClient, push, onSelect, tab, badge };
}

describe('BottomNav', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('includes badges in the accessible tab names', () => {
    const t = setup();
    t.nav.setChatUnread(5);
    expect(t.tab('chat').getAttribute('aria-label')).toBe('Chat, 5 unread');
    t.nav.setChatUnread(0);
    expect(t.tab('chat').getAttribute('aria-label')).toBe('Chat');

    t.push({ activeQuests: [{ status: 'ready' }] });
    expect(t.tab('quests').getAttribute('aria-label')).toBe('Quests, 1 ready');

    t.push({ social: { incomingFriendRequests: [{}], pendingInvites: [] } });
    expect(t.tab('social').getAttribute('aria-label')).toBe('Social, needs attention');
    t.push({ social: { incomingFriendRequests: [], pendingInvites: [] } });
    expect(t.tab('social').getAttribute('aria-label')).toBe('Social');
  });

  it('labels every tab and marks only rail destinations as rail-only', () => {
    const t = setup();
    expect(t.tab('map').querySelector('.nav-label')?.textContent).toBe('Map');
    expect(t.tab('map').getAttribute('aria-label')).toBe('Map');
    expect(t.tab('map').hasAttribute('data-rail-only')).toBe(false);
    expect(t.tab('quests').hasAttribute('data-rail-only')).toBe(true);
  });

  it('keeps the glyph under the art so a missing icon still shows', () => {
    const t = setup();
    const icon = t.tab('map').querySelector('.nav-icon')!;
    expect(icon.querySelector('.nav-icon-glyph')?.textContent).toBe('M');
    expect(icon.querySelector('img.nav-icon-img')?.getAttribute('src')).toBe('/nav-icons/map.png');
  });

  it('reports a re-tap of the current tab', () => {
    const t = setup();
    t.tab('map').click();
    expect(t.onSelect).toHaveBeenLastCalledWith('map', false);
    t.nav.setActive('map');
    t.tab('map').click();
    expect(t.onSelect).toHaveBeenLastCalledWith('map', true);
  });

  it('moves the active state and aria-current', () => {
    const t = setup();
    expect(t.tab('combat').getAttribute('aria-current')).toBe('page');
    t.nav.setActive('map');
    expect(t.tab('combat').classList.contains('active')).toBe(false);
    expect(t.tab('combat').hasAttribute('aria-current')).toBe(false);
    expect(t.tab('map').getAttribute('aria-current')).toBe('page');
  });

  it('shows the fighting ring and flashes only on a fight ending', () => {
    const t = setup();
    t.push({ battle: { visual: 'fighting' } });
    expect(t.tab('combat').classList.contains('fighting-pulse')).toBe(true);
    t.push({ battle: { visual: 'victory' } });
    expect(t.tab('combat').classList.contains('fighting-pulse')).toBe(false);
    expect(t.tab('combat').classList.contains('victory-flash')).toBe(true);
    t.push({ battle: { visual: 'victory' } });
    expect(t.tab('combat').classList.contains('victory-flash')).toBe(false);
    t.push({ battle: { visual: 'fighting' } });
    t.push({ battle: { visual: 'defeat' } });
    expect(t.tab('combat').classList.contains('defeat-flash')).toBe(true);
  });

  it('marks the Map tab while the party walks', () => {
    const t = setup();
    t.push({ party: { path: [{ col: 1, row: 0 }] } });
    expect(t.tab('map').classList.contains('has-path')).toBe(true);
    t.push({ party: { path: [] } });
    expect(t.tab('map').classList.contains('has-path')).toBe(false);
  });

  it('badges Social for invites and requests, Hero for mail and trades awaiting me', () => {
    const t = setup();
    t.push({ social: { incomingFriendRequests: [{}] } });
    expect(t.badge('social').classList.contains('visible')).toBe(true);
    t.push({ social: { proposedTrades: [{ lastUpdatedBy: 'me' }] } });
    expect(t.badge('social').classList.contains('visible')).toBe(false);
    expect(t.badge('items').classList.contains('visible')).toBe(false);
    t.push({ social: { proposedTrades: [{ lastUpdatedBy: 'them' }] } });
    expect(t.badge('items').classList.contains('visible')).toBe(true);
    t.push({ social: { mailbox: [{}] } });
    expect(t.badge('items').classList.contains('visible')).toBe(true);
  });

  it('shows chat and ready-quest counts on the rail', () => {
    const t = setup();
    t.nav.setChatUnread(3);
    expect(t.badge('chat').textContent).toBe('3');
    expect(t.badge('chat').classList.contains('visible')).toBe(true);
    t.nav.setChatUnread(120);
    expect(t.badge('chat').textContent).toBe('99+');
    t.nav.setChatUnread(0);
    expect(t.badge('chat').classList.contains('visible')).toBe(false);

    t.push({ activeQuests: [{ status: 'ready' }, { status: 'active' }, { status: 'ready' }] });
    expect(t.badge('quests').textContent).toBe('2');
  });

  it('counts only quests ready to turn in', () => {
    expect(readyQuestCount(undefined)).toBe(0);
    expect(readyQuestCount([{ status: 'accepted' }, { status: 'ready' }])).toBe(1);
  });
});

describe('UtilityStrip', () => {
  it('offers a chat slot and a Quests button with the ready count', () => {
    const t = setup();
    const actions = { onOpenChat: vi.fn(), onOpenQuests: vi.fn() };
    const strip = new UtilityStrip(t.gameClient, actions);

    expect(document.querySelector('#utility-strip #chat-strip-slot')).not.toBeNull();
    (document.querySelector('.utility-quests') as HTMLElement).click();
    expect(actions.onOpenQuests).toHaveBeenCalledOnce();
    (document.querySelector('.chat-strip-open') as HTMLElement).click();
    expect(actions.onOpenChat).toHaveBeenCalledOnce();

    t.push({ activeQuests: [{ status: 'ready' }] });
    const badge = document.querySelector('.utility-quests-badge') as HTMLElement;
    expect(badge.textContent).toBe('1');
    expect(badge.classList.contains('visible')).toBe(true);

    strip.setChatUnread(5);
    expect(document.querySelector('.chat-strip-open-count')?.textContent).toBe('5');

    expect(document.querySelector('.utility-quests')?.getAttribute('aria-label')).toBe('Quests, 1 ready');
    expect(document.querySelector('.chat-strip-open')?.getAttribute('aria-label')).toBe('Open chat, 5 unread');
    strip.setChatUnread(0);
    expect(document.querySelector('.chat-strip-open')?.getAttribute('aria-label')).toBe('Open chat');
  });
});
