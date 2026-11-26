import { describe, expect, it } from 'vitest';
import { CLIENT_CHAT_CAPS } from '@idle-party-rpg/shared';
import type { ChatChannelType, ChatMessage, ServerStateMessage } from '@idle-party-rpg/shared';
import {
  buildDmThreads,
  canonicalUsername,
  CHAT_ROW_CAP,
  ChatLog,
  chatMembership,
  chatPreview,
  DEFAULT_CHAT_FILTERS,
  dmPartner,
  escapeChatHtml,
  isChatMention,
  isShownInView,
  mentionsName,
  normalizeChatMessage,
  renderChatRow,
  renderChatRows,
  resolveSendTarget,
  sendableChannels,
} from '../src/ui/chatModel';
import type { ChatAudience } from '../src/ui/chatModel';

let nextId = 0;

function msg(over: Partial<ChatMessage> = {}): ChatMessage {
  nextId++;
  return {
    id: `m${nextId}`,
    channelType: 'global',
    channelId: '',
    senderUsername: 'bob',
    text: 'hello',
    timestamp: nextId,
    ...over,
  };
}

function audience(over: Partial<ChatAudience> = {}): ChatAudience {
  return { me: 'me', blocked: {}, filters: { ...DEFAULT_CHAT_FILTERS }, ...over };
}

function withFilterOff(channel: ChatChannelType): ChatAudience {
  return audience({ filters: { ...DEFAULT_CHAT_FILTERS, [channel]: false } });
}

function state(over: Record<string, unknown> = {}): ServerStateMessage {
  return {
    username: 'me',
    currentMapId: 'map1',
    party: { col: 3, row: 4 },
    social: { allPlayers: [{ username: 'Mira' }], guild: null, party: null },
    ...over,
  } as unknown as ServerStateMessage;
}

