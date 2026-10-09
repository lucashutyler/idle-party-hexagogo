import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomStatusPanel } from '../src/ui/RoomStatusPanel';
import type { RoomStatus } from '../src/ui/RoomStatusPanel';
import type { RoomAction } from '../src/ui/RoomActions';

const TALK: RoomAction = { kind: 'npc', icon: '🧙', name: 'Mira', targetId: 'mira' };
const SHOP: RoomAction = { kind: 'shop', icon: '🪙', name: 'General Store', targetId: 'store' };

function makeStatus(overrides: Partial<RoomStatus> = {}): RoomStatus {
  return {
    zoneName: 'Hatchetmill',
    roomName: 'Town Square',
    actions: [TALK, SHOP],
    othersHere: 0,
    ...overrides,
  };
}

describe('RoomStatusPanel', () => {
  let parent: HTMLElement;
  let panel: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
  });

  function mount(onAction = vi.fn(), onShowPlayers = vi.fn()): RoomStatusPanel {
    const status = new RoomStatusPanel(parent, onAction, onShowPlayers);
    panel = parent.querySelector('.room-status') as HTMLElement;
    return status;
  }

  function chips(): HTMLElement[] {
    return [...panel.querySelectorAll<HTMLElement>('.room-status-chip')];
  }

  it('starts hidden', () => {
    mount();
    expect(panel.style.display).toBe('none');
  });

  it('renders the room header and one labelled chip per action', () => {
    const status = mount();
    status.update(makeStatus());

    expect(panel.style.display).toBe('');
    expect(panel.dataset.empty).toBe('0');
    expect(panel.querySelector('.room-status-header')?.textContent).toBe('Hatchetmill · Town Square');
    expect(chips().map(c => c.getAttribute('aria-label'))).toEqual(['Talk to Mira', 'General Store']);
    expect(chips().map(c => c.querySelector('.room-status-chip-icon')?.textContent)).toEqual(['🧙', '🪙']);
  });

  it('adds a player-count chip and a dungeon floor status', () => {
    const status = mount();
    status.update(makeStatus({
      actions: [],
      othersHere: 3,
      dungeonRun: { name: 'Crystal Caves', floor: 2, totalFloors: 3 },
    }));

    expect(chips().map(c => c.getAttribute('aria-label'))).toEqual(['3 players here', 'Crystal Caves · Floor 2/3']);
    expect(chips().map(c => c.querySelector('.room-status-chip-badge')?.textContent)).toEqual(['3', '2/3']);
    expect(chips()[1].tagName).toBe('DIV');
  });

  it('marks a quest-ready npc chip and mentions it in the label', () => {
    const status = mount();
    status.update(makeStatus({ actions: [{ ...TALK, detail: 'Quest ready to turn in', questReady: true }] }));

    expect(chips()[0].getAttribute('aria-label')).toBe('Talk to Mira · Quest ready to turn in');
    expect(chips()[0].querySelector('.quest-ready-pip')).toBeTruthy();
  });

  it('marks an npc chip with a new quest with the green pip', () => {
    const status = mount();
    status.update(makeStatus({ actions: [{ ...TALK, detail: 'New quest available', questAvailable: true }] }));

    expect(chips()[0].getAttribute('aria-label')).toBe('Talk to Mira · New quest available');
    expect(chips()[0].querySelector('.quest-available-pip')).toBeTruthy();
    expect(chips()[0].querySelector('.quest-ready-pip')).toBeNull();
  });

  it('holds a repaint while a chip is pressed, so the tap still lands', () => {
    vi.useFakeTimers();
    try {
      const onAction = vi.fn();
      const status = mount(onAction);
      status.update(makeStatus());
      const pressed = chips()[1];

      pressed.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      status.update(makeStatus({ othersHere: 2 }));
      expect(chips()[1]).toBe(pressed);
      expect(pressed.isConnected).toBe(true);

      pressed.click();
      expect(onAction).toHaveBeenCalledWith(SHOP);
      vi.advanceTimersByTime(0);
      expect(chips()[1]).not.toBe(pressed);
      expect(chips().map(c => c.getAttribute('aria-label'))).toContain('2 players here');
    } finally {
      document.dispatchEvent(new PointerEvent('pointercancel'));
      vi.useRealTimers();
    }
  });

  it('flags itself empty when the room offers nothing', () => {
    const status = mount();
    status.update(makeStatus({ actions: [] }));
    expect(panel.dataset.empty).toBe('1');
    expect(chips()).toHaveLength(0);
  });

  it('hides when there is no room to describe', () => {
    const status = mount();
    status.update(makeStatus());
    status.update(null);
    expect(panel.style.display).toBe('none');
    expect(chips()).toHaveLength(0);
  });

  it('runs the matching handler when a chip is tapped', () => {
    const onAction = vi.fn();
    const onShowPlayers = vi.fn();
    const status = mount(onAction, onShowPlayers);
    status.update(makeStatus({ othersHere: 1 }));

    chips()[1].click();
    expect(onAction).toHaveBeenCalledWith(SHOP);
    chips()[2].click();
    expect(onShowPlayers).toHaveBeenCalledTimes(1);
  });

  it('does not let taps reach the map underneath', () => {
    const status = mount();
    status.update(makeStatus());
    const parentHandler = vi.fn();
    parent.addEventListener('mousedown', parentHandler);
    parent.addEventListener('click', parentHandler);

    chips()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    chips()[0].click();
    expect(parentHandler).not.toHaveBeenCalled();
  });

  it('keeps the same DOM when the content has not changed', () => {
    const status = mount();
    status.update(makeStatus());
    const before = chips()[0];

    status.update(makeStatus());
    expect(chips()[0]).toBe(before);

    status.update(makeStatus({ othersHere: 2 }));
    expect(chips()[0]).not.toBe(before);
  });
});
