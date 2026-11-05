import type { BlockLevel, ChatChannelType, ChatMessage, ServerStateMessage } from '@idle-party-rpg/shared';

export const CHAT_MESSAGE_CAP = 500;
export const CHAT_ROW_CAP = 200;

export type ChatTab = 'all' | 'party' | 'guild' | 'dm';
export type ChatFilters = Record<ChatChannelType, boolean>;

export interface ChatView {
  tab: ChatTab;
  /** The DM partner on screen; only meaningful on the `dm` tab. */
  thread: string | null;
}

export interface ChatAudience {
  me: string | undefined;
  blocked: Readonly<Record<string, BlockLevel>>;
  filters: ChatFilters;
}

export interface ChatPreview {
  count: number;
  message: ChatMessage | null;
}

export interface DmThread {
  username: string;
  last: ChatMessage;
  unread: boolean;
}

export type SendTarget = { ok: true; channelId: string } | { ok: false; reason: string };

export const CHANNEL_LABELS: Readonly<Record<ChatChannelType, string>> = {
  global: 'Global',
  zone: 'Zone',
  tile: 'Room',
  party: 'Party',
  guild: 'Guild',
  dm: 'DM',
  server: 'Server',
};

export const FILTER_CHANNELS: readonly ChatChannelType[] = ['global', 'zone', 'tile', 'party', 'guild', 'dm', 'server'];

export const DEFAULT_CHAT_FILTERS: Readonly<ChatFilters> = {
  global: true,
  zone: true,
  tile: true,
  party: true,
  guild: true,
  dm: true,
  server: true,
};

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeChatHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
}

/** Saved history outlives the server's `channelId` checks, so nothing on a message can be trusted to be a string. */
export function normalizeChatMessage(raw: ChatMessage): ChatMessage {
  return {
    id: String(raw.id),
    channelType: raw.channelType,
    channelId: String(raw.channelId ?? ''),
    senderUsername: String(raw.senderUsername ?? ''),
    text: String(raw.text ?? ''),
    timestamp: Number(raw.timestamp) || 0,
  };
}

/** Messages held in timestamp order, deduplicated by id, oldest dropped past the cap. Merges only: never replaces. */
export class ChatLog {
  readonly messages: ChatMessage[] = [];
  private ids = new Set<string>();

  /** `inOrder` is false when something landed before an existing message, so an appended view would be wrong. */
  add(incoming: readonly ChatMessage[]): { added: ChatMessage[]; inOrder: boolean } {
    const added: ChatMessage[] = [];
    let inOrder = true;
    for (const raw of incoming) {
      const message = normalizeChatMessage(raw);
      if (this.ids.has(message.id)) continue;
      const last = this.messages[this.messages.length - 1];
      if (last && message.timestamp < last.timestamp) inOrder = false;
      this.ids.add(message.id);
      this.messages.push(message);
      added.push(message);
    }
    if (!inOrder) this.messages.sort((a, b) => a.timestamp - b.timestamp);
    const excess = this.messages.length - CHAT_MESSAGE_CAP;
    if (excess > 0) {
      for (const dropped of this.messages.splice(0, excess)) this.ids.delete(dropped.id);
    }
    return { added, inOrder };
  }

  latestId(): string | undefined {
    return this.messages[this.messages.length - 1]?.id;
  }

  newestTimestamp(): number {
    return this.messages[this.messages.length - 1]?.timestamp ?? 0;
  }
}

export function sameUser(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function dmPartner(message: ChatMessage, me: string | undefined): string {
  return me && message.senderUsername === me ? message.channelId : message.senderUsername;
}

export function isBlockedMessage(message: ChatMessage, blocked: ChatAudience['blocked']): boolean {
  const level = blocked[message.senderUsername];
  return level === 'all' || (level === 'dm' && message.channelType === 'dm');
}

function passesFilter(message: ChatMessage, filters: ChatFilters): boolean {
  return filters[message.channelType] !== false;
}

/** Only the All tab honours the channel filters: Party, Guild and a DM thread are explicit choices. */
export function isShownInView(message: ChatMessage, view: ChatView, audience: ChatAudience): boolean {
  if (isBlockedMessage(message, audience.blocked)) return false;
  switch (view.tab) {
    case 'all':
      return passesFilter(message, audience.filters);
    case 'party':
    case 'guild':
      return message.channelType === view.tab;
    case 'dm':
      return message.channelType === 'dm'
        && view.thread !== null
        && sameUser(dmPartner(message, audience.me), view.thread);
  }
}

function belongsInPreview(message: ChatMessage, audience: ChatAudience): boolean {
  return message.senderUsername !== audience.me
    && !isBlockedMessage(message, audience.blocked)
    && passesFilter(message, audience.filters);
}

/** The strip's line and count. A newest unread DM pins over public lines; server lines may show but never count. */
export function chatPreview(messages: readonly ChatMessage[], lastSeenAt: number, audience: ChatAudience): ChatPreview {
  let count = 0;
  let newest: ChatMessage | null = null;
  let pinnedDm: ChatMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const unread = message.timestamp > lastSeenAt;
    if (!unread && newest) break;
    if (!belongsInPreview(message, audience)) continue;
    newest ??= message;
    if (!unread || message.channelType === 'server') continue;
    count++;
    if (message.channelType === 'dm') pinnedDm ??= message;
  }
  return { count, message: pinnedDm ?? newest };
}

