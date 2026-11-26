import type { ChatMessage } from '@idle-party-rpg/shared';
import { escapeChatHtml } from './chatModel';
import type { ChatPreview } from './chatModel';
import { reducedMotion } from './motion';
import { deferWhilePressed, setHtml } from './render';

const SWIPE_MIN_PX = 28;
const CLICK_AFTER_SWIPE_MS = 350;

export interface SwipeHandlers {
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
}

/** Touch swipes only. Needs `touch-action: none` on `el`, or the browser takes the gesture over and cancels the pointer. */
export function wireVerticalSwipe(el: HTMLElement, handlers: SwipeHandlers): void {
  let startX = 0;
  let startY = 0;
  let activePointer: number | null = null;
  let swipedAt = -Infinity;

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    activePointer = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
  });
  el.addEventListener('pointercancel', () => { activePointer = null; });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    const dy = e.clientY - startY;
    if (Math.abs(dy) < SWIPE_MIN_PX || Math.abs(dy) < Math.abs(e.clientX - startX)) return;
    swipedAt = performance.now();
    if (dy < 0) handlers.onSwipeUp?.();
    else handlers.onSwipeDown?.();
  });
  el.addEventListener('click', (e) => {
    if (performance.now() - swipedAt > CLICK_AFTER_SWIPE_MS) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

function previewHtml(preview: ChatPreview, message: ChatMessage, arriving: boolean): string {
  const channel = escapeChatHtml(message.channelType);
  const sender = preview.own ? 'You' : message.senderUsername || 'Server';
  const lineClass = `chat-strip-line${message.channelType === 'server' ? ' chat-strip-dim' : ''}${arriving ? ' chat-strip-arrive' : ''}`;
  return `<span class="chat-strip-dot" data-ch="${channel}"></span>`
    + `<span class="${lineClass}">`
    + `<span class="chat-strip-sender" data-ch="${channel}">${escapeChatHtml(sender)}</span> `
    + `<span class="chat-strip-text">${escapeChatHtml(message.text)}</span>`
    + '</span>';
}

/** The cue class goes once it has played, or a strip hidden and shown again (rotation, resize) would replay it. */
function settleArrival(line: Element | null): void {
  if (!line) return;
  const settle = () => line.classList.remove('chat-strip-arrive');
  line.addEventListener('animationend', settle, { once: true });
  line.addEventListener('animationcancel', settle, { once: true });
}

/** The phone's one-line chat preview, painted inside the strip's existing button. */
export class ChatStrip {
  private labelEl: HTMLElement | null;
  private slot: HTMLElement;
  /** The log's newest timestamp at the last paint; null until there is one, so what is there at load never animates. */
  private knownAt: number | null = null;

  constructor(slot: HTMLElement, onOpen: () => void) {
    this.slot = slot;
    this.labelEl = slot.querySelector('.chat-strip-open-label');
    const button = slot.querySelector<HTMLElement>('.chat-strip-open');
    if (button) wireVerticalSwipe(button, { onSwipeUp: onOpen });
  }

  render(preview: ChatPreview): void {
    const label = this.labelEl;
    if (!label) return;
    const message = preview.message;
    const arriving = this.takeArrival(preview);
    deferWhilePressed(this.slot, () => {
      this.slot.classList.toggle('has-preview', !!message);
      this.slot.classList.toggle('has-unread', preview.unread);
      this.slot.classList.toggle('has-mention', preview.mention);
      if (message) this.slot.dataset.ch = message.channelType;
      else delete this.slot.dataset.ch;
      setHtml(label, message ? previewHtml(preview, message, arriving) : 'Chat');
      if (arriving) settleArrival(label.querySelector('.chat-strip-arrive'));
    });
  }

  /** Only a line newer than anything in the log at the last paint arrives, so a block or unblock never replays one. */
  private takeArrival(preview: ChatPreview): boolean {
    const message = preview.message;
    const knownAt = this.knownAt;
    const latest = Math.max(preview.latestAt, message?.timestamp ?? 0);
    if (latest > 0) this.knownAt = Math.max(knownAt ?? 0, latest);
    if (!message || knownAt === null) return false;
    return preview.unread && message.timestamp > knownAt && !reducedMotion();
  }
}
