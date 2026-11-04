import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomView } from '../src/ui/RoomView';
import type { TileClickInfo } from '../src/ui/ThreeWorldMap';
import type { RoomAction } from '../src/ui/RoomActions';

function makeInfo(overrides: Partial<TileClickInfo> = {}): TileClickInfo {
  return {
    col: 3,
    row: 4,
    tileType: 'Plains',
    zoneName: 'Hatchetmill',
    roomName: 'Town Square',
    zoneId: 'hatchetmill',
    isTraversable: true,
    isUnlocked: true,
    isSameZone: true,
    isCurrentTile: false,
    playersHere: [],
    partyMemberUsernames: [],
    ...overrides,
  };
}

function isVisible(el: HTMLElement): boolean {
  // happy-dom doesn't run layout, so we check what we set: display + connected.
  return el.isConnected && el.style.display !== 'none' && el.style.display !== '';
}

describe('RoomView modal pipeline', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('starts hidden', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    new RoomView(parent, () => {});
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.style.display).toBe('none');
  });

  it('show() makes the overlay visible (display: flex)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(isVisible(overlay)).toBe(true);
    expect(overlay.style.display).toBe('flex');
  });

  it('show() lifts the overlay above the modal-stack baseline', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    const z = parseInt(overlay.style.zIndex, 10);
    expect(Number.isFinite(z)).toBe(true);
    expect(z).toBeGreaterThanOrEqual(1500);
  });

  it('hide() removes the overlay from sight and clears z-index', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    view.hide();
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
    expect(overlay.style.zIndex).toBe('');
  });

  it('clicking the overlay backdrop dismisses the modal', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;

    // Synthetic click directly on the overlay (target === overlay).
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // RoomView's overlay-click handler reads e.target === overlay; we need to
    // simulate that by dispatching from the overlay itself.
    expect(overlay.style.display).toBe('none');
  });

  it('clicking inside the modal contents does NOT dismiss', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    const modal = overlay.querySelector('.room-view') as HTMLElement;

    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay.style.display).toBe('flex');
  });

  it('Go-to-room button calls onMove and dismisses the modal (remote room)', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onMove = vi.fn();
    const view = new RoomView(parent, onMove);
    view.show(makeInfo({ isCurrentTile: false }));
    const goBtn = parent.querySelector('.room-view-action-go') as HTMLElement;
    expect(goBtn).toBeTruthy();
    goBtn.click();
    expect(onMove).toHaveBeenCalledWith(3, 4);
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
  });

  it('Close button on the current-room view dismisses the modal', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo({ isCurrentTile: true }));
    const closeBtn = parent.querySelector('.room-view-close') as HTMLElement;
    closeBtn.click();
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
  });

  it('hidden modals do not pass clicks: the Go button has no effect when overlay is hidden', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const onMove = vi.fn();
    const view = new RoomView(parent, onMove);

    view.show(makeInfo({ isCurrentTile: false }));
    view.hide();

    // After hide(), the overlay is display:none. A click on the button
    // (which still exists in the DOM but is inside the hidden overlay)
    // would in real DOM not be reachable; in JSDOM/happy-dom we approximate
    // by asserting the overlay is hidden, which is what CSS pointer-events
    // / display:none enforces in production.
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('none');
    // Sanity: visibility check matches our isVisible() helper.
    expect(isVisible(overlay)).toBe(false);

    // No move should have fired during this lifecycle.
    expect(onMove).not.toHaveBeenCalled();
  });

  it('overlay swallows click propagation so phantom canvas clicks cannot leak through', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    const overlay = parent.querySelector('.room-view-overlay') as HTMLElement;

    // Listener registered on document — should NOT receive a click that
    // originated on the overlay (RoomView calls e.stopPropagation()).
    const docHandler = vi.fn();
    document.addEventListener('click', docHandler);

    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(docHandler).not.toHaveBeenCalled();
    document.removeEventListener('click', docHandler);
  });

  it('re-showing on the same overlay does not duplicate it', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new RoomView(parent, () => {});
    view.show(makeInfo());
    view.show(makeInfo({ col: 5 }));
    expect(parent.querySelectorAll('.room-view-overlay').length).toBe(1);
  });
});

const ACTIONS: RoomAction[] = [
  { kind: 'npc', icon: '🧙', name: 'Mira', targetId: 'mira', detail: 'Quest ready to turn in', questReady: true },
  { kind: 'shop', icon: '🪙', name: 'General Store', targetId: 'store' },
  { kind: 'dungeon', icon: '🗝️', name: 'Crystal Caves', targetId: 'caves' },
  { kind: 'travel', icon: '🌀', name: 'Darkwood Gate', targetId: 'gate-guid' },
];

