import { describe, expect, it } from 'vitest';
import { CLIENT_CHAT_CAPS, SERVER_CHAT_CAPS, chatBucket, countChatBuckets, trimChatHistory } from '../src/systems/SocialTypes';
import type { ChatChannelType, ChatMessage } from '../src/systems/SocialTypes';

let nextId = 0;

function line(channelType: ChatChannelType): ChatMessage {
  nextId++;
  return { id: `m${nextId}`, channelType, channelId: '', senderUsername: 'Testy', text: `line ${nextId}`, timestamp: nextId };
}

const caps = { dm: 2, group: 2, public: 3 };

describe('chatBucket', () => {
  it.each<[ChatChannelType, string]>([
    ['dm', 'dm'],
    ['party', 'group'],
    ['guild', 'group'],
    ['global', 'public'],
    ['zone', 'public'],
    ['tile', 'public'],
    ['server', 'public'],
  ])('puts %s in %s', (channelType, bucket) => {
    expect(chatBucket(channelType)).toBe(bucket);
  });

  it('counts an unknown channel type as public', () => {
    expect(chatBucket('shout' as ChatChannelType)).toBe('public');
  });
});

describe('trimChatHistory', () => {
  it('drops the oldest public line first and never a DM while only public is over its cap', () => {
    const dm1 = line('dm');
    const publicLines = [line('global'), line('zone'), line('tile'), line('server')];
    const dm2 = line('dm');
    const history = [dm1, ...publicLines, dm2];

    const kept = trimChatHistory(history, caps);

    expect(kept).toEqual([dm1, ...publicLines.slice(1), dm2]);
  });

  it('keeps the order of what it keeps, across buckets', () => {
    const [g1, p1, d1, g2, gu1, p2, g3, g4] = [
      line('global'), line('party'), line('dm'), line('global'), line('guild'), line('party'), line('global'), line('global'),
    ];

    const kept = trimChatHistory([g1, p1, d1, g2, gu1, p2, g3, g4], caps);

    expect(kept).toEqual([d1, g2, gu1, p2, g3, g4]);
    expect(countChatBuckets(kept)).toEqual({ dm: 1, group: 2, public: 3 });
  });

  it('returns a copy holding everything when no bucket is over', () => {
    const history = [line('dm'), line('global')];

    const kept = trimChatHistory(history, caps);

    expect(kept).toEqual(history);
    expect(kept).not.toBe(history);
  });

  it('keeps 1,000 lines on the server and 500 on the client, as before', () => {
    expect(SERVER_CHAT_CAPS.dm + SERVER_CHAT_CAPS.group + SERVER_CHAT_CAPS.public).toBe(1000);
    expect(CLIENT_CHAT_CAPS.dm + CLIENT_CHAT_CAPS.group + CLIENT_CHAT_CAPS.public).toBe(500);
  });
});
