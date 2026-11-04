import { escapeChatHtml } from './chatModel';
import type { ChatPreview } from './chatModel';
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

/** The phone's one-line chat preview, painted inside the strip's existing button. */
export class ChatStrip {
  private labelEl: HTMLElement | null;
  private slot: HTMLElement;

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
    deferWhilePressed(this.slot, () => {
      this.slot.classList.toggle('has-preview', !!message);
      setHtml(label, message
        ? `<span class="chat-strip-dot" data-ch="${escapeChatHtml(message.channelType)}"></span>`
          + `<span class="chat-strip-line${message.channelType === 'server' ? ' chat-strip-dim' : ''}">`
          + `<span class="chat-strip-sender" data-ch="${escapeChatHtml(message.channelType)}">${escapeChatHtml(message.senderUsername || 'Server')}</span> `
          + `<span class="chat-strip-text">${escapeChatHtml(message.text)}</span>`
          + '</span>'
        : 'Chat');
    });
  }
}
