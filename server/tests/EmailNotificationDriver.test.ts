import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEntry } from '@idle-party-rpg/shared';
import { EmailNotificationDriver } from '../src/game/social/EmailNotificationDriver.js';

const sendNotificationEmail = vi.hoisted(() => vi.fn<(email: string, title: string, body: string) => Promise<void>>());
vi.mock('../src/auth/EmailService.js', () => ({ sendNotificationEmail }));

const EMAIL = 'bob@example.test';

function entry(eventKey: string, title: string, body: string): NotificationEntry {
  return {
    id: 'n1',
    category: eventKey === 'dm_received' ? 'dm' : 'party',
    eventKey,
    title,
    body,
    createdAt: 0,
    readAt: null,
  };
}

describe('EmailNotificationDriver', () => {
  const driver = new EmailNotificationDriver(username => (username === 'bob' ? EMAIL : null));

  beforeEach(() => {
    sendNotificationEmail.mockReset();
    sendNotificationEmail.mockResolvedValue(undefined);
  });

  it('leaves a direct message out of the email', async () => {
    await driver.deliver({ username: 'bob', entry: entry('dm_received', 'Message from alice', 'meet me at <b>the docks</b>') });

    expect(sendNotificationEmail).toHaveBeenCalledWith(
      EMAIL,
      'Message from alice',
      'You have a new direct message. Open the game to read it.',
    );
  });

  it('sends other events with their own body', async () => {
    await driver.deliver({ username: 'bob', entry: entry('party_invite_received', 'Party invite', 'alice invited you to a party') });

    expect(sendNotificationEmail).toHaveBeenCalledWith(EMAIL, 'Party invite', 'alice invited you to a party');
  });

  it('sends nothing when the account has no email', async () => {
    await driver.deliver({ username: 'nobody', entry: entry('dm_received', 'Message from alice', 'hi') });

    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });
});
