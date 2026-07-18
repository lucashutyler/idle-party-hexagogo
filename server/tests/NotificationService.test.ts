import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../src/game/social/NotificationService.js';
import type { NotificationChannelDriver, NotificationDeliveryContext } from '../src/game/social/NotificationService.js';
import type { NotificationChannel, NotificationPreferences } from '@idle-party-rpg/shared';
import { emptyNotificationPreferences } from '@idle-party-rpg/shared';

function makeDriver(channel: NotificationChannel) {
  const deliver = vi.fn((_ctx: NotificationDeliveryContext) => {});
  const driver: NotificationChannelDriver = { channel, deliver };
  return { driver, deliver };
}

describe('NotificationService', () => {
  let prefsByUser: Map<string, NotificationPreferences>;
  let inApp: ReturnType<typeof makeDriver>;
  let push: ReturnType<typeof makeDriver>;
  let email: ReturnType<typeof makeDriver>;
  let service: NotificationService;

  beforeEach(() => {
    prefsByUser = new Map();
    inApp = makeDriver('in_app');
    push = makeDriver('browser_push');
    email = makeDriver('email');
    service = new NotificationService(
      (username) => prefsByUser.get(username),
      [inApp.driver, push.driver, email.driver],
    );
  });

  it('dispatches to the registry default channel (in_app) when the player has no preferences', () => {
    service.notify('alice', 'party_invite_received', { title: 'Party invite', body: 'bob invited you' });
    expect(inApp.deliver).toHaveBeenCalledTimes(1);
    expect(push.deliver).not.toHaveBeenCalled();
    expect(email.deliver).not.toHaveBeenCalled();

    const ctx = inApp.deliver.mock.calls[0][0] as NotificationDeliveryContext;
    expect(ctx.username).toBe('alice');
    expect(ctx.entry.category).toBe('party');
    expect(ctx.entry.eventKey).toBe('party_invite_received');
    expect(ctx.entry.title).toBe('Party invite');
    expect(ctx.entry.readAt).toBeNull();
  });

  it('does not dispatch anything for an event whose default is off and no override is set', () => {
    service.notify('alice', 'party_member_joined', { title: 'Party', body: 'bob joined' });
    expect(inApp.deliver).not.toHaveBeenCalled();
    expect(push.deliver).not.toHaveBeenCalled();
    expect(email.deliver).not.toHaveBeenCalled();
  });

  it('respects a per-event channel override enabling multiple channels', () => {
    const prefs = emptyNotificationPreferences();
    prefs.events['party_invite_received'] = ['in_app', 'browser_push', 'email'];
    prefsByUser.set('alice', prefs);

    service.notify('alice', 'party_invite_received', { title: 'Party invite', body: 'bob invited you' });
    expect(inApp.deliver).toHaveBeenCalledTimes(1);
    expect(push.deliver).toHaveBeenCalledTimes(1);
    expect(email.deliver).toHaveBeenCalledTimes(1);
  });

  it('a master channelDisabled kill switch suppresses that channel even if the event enables it', () => {
    const prefs = emptyNotificationPreferences();
    prefs.events['party_invite_received'] = ['in_app', 'browser_push'];
    prefs.channelDisabled['browser_push'] = true;
    prefsByUser.set('alice', prefs);

    service.notify('alice', 'party_invite_received', { title: 'Party invite', body: 'bob invited you' });
    expect(inApp.deliver).toHaveBeenCalledTimes(1);
    expect(push.deliver).not.toHaveBeenCalled();
  });

  it('silently drops unknown event keys', () => {
    service.notify('alice', 'not_a_real_event', { title: 'x', body: 'y' });
    expect(inApp.deliver).not.toHaveBeenCalled();
  });

  it('an event opted out entirely (empty channel list override) dispatches nowhere', () => {
    const prefs = emptyNotificationPreferences();
    prefs.events['party_invite_received'] = [];
    prefsByUser.set('alice', prefs);

    service.notify('alice', 'party_invite_received', { title: 'Party invite', body: 'bob invited you' });
    expect(inApp.deliver).not.toHaveBeenCalled();
  });

  it('a driver throwing does not prevent other drivers from being called', () => {
    const prefs = emptyNotificationPreferences();
    prefs.events['party_invite_received'] = ['in_app', 'browser_push'];
    prefsByUser.set('alice', prefs);
    inApp.deliver.mockImplementation(() => { throw new Error('boom'); });

    expect(() => service.notify('alice', 'party_invite_received', { title: 'x', body: 'y' })).not.toThrow();
    expect(push.deliver).toHaveBeenCalledTimes(1);
  });
});