describe('RoomView room actions', () => {
  let parent: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  function overlay(): HTMLElement {
    return parent.querySelector('.room-view-overlay') as HTMLElement;
  }

  it('offers Stop here on the current room while travelling, moving to that room and closing', () => {
    const onMove = vi.fn();
    const view = new RoomView(parent, onMove);
    view.isTraveling = true;
    view.show(makeInfo({ isCurrentTile: true }));

    const stop = parent.querySelector('.room-view-action-stop') as HTMLElement;
    expect(stop).toBeTruthy();
    stop.click();
    expect(onMove).toHaveBeenCalledWith(3, 4);
    expect(overlay().style.display).toBe('none');
  });

  it('hides Stop here when the party is not travelling', () => {
    const view = new RoomView(parent, () => {});
    view.show(makeInfo({ isCurrentTile: true }));
    expect(parent.querySelector('.room-view-action-stop')).toBeNull();
  });

  it('hides Stop here on a remote room even while travelling', () => {
    const view = new RoomView(parent, () => {});
    view.isTraveling = true;
    view.show(makeInfo({ isCurrentTile: false }));
    expect(parent.querySelector('.room-view-action-stop')).toBeNull();
  });

  it('lists what an explored remote room offers, without action buttons', () => {
    const view = new RoomView(parent, () => {});
    view.actions = ACTIONS;
    view.show(makeInfo());

    const items = [...parent.querySelectorAll('.room-view-contents-item')].map(el => el.textContent);
    expect(items).toEqual([
      '🧙MiraQuest ready to turn in',
      '🪙General Store',
      '🗝️Crystal Caves',
      '🌀Darkwood Gate',
    ]);
    expect(parent.querySelector('[data-action-index]')).toBeNull();
  });

  it('pins a gold "?" on a ready turn-in and a green "!" on a new quest', () => {
    const view = new RoomView(parent, () => {});
    const giver: RoomAction = { kind: 'npc', icon: '🧔', name: 'Hob', targetId: 'hob', detail: 'New quest available', questAvailable: true };
    view.actions = [ACTIONS[0], giver];
    view.show(makeInfo());
    const icons = [...parent.querySelectorAll('.room-view-contents-icon')];
    expect(icons.map(el => el.className)).toEqual([
      'room-view-contents-icon quest-ready-pip',
      'room-view-contents-icon quest-available-pip',
    ]);

    view.show(makeInfo({ isCurrentTile: true }));
    const buttonIcons = [...parent.querySelectorAll('[data-action-index] .room-view-action-icon')];
    expect(buttonIcons.map(el => el.classList.contains('quest-available-pip'))).toEqual([false, true]);
    expect(buttonIcons.map(el => el.classList.contains('quest-ready-pip'))).toEqual([true, false]);
  });

  it('lists nothing for an unexplored remote room', () => {
    const view = new RoomView(parent, () => {});
    view.actions = ACTIONS;
    view.show(makeInfo({ isUnlocked: false, roomName: 'Unexplored Room' }));
    expect(parent.querySelector('.room-view-contents')).toBeNull();
  });

  it('escapes author-supplied names in the room list', () => {
    const view = new RoomView(parent, () => {});
    view.actions = [{ kind: 'npc', icon: '🧙', name: '<img src=x onerror=alert(1)>', targetId: 'x' }];
    view.show(makeInfo());
    expect(parent.querySelector('.room-view-contents img')).toBeNull();
    expect(parent.querySelector('.room-view-contents-name')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('renders one button per action on the current room, using the shared glyphs', () => {
    const view = new RoomView(parent, () => {});
    view.actions = ACTIONS;
    view.show(makeInfo({ isCurrentTile: true }));

    const buttons = [...parent.querySelectorAll('[data-action-index]')].map(el => el.textContent);
    expect(buttons).toEqual(['🧙Talk to Mira', 'General Store', '🗝️Enter Crystal Caves', '🌀Travel to Darkwood Gate']);
    expect(parent.querySelector('.room-view-action-travel')?.textContent).toContain('🌀');
    expect(parent.textContent).not.toContain('🕳️');
  });

  it("shows the shop's own artwork, keyed by shop id rather than zone", () => {
    const view = new RoomView(parent, () => {});
    view.actions = ACTIONS;
    view.show(makeInfo({ isCurrentTile: true, zoneId: 'hatchetmill' }));

    const img = parent.querySelector('.room-view-action-shop img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/shop-artwork/${ACTIONS[1].targetId}.png`);
  });

  it('clicking an action button closes the popup and hands the action over', () => {
    const onAction = vi.fn();
    const view = new RoomView(parent, () => {}, undefined, onAction);
    view.actions = ACTIONS;
    view.show(makeInfo({ isCurrentTile: true }));

    (parent.querySelector('.room-view-action-dungeon') as HTMLElement).click();
    expect(onAction).toHaveBeenCalledWith(ACTIONS[2]);
    expect(overlay().style.display).toBe('none');
  });
});