describe('escapeChatHtml', () => {
  it('escapes everything that could close an attribute', () => {
    expect(escapeChatHtml(`<a href="x" title='y'>&`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;');
  });

  it('accepts non-strings', () => {
    expect(escapeChatHtml(42)).toBe('42');
    expect(escapeChatHtml(undefined)).toBe('');
  });
});

describe('normalizeChatMessage', () => {
  it('coerces a non-string channelId so rendering cannot throw', () => {
    const raw = msg({ channelId: 42 as unknown as string });
    expect(normalizeChatMessage(raw).channelId).toBe('42');
  });
});

describe('ChatLog', () => {
  it('dedupes by id', () => {
    const log = new ChatLog();
    const m = msg();
    log.add([m]);
    expect(log.add([m]).added).toEqual([]);
    expect(log.messages).toHaveLength(1);
  });

  it('merges older messages into place and reports them out of order', () => {
    const log = new ChatLog();
    log.add([msg({ id: 'b', timestamp: 20 })]);
    const result = log.add([msg({ id: 'a', timestamp: 10 })]);
    expect(result.inOrder).toBe(false);
    expect(log.messages.map(m => m.id)).toEqual(['a', 'b']);
    expect(log.latestId()).toBe('b');
  });

  it('reports an in-order merge when an equal timestamp arrives', () => {
    const log = new ChatLog();
    log.add([msg({ timestamp: 20 })]);
    expect(log.add([msg({ timestamp: 20 })]).inOrder).toBe(true);
  });

  it('drops the oldest past the cap, and a dropped id can arrive again', () => {
    const log = new ChatLog();
    const first = msg({ id: 'first', timestamp: 0 });
    log.add([first]);
    log.add(Array.from({ length: CLIENT_CHAT_CAPS.public }, (_, i) => msg({ id: `n${i}`, timestamp: i + 1 })));
    expect(log.messages).toHaveLength(CLIENT_CHAT_CAPS.public);
    expect(log.messages[0].id).toBe('n0');
    expect(log.add([{ ...first, timestamp: 10_000 }]).added).toHaveLength(1);
  });

  it('keeps DMs past 500 public messages, with the newest still last', () => {
    const log = new ChatLog();
    const dms = [msg({ id: 'dm1', channelType: 'dm', channelId: 'me' }), msg({ id: 'dm2', channelType: 'dm', channelId: 'me' })];
    log.add(dms);
    for (let i = 0; i < 500; i++) log.add([msg({ id: `p${i}` })]);

    expect(log.messages.filter(m => m.channelType === 'dm').map(m => m.id)).toEqual(['dm1', 'dm2']);
    expect(log.messages.filter(m => m.channelType === 'global')).toHaveLength(CLIENT_CHAT_CAPS.public);
    expect(log.latestId()).toBe('p499');
  });

  it('keeps party and guild lines apart from public ones', () => {
    const log = new ChatLog();
    log.add([msg({ id: 'party1', channelType: 'party' }), msg({ id: 'guild1', channelType: 'guild' })]);
    log.add(Array.from({ length: 300 }, (_, i) => msg({ id: `z${i}`, channelType: 'zone' })));

    expect(log.messages.slice(0, 2).map(m => m.id)).toEqual(['party1', 'guild1']);
    expect(log.messages).toHaveLength(2 + CLIENT_CHAT_CAPS.public);
  });

  it('reports only what it kept as added', () => {
    const log = new ChatLog();
    const batch = Array.from({ length: CLIENT_CHAT_CAPS.public + 10 }, (_, i) => msg({ id: `b${i}` }));

    const { added } = log.add(batch);

    expect(added).toHaveLength(CLIENT_CHAT_CAPS.public);
    expect(added[0].id).toBe('b10');
    expect(log.add([batch[0]]).added).toEqual([]);
  });
});

describe('dmPartner', () => {
  it('is the recipient on a DM I sent and the sender otherwise', () => {
    expect(dmPartner(msg({ senderUsername: 'me', channelId: 'Mira' }), 'me')).toBe('Mira');
    expect(dmPartner(msg({ senderUsername: 'Mira', channelId: 'me' }), 'me')).toBe('Mira');
  });
});

describe('isShownInView', () => {
  const all = { tab: 'all', thread: null } as const;

  it('applies channel filters on All', () => {
    expect(isShownInView(msg({ channelType: 'zone' }), all, withFilterOff('zone'))).toBe(false);
    expect(isShownInView(msg({ channelType: 'tile' }), all, withFilterOff('zone'))).toBe(true);
  });

  it('shows Party and Guild tabs regardless of the filter', () => {
    const party = msg({ channelType: 'party' });
    expect(isShownInView(party, { tab: 'party', thread: null }, withFilterOff('party'))).toBe(true);
    expect(isShownInView(msg({ channelType: 'guild' }), { tab: 'party', thread: null }, audience())).toBe(false);
  });

  it('hides blocked senders by level', () => {
    const blockedAll = audience({ blocked: { bob: 'all' } });
    const blockedDm = audience({ blocked: { bob: 'dm' } });
    expect(isShownInView(msg(), all, blockedAll)).toBe(false);
    expect(isShownInView(msg(), all, blockedDm)).toBe(true);
    expect(isShownInView(msg({ channelType: 'dm', channelId: 'me' }), all, blockedDm)).toBe(false);
  });

  it('shows only the open thread on the DM tab, in both directions', () => {
    const view = { tab: 'dm', thread: 'Mira' } as const;
    expect(isShownInView(msg({ channelType: 'dm', senderUsername: 'Mira', channelId: 'me' }), view, audience())).toBe(true);
    expect(isShownInView(msg({ channelType: 'dm', senderUsername: 'me', channelId: 'Mira' }), view, audience())).toBe(true);
    expect(isShownInView(msg({ channelType: 'dm', senderUsername: 'Oskar', channelId: 'me' }), view, audience())).toBe(false);
    expect(isShownInView(msg({ channelType: 'dm', senderUsername: 'Mira', channelId: 'me' }), { tab: 'dm', thread: null }, audience())).toBe(false);
  });
});

describe('chatPreview', () => {
  it('counts unread by timestamp, including what a sync delivered', () => {
    const messages = [msg({ timestamp: 5 }), msg({ timestamp: 15 }), msg({ timestamp: 25 })];
    const preview = chatPreview(messages, 10, audience());
    expect(preview.count).toBe(2);
    expect(preview.message).toBe(messages[2]);
  });

  it('shows the latest line with a zero count when everything is read', () => {
    const messages = [msg({ timestamp: 5 })];
    const preview = chatPreview(messages, 10, audience());
    expect(preview.count).toBe(0);
    expect(preview.message).toBe(messages[0]);
  });

  it('pins the newest unread DM over newer public lines', () => {
    const dm = msg({ channelType: 'dm', channelId: 'me', senderUsername: 'Mira', timestamp: 15 });
    const preview = chatPreview([msg({ timestamp: 11 }), dm, msg({ timestamp: 20 })], 10, audience());
    expect(preview.message).toBe(dm);
    expect(preview.count).toBe(3);
  });

  it('does not pin a DM that was already read', () => {
    const dm = msg({ channelType: 'dm', channelId: 'me', senderUsername: 'Mira', timestamp: 5 });
    const newer = msg({ timestamp: 15 });
    expect(chatPreview([dm, newer], 10, audience()).message).toBe(newer);
  });

  it('skips own echoes, blocked senders and filtered channels', () => {
    const shown = msg({ timestamp: 11 });
    const messages = [
      shown,
      msg({ timestamp: 12, senderUsername: 'me' }),
      msg({ timestamp: 13, senderUsername: 'Grief' }),
      msg({ timestamp: 14, channelType: 'zone' }),
    ];
    const preview = chatPreview(messages, 10, {
      me: 'me',
      blocked: { Grief: 'all' },
      filters: { ...DEFAULT_CHAT_FILTERS, zone: false },
    });
    expect(preview.count).toBe(1);
    expect(preview.message).toBe(shown);
  });

  it('shows a server line but never counts it', () => {
    const server = msg({ channelType: 'server', senderUsername: 'Server', timestamp: 15 });
    const preview = chatPreview([server], 10, audience());
    expect(preview.count).toBe(0);
    expect(preview.message).toBe(server);
  });

  it('drops a filtered server line entirely', () => {
    const server = msg({ channelType: 'server', senderUsername: 'Server', timestamp: 15 });
    expect(chatPreview([server], 10, withFilterOff('server')).message).toBeNull();
  });

  it('shows your own message when nothing is unread', () => {
    const mine = msg({ timestamp: 6, senderUsername: 'me' });
    const preview = chatPreview([msg({ timestamp: 5 }), mine], 10, audience());
    expect(preview).toEqual({ count: 0, message: mine, unread: false, own: true, mention: false, latestAt: 6 });
  });

  it('shows your own message over an older server line, and never counts it', () => {
    const mine = msg({ timestamp: 16, senderUsername: 'me' });
    const preview = chatPreview([msg({ timestamp: 15, channelType: 'server', senderUsername: 'Server' }), mine], 10, audience());
    expect(preview.message).toBe(mine);
    expect(preview.own).toBe(true);
    expect(preview.count).toBe(0);
  });

  it('keeps an unread line from another player over a later server line and a later own message', () => {
    const fromBob = msg({ timestamp: 11 });
    const messages = [
      fromBob,
      msg({ timestamp: 12, channelType: 'server', senderUsername: 'Server' }),
      msg({ timestamp: 13, senderUsername: 'me' }),
      msg({ timestamp: 14, channelType: 'server', senderUsername: 'Server' }),
    ];
    expect(chatPreview(messages, 10, audience())).toEqual({ count: 1, message: fromBob, unread: true, own: false, mention: false, latestAt: 14 });
  });

  it('shows the newest line of any kind once everything is read', () => {
    const server = msg({ timestamp: 14, channelType: 'server', senderUsername: 'Server' });
    const preview = chatPreview([msg({ timestamp: 11 }), msg({ timestamp: 12, senderUsername: 'me' }), server], 20, audience());
    expect(preview.message).toBe(server);
    expect(preview.unread).toBe(false);
    expect(preview.own).toBe(false);
  });

  it('flags a pinned DM as unread', () => {
    const dm = msg({ channelType: 'dm', channelId: 'me', senderUsername: 'Mira', timestamp: 15 });
    const preview = chatPreview([dm, msg({ timestamp: 16, senderUsername: 'me' })], 10, audience());
    expect(preview.message).toBe(dm);
    expect(preview.unread).toBe(true);
    expect(preview.count).toBe(1);
  });

  it('honours filters and blocks when falling back to the newest line', () => {
    const shown = msg({ timestamp: 5 });
    const ownZone = msg({ timestamp: 6, senderUsername: 'me', channelType: 'zone' });
    expect(chatPreview([shown, ownZone], 10, withFilterOff('zone')).message).toBe(shown);
    const blockedLast = msg({ timestamp: 7, senderUsername: 'Grief' });
    expect(chatPreview([shown, blockedLast], 10, audience({ blocked: { Grief: 'all' } })).message).toBe(shown);
  });

  it('treats nothing as your own before your name is known', () => {
    const line = msg({ timestamp: 15, senderUsername: 'me' });
    const preview = chatPreview([line], 10, audience({ me: undefined }));
    expect(preview.own).toBe(false);
    expect(preview.unread).toBe(true);
    expect(preview.count).toBe(1);
  });

  it('flags an unread line that names you as a mention, and only while unread', () => {
    const line = msg({ timestamp: 15, text: 'hey ME, over here' });
    expect(chatPreview([line], 10, audience()).mention).toBe(true);
    expect(chatPreview([line], 20, audience()).mention).toBe(false);
    expect(chatPreview([msg({ timestamp: 15, text: 'memes' })], 10, audience()).mention).toBe(false);
  });

  it('keeps an unread mention on the line over a later plain line from another player', () => {
    const mention = msg({ timestamp: 11, text: 'hey me, want to party?' });
    const preview = chatPreview([mention, msg({ timestamp: 12, senderUsername: 'carol', text: 'lol' })], 10, audience());
    expect(preview).toMatchObject({ message: mention, mention: true, unread: true, count: 2 });
  });

  it('still pins an unread DM over a newer mention', () => {
    const dm = msg({ channelType: 'dm', channelId: 'me', senderUsername: 'Mira', text: 'psst', timestamp: 11 });
    const messages = [dm, msg({ timestamp: 12, text: 'me, over here' }), msg({ timestamp: 13, senderUsername: 'carol' })];
    expect(chatPreview(messages, 10, audience())).toMatchObject({ message: dm, mention: false, count: 3 });
  });

  it('reports the newest timestamp in the log, blocked and filtered lines included', () => {
    const messages = [msg({ timestamp: 5 }), msg({ timestamp: 7, senderUsername: 'Grief' }), msg({ timestamp: 9, channelType: 'zone' })];
    const preview = chatPreview(messages, 10, { ...withFilterOff('zone'), blocked: { Grief: 'all' } });
    expect(preview.message).toBe(messages[0]);
    expect(preview.latestAt).toBe(9);
    expect(chatPreview([], 10, audience()).latestAt).toBe(0);
  });
});

describe('mentionsName', () => {
  it('finds the name as a whole word in any case', () => {
    expect(mentionsName('hi Mira', 'mira')).toBe(true);
    expect(mentionsName('MIRA come here', 'Mira')).toBe(true);
    expect(mentionsName('Mira', 'Mira')).toBe(true);
  });

  it('accepts punctuation around the name', () => {
    for (const text of ['@Mira hi', 'thanks, Mira!', '(Mira)', 'Mira\'s sword', 'ok Mira.', 'Mira:']) {
      expect(mentionsName(text, 'Mira'), text).toBe(true);
    }
  });

  it('does not find the name inside a longer word or name', () => {
    for (const text of ['Miras', 'Admira', 'Mira_2', 'Mira-chan', 'Mira2', 'Miraé']) {
      expect(mentionsName(text, 'Mira'), text).toBe(false);
    }
  });

  it('keeps looking past an occurrence inside a word', () => {
    expect(mentionsName('Miras and Mira', 'Mira')).toBe(true);
  });

  it('treats the name as plain text, not a pattern', () => {
    expect(mentionsName('hello a.b', 'a.b')).toBe(true);
    expect(mentionsName('hello axb', 'a.b')).toBe(false);
    expect(mentionsName('anything', '')).toBe(false);
  });
});

describe('isChatMention', () => {
  it('is never your own line, a server line, or anything before your name is known', () => {
    expect(isChatMention(msg({ senderUsername: 'me', text: 'me again' }), 'me')).toBe(false);
    expect(isChatMention(msg({ channelType: 'server', senderUsername: 'Server', text: 'welcome me' }), 'me')).toBe(false);
    expect(isChatMention(msg({ text: 'hi me' }), undefined)).toBe(false);
    expect(isChatMention(msg({ text: 'hi me' }), 'me')).toBe(true);
  });
});

describe('buildDmThreads', () => {
  const seen = (at: number) => () => at;

  it('groups by partner, newest first, with the last line of each', () => {
    const oldMira = msg({ channelType: 'dm', senderUsername: 'Mira', channelId: 'me', timestamp: 1 });
    const oskar = msg({ channelType: 'dm', senderUsername: 'Oskar', channelId: 'me', timestamp: 2 });
    const reply = msg({ channelType: 'dm', senderUsername: 'me', channelId: 'Mira', timestamp: 3 });
    const threads = buildDmThreads([oldMira, oskar, reply], audience(), seen(0));
    expect(threads.map(t => t.username)).toEqual(['Mira', 'Oskar']);
    expect(threads[0].last).toBe(reply);
  });

  it('marks a thread unread only for messages from the partner after it was seen', () => {
    const fromMira = msg({ channelType: 'dm', senderUsername: 'Mira', channelId: 'me', timestamp: 10 });
    expect(buildDmThreads([fromMira], audience(), seen(5))[0].unread).toBe(true);
    expect(buildDmThreads([fromMira], audience(), seen(10))[0].unread).toBe(false);
    const mine = msg({ channelType: 'dm', senderUsername: 'me', channelId: 'Mira', timestamp: 10 });
    expect(buildDmThreads([mine], audience(), seen(5))[0].unread).toBe(false);
  });

  it('leaves out blocked senders and other channels', () => {
    const blocked = msg({ channelType: 'dm', senderUsername: 'Grief', channelId: 'me' });
    expect(buildDmThreads([blocked, msg()], audience({ blocked: { Grief: 'dm' } }), seen(0))).toEqual([]);
  });

  it('merges different spellings of one name, keeping the sender spelling', () => {
    const typed = msg({ channelType: 'dm', senderUsername: 'me', channelId: 'mira', timestamp: 2 });
    const theirs = msg({ channelType: 'dm', senderUsername: 'Mira', channelId: 'me', timestamp: 1 });
    const threads = buildDmThreads([theirs, typed], audience(), seen(0));
    expect(threads).toHaveLength(1);
    expect(threads[0].username).toBe('Mira');
  });
});

describe('membership and sendable channels', () => {
  it('counts a party of one as solo, so Party is not offered', () => {
    const solo = chatMembership({ social: { party: { members: [{}] }, guild: null } } as unknown as ServerStateMessage);
    expect(sendableChannels(solo)).toEqual(['global', 'zone', 'tile', 'dm']);
  });

  it('offers Party and Guild when they exist', () => {
    const social = { party: { id: 'p1', members: [{}, {}] }, guild: { id: 'g1' } };
    const membership = chatMembership({ social } as unknown as ServerStateMessage);
    expect(membership).toEqual({ inParty: true, partyId: 'p1', guildId: 'g1' });
    expect(sendableChannels(membership)).toEqual(['global', 'zone', 'tile', 'party', 'guild', 'dm']);
  });

  it('names no party for a party of one, whose chat reaches no one', () => {
    const solo = chatMembership({ social: { party: { id: 'p1', members: [{}] }, guild: null } } as unknown as ServerStateMessage);
    expect(solo.partyId).toBeNull();
  });

  it('is empty before the first state', () => {
    expect(chatMembership(null)).toEqual({ inParty: false, partyId: null, guildId: null });
  });
});

describe('canonicalUsername', () => {
  it('takes the known spelling and trims', () => {
    expect(canonicalUsername(' mira ', [{ username: 'Mira' }])).toBe('Mira');
  });

  it('keeps an unknown name as typed', () => {
    expect(canonicalUsername('Nobody', [{ username: 'Mira' }])).toBe('Nobody');
    expect(canonicalUsername('Nobody', undefined)).toBe('Nobody');
  });
});

describe('resolveSendTarget', () => {
  it('sends the raw zone key the server reported for the party', () => {
    expect(resolveSendTarget('zone', '', state({ zone: 'raw_zone_key' }))).toEqual({ ok: true, channelId: 'raw_zone_key' });
  });

  it('refuses zone chat when the party is in no zone', () => {
    expect(resolveSendTarget('zone', '', state({ zone: '' })).ok).toBe(false);
    expect(resolveSendTarget('zone', '', null).ok).toBe(false);
  });

  it('sends the guild id, and refuses without a guild', () => {
    const inGuild = state({ social: { guild: { id: 'g1' } } });
    expect(resolveSendTarget('guild', '', inGuild)).toEqual({ ok: true, channelId: 'g1' });
    expect(resolveSendTarget('guild', '', state()).ok).toBe(false);
  });

  it('sends the known spelling on a DM, and refuses an empty name', () => {
    expect(resolveSendTarget('dm', 'mira', state())).toEqual({ ok: true, channelId: 'Mira' });
    expect(resolveSendTarget('dm', '  ', state()).ok).toBe(false);
  });

  it.each(['global', 'tile', 'party'] as const)('leaves %s to the server to resolve', (channel) => {
    expect(resolveSendTarget(channel, '', state())).toEqual({ ok: true, channelId: '' });
  });
});

describe('renderChatRow', () => {
  function rowElement(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild as HTMLElement;
  }

  const options = { me: 'me', showChannel: true };

  it('cannot be broken out of through channelId or the sender name', () => {
    const payload = 'x" onmouseover="alert(1)" data-y="';
    const row = rowElement(renderChatRow(msg({
      channelType: 'dm',
      channelId: payload,
      senderUsername: `"><img src=x onerror="alert(1)">`,
      text: '<b>hi</b>',
    }), options));
    const attributes = [...row.querySelectorAll('*')].flatMap(el => el.getAttributeNames());
    expect(attributes.filter(name => name.startsWith('on'))).toEqual([]);
    expect(row.querySelector('img, b')).toBeNull();
    expect(row.querySelector('.chat-msg-text')?.textContent).toBe('<b>hi</b>');
    expect(row.querySelector<HTMLElement>('.chat-msg-tag-btn')?.dataset.channelId).toBe(payload);
  });

  it('carries data-channel-id on DMs only', () => {
    const row = rowElement(renderChatRow(msg({ channelId: 'whatever' }), options));
    expect(row.querySelector('.chat-msg-tag-btn')?.hasAttribute('data-channel-id')).toBe(false);
  });

  it('names the recipient on a DM I sent', () => {
    const row = rowElement(renderChatRow(msg({ channelType: 'dm', senderUsername: 'me', channelId: 'Mira' }), options));
    expect(row.querySelector('.chat-msg-dm-to')?.textContent).toBe('to');
    expect(row.querySelector('.chat-msg-sender-btn[data-user="Mira"]')).not.toBeNull();
  });

  it('leaves the recipient and channel out where the view says them already', () => {
    const row = rowElement(renderChatRow(
      msg({ channelType: 'dm', senderUsername: 'me', channelId: 'Mira' }),
      { me: 'me', showChannel: false },
    ));
    expect(row.querySelector('.chat-msg-dm-to')).toBeNull();
    expect(row.querySelector('.chat-msg-tag')).toBeNull();
  });

  it('keeps server rows inert', () => {
    const row = rowElement(renderChatRow(msg({ channelType: 'server', senderUsername: 'Server' }), options));
    expect(row.querySelector('button')).toBeNull();
  });

  it('marks a row from another player that names you', () => {
    expect(rowElement(renderChatRow(msg({ text: 'over here, Me!' }), options)).classList.contains('chat-msg-mention')).toBe(true);
    expect(rowElement(renderChatRow(msg({ text: 'memes' }), options)).classList.contains('chat-msg-mention')).toBe(false);
    expect(rowElement(renderChatRow(msg({ senderUsername: 'me', text: 'me again' }), options)).classList.contains('chat-msg-mention')).toBe(false);
    const server = rowElement(renderChatRow(msg({ channelType: 'server', senderUsername: 'Server', text: 'welcome me' }), options));
    expect(server.classList.contains('chat-msg-mention')).toBe(false);
  });
});

describe('renderChatRows', () => {
  it('renders only the newest rows up to the cap', () => {
    const messages = Array.from({ length: CHAT_ROW_CAP + 5 }, (_, i) => msg({ timestamp: i + 1, text: `t${i}` }));
    const { html, rows, lastTimestamp } = renderChatRows(messages, { me: 'me', showChannel: true });
    expect(rows).toBe(CHAT_ROW_CAP);
    expect(lastTimestamp).toBe(CHAT_ROW_CAP + 5);
    expect(html).not.toContain('>t4<');
    expect(html).toContain('>t5<');
  });

  it('puts a separator between calendar days', () => {
    const day = 24 * 60 * 60 * 1000;
    const { html } = renderChatRows(
      [msg({ timestamp: Date.now() - day * 3 }), msg({ timestamp: Date.now() })],
      { me: 'me', showChannel: true },
    );
    expect(html.match(/chat-day-separator/g)).toHaveLength(2);
  });
});
