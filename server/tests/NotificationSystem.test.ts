import { describe, it, expect, beforeEach } from 'vitest';
import { NotificationSystem } from '../src/game/social/NotificationSystem.js';
import type { NotificationEntry } from '@idle-party-rpg/shared';

function makeEntry(id: string, overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id,
    category: 'party',
    eventKey: 'party_invite_received',
    title: 'Party invite',
    body: 'someone invited you',
    createdAt: Date.now(),
    readAt: null,
    ...overrides,
  };
}

describe('NotificationSystem', () => {
  let system: NotificationSystem;

  beforeEach(() => {
    system = new NotificationSystem();
  });

  it('starts with an empty inbox', () => {
    expect(system.getInbox('alice')).toEqual([]);
    expect(system.unreadCount('alice')).toBe(0);
  });

  it('adds entries and tracks unread count', () => {
    system.addEntry('alice', makeEntry('n1'));
    system.addEntry('alice', makeEntry('n2'));
    expect(system.getInbox('alice')).toHaveLength(2);
    expect(system.unreadCount('alice')).toBe(2);
  });

  it('caps the inbox at 50 entries, evicting the oldest first', () => {
    for (let i = 0; i < 55; i++) {
      system.addEntry('alice', makeEntry(`n${i}`));
    }
    const inbox = system.getInbox('alice');
    expect(inbox).toHaveLength(50);
    expect(inbox[0].id).toBe('n5');
    expect(inbox[49].id).toBe('n54');
  });

  it('marks a single entry read', () => {
    system.addEntry('alice', makeEntry('n1'));
    expect(system.markRead('alice', 'n1')).toBe(true);
    expect(system.getInbox('alice')[0].readAt).not.toBeNull();
    expect(system.unreadCount('alice')).toBe(0);
  });

  it('marking an already-read entry read again returns false', () => {
    system.addEntry('alice', makeEntry('n1'));
    system.markRead('alice', 'n1');
    expect(system.markRead('alice', 'n1')).toBe(false);
  });

  it('marking an unknown id returns false', () => {
    expect(system.markRead('alice', 'nope')).toBe(false);
  });

  it('marks all entries read', () => {
    system.addEntry('alice', makeEntry('n1'));
    system.addEntry('alice', makeEntry('n2'));
    system.markAllRead('alice');
    expect(system.unreadCount('alice')).toBe(0);
  });

  it('setInbox restores from save data, capped to 50', () => {
    const entries = Array.from({ length: 60 }, (_, i) => makeEntry(`n${i}`));
    system.setInbox('alice', entries);
    expect(system.getInbox('alice')).toHaveLength(50);
  });

  it('setInbox with an empty array clears the inbox', () => {
    system.addEntry('alice', makeEntry('n1'));
    system.setInbox('alice', []);
    expect(system.getInbox('alice')).toEqual([]);
    expect(system.getAllUsernames()).not.toContain('alice');
  });

  it('keeps separate inboxes per player', () => {
    system.addEntry('alice', makeEntry('n1'));
    system.addEntry('bob', makeEntry('n2'));
    expect(system.getInbox('alice')).toHaveLength(1);
    expect(system.getInbox('bob')).toHaveLength(1);
    expect(system.getAllUsernames().sort()).toEqual(['alice', 'bob']);
  });
});