/** One row per DM partner, newest first. `seenAt` answers when that partner's thread was last on screen. */
export function buildDmThreads(
  messages: readonly ChatMessage[],
  audience: Pick<ChatAudience, 'me' | 'blocked'>,
  seenAt: (username: string) => number,
): DmThread[] {
  const threads = new Map<string, DmThread>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.channelType !== 'dm' || isBlockedMessage(message, audience.blocked)) continue;
    const partner = dmPartner(message, audience.me);
    if (!partner) continue;
    const key = partner.toLowerCase();
    const thread = threads.get(key) ?? { username: partner, last: message, unread: false };
    if (message.senderUsername !== audience.me) {
      thread.username = message.senderUsername;
      if (message.timestamp > seenAt(key)) thread.unread = true;
    }
    threads.set(key, thread);
  }
  return [...threads.values()];
}

export interface ChatMembership {
  inParty: boolean;
  guildId: string | null;
}

export function chatMembership(state: Pick<ServerStateMessage, 'social'> | null | undefined): ChatMembership {
  const social = state?.social;
  return {
    inParty: (social?.party?.members.length ?? 0) > 1,
    guildId: social?.guild?.id ?? null,
  };
}

export function sendableChannels(membership: ChatMembership): ChatChannelType[] {
  const channels: ChatChannelType[] = ['global', 'zone', 'tile'];
  if (membership.inParty) channels.push('party');
  if (membership.guildId) channels.push('guild');
  channels.push('dm');
  return channels;
}

/** The server matches recipients by exact name, so a typed name takes the known player's spelling. */
export function canonicalUsername(typed: string, known: readonly { username: string }[] | undefined): string {
  const trimmed = typed.trim();
  return known?.find(player => sameUser(player.username, trimmed))?.username ?? trimmed;
}

/** What goes in `channelId`: the server compares zone against the room's raw zone key, not its display name. */
export function resolveSendTarget(
  channel: ChatChannelType,
  dmTarget: string,
  state: ServerStateMessage | null | undefined,
  getTileOn: ((mapId: string, col: number, row: number) => { zone: string } | undefined) | undefined,
): SendTarget {
  switch (channel) {
    case 'dm': {
      const username = canonicalUsername(dmTarget, state?.social?.allPlayers);
      return username ? { ok: true, channelId: username } : { ok: false, reason: 'Choose who to message first.' };
    }
    case 'zone': {
      const tile = state ? getTileOn?.(state.currentMapId, state.party.col, state.party.row) : undefined;
      return tile?.zone ? { ok: true, channelId: tile.zone } : { ok: false, reason: 'Zone chat isn\'t available in this room.' };
    }
    case 'guild': {
      const guildId = state?.social?.guild?.id;
      return guildId ? { ok: true, channelId: guildId } : { ok: false, reason: 'You aren\'t in a guild.' };
    }
    default:
      return { ok: true, channelId: '' };
  }
}

export function formatChatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function isSameChatDay(a: number, b: number): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

export function formatChatDay(timestamp: number, now: number = Date.now()): string {
  if (isSameChatDay(timestamp, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameChatDay(timestamp, yesterday.getTime())) return 'Yesterday';
  const d = new Date(timestamp);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date(now).getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

export function renderDaySeparator(timestamp: number): string {
  return `<div class="chat-day-separator"><span>${escapeChatHtml(formatChatDay(timestamp))}</span></div>`;
}

export interface ChatRowOptions {
  me: string | undefined;
  /** Off when the view already says which channel this is. */
  showChannel: boolean;
}

export function renderChatRow(message: ChatMessage, options: ChatRowOptions): string {
  const channelType = escapeChatHtml(message.channelType);
  const sender = escapeChatHtml(message.senderUsername || 'Server');
  const text = escapeChatHtml(message.text);
  const time = `<span class="chat-msg-time">${formatChatTime(message.timestamp)}</span>`;

  if (message.channelType === 'server') {
    return `<div class="chat-msg chat-msg-server" data-ch="server">${time}<span class="chat-msg-sender">${sender}:</span> <span class="chat-msg-text">${text}</span></div>`;
  }

  const label = escapeChatHtml(CHANNEL_LABELS[message.channelType] ?? message.channelType);
  const isDm = message.channelType === 'dm';
  const mine = !!options.me && message.senderUsername === options.me;
  const channelIdAttr = isDm ? ` data-channel-id="${escapeChatHtml(message.channelId)}"` : '';
  const tag = options.showChannel
    ? `<button type="button" class="chat-msg-tag chat-msg-tag-btn" data-channel="${channelType}"${channelIdAttr} data-sender="${sender}">${label}</button>`
    : '';
  const senderClass = `chat-msg-sender chat-msg-sender-btn${mine ? ' chat-msg-mine' : ''}`;
  const recipient = isDm && mine && options.showChannel ? escapeChatHtml(message.channelId) : '';
  const names = recipient
    ? `<button type="button" class="${senderClass}" data-user="${sender}">${sender}</button>`
      + `<span class="chat-msg-dm-to">to</span>`
      + `<button type="button" class="chat-msg-sender chat-msg-sender-btn" data-user="${recipient}">${recipient}:</button>`
    : `<button type="button" class="${senderClass}" data-user="${sender}">${sender}:</button>`;
  return `<div class="chat-msg" data-ch="${channelType}">${time}${tag}${names} <span class="chat-msg-text">${text}</span></div>`;
}

/** Message rows for the view: the newest `CHAT_ROW_CAP`, with day separators. */
export function renderChatRows(
  messages: readonly ChatMessage[],
  options: ChatRowOptions,
): { html: string; rows: number; lastTimestamp: number | null } {
  const shown = messages.slice(-CHAT_ROW_CAP);
  let html = '';
  let lastTimestamp: number | null = null;
  for (const message of shown) {
    if (lastTimestamp === null || !isSameChatDay(lastTimestamp, message.timestamp)) html += renderDaySeparator(message.timestamp);
    html += renderChatRow(message, options);
    lastTimestamp = message.timestamp;
  }
  return { html, rows: shown.length, lastTimestamp };
}
