import { describe, it, expect } from 'vitest';
import { resolveNotificationNavigation, NOTIFICATION_EVENT_REGISTRY } from '../src/systems/NotificationTypes';
import type { NotificationEntry } from '../src/systems/NotificationTypes';

function entryFor(eventKey: string, payload?: Record<string, unknown>): Pick<NotificationEntry, 'category' | 'eventKey' | 'payload'> {
  const def = NOTIFICATION_EVENT_REGISTRY.find(d => d.eventKey === eventKey)!;
  return { category: def.category, eventKey, payload };
}

describe('resolveNotificationNavigation', () => {
  it('routes every party-category event to the party target', () => {
    const partyEvents = NOTIFICATION_EVENT_REGISTRY.filter(d => d.category === 'party').map(d => d.eventKey);
    expect(partyEvents.length).toBeGreaterThan(1); // sanity: more than just the invite event exists
    for (const eventKey of partyEvents) {
      expect(resolveNotificationNavigation(entryFor(eventKey))).toEqual({ kind: 'party' });
    }
  });

  it('routes a new friend request to the friend_requests target', () => {
    expect(resolveNotificationNavigation(entryFor('friend_request_received'))).toEqual({ kind: 'friend_requests' });
  });

  it('routes a DM to a dm_reply target addressed to the sender', () => {
    expect(resolveNotificationNavigation(entryFor('dm_received', { fromUsername: 'alice' })))
      .toEqual({ kind: 'dm_reply', username: 'alice' });
  });

  it('falls back to none when a DM payload is missing/malformed fromUsername', () => {
    expect(resolveNotificationNavigation(entryFor('dm_received'))).toEqual({ kind: 'none' });
    expect(resolveNotificationNavigation(entryFor('dm_received', { fromUsername: 42 }))).toEqual({ kind: 'none' });
  });

  it('friend_request_accepted (informational, already resolved) is a no-op', () => {
    expect(resolveNotificationNavigation(entryFor('friend_request_accepted'))).toEqual({ kind: 'none' });
  });

  it('an unknown eventKey/category falls back to none', () => {
    expect(resolveNotificationNavigation({ category: 'system', eventKey: 'nonexistent_event' })).toEqual({ kind: 'none' });
  });
});
