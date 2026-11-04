import { beforeEach, describe, expect, it } from 'vitest';
import { bringToFront, dismissModals, dismissTop, registerDismiss, release, setRaised, suspendDismiss, wireFocusOnInteract } from '../src/ui/ModalStack';

function makeEl(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('ModalStack', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('bringToFront assigns an inline z-index above the previous top', () => {
    const a = makeEl();
    const b = makeEl();

    bringToFront(a);
    bringToFront(b);

    const za = parseInt(a.style.zIndex, 10);
    const zb = parseInt(b.style.zIndex, 10);
    expect(Number.isFinite(za)).toBe(true);
    expect(Number.isFinite(zb)).toBe(true);
    expect(zb).toBeGreaterThan(za);
  });

  it('suspendDismiss keeps a panel in the order without Back or Escape closing it', () => {
    const panel = makeEl();
    let closed = 0;
    suspendDismiss(panel);
    expect(dismissTop()).toBe(false);

    const popup = makeEl();
    let popupClosed = 0;
    registerDismiss(popup, () => { popupClosed++; release(popup); });
    registerDismiss(panel, () => { closed++; release(panel); });

    expect(dismissTop()).toBe(true);
    expect(popupClosed).toBe(1);
    expect(closed).toBe(0);
    expect(dismissTop()).toBe(true);
    expect(closed).toBe(1);
  });

  it('setRaised gives the z-index of a place in the order, without moving it', () => {
    const panel = makeEl();
    registerDismiss(panel, () => release(panel));
    const popup = makeEl();
    bringToFront(popup, () => release(popup), { holdFocus: false });

    setRaised(panel, true);
    expect(parseInt(panel.style.zIndex, 10)).toBeLessThan(parseInt(popup.style.zIndex, 10));
    setRaised(panel, false);
    expect(panel.style.zIndex).toBe('');
    dismissTop();
    expect(popup.style.zIndex).toBe('');
  });

  it('re-promoting an element via bringToFront moves it back to the top', () => {
    const a = makeEl();
    const b = makeEl();

    bringToFront(a);
    bringToFront(b);
    bringToFront(a);

    const za = parseInt(a.style.zIndex, 10);
    const zb = parseInt(b.style.zIndex, 10);
    expect(za).toBeGreaterThan(zb);
  });

  it('release strips the inline z-index', () => {
    const a = makeEl();
    bringToFront(a);
    expect(a.style.zIndex).not.toBe('');
    release(a);
    expect(a.style.zIndex).toBe('');
  });

  it('z-index is well above the bottom nav baseline (≥ 1500)', () => {
    const a = makeEl();
    bringToFront(a);
    const z = parseInt(a.style.zIndex, 10);
    expect(z).toBeGreaterThan(1000); // nav z-index ceiling
    expect(z).toBeGreaterThanOrEqual(1500);
  });

  it('wireFocusOnInteract promotes the element on mousedown', () => {
    const a = makeEl();
    const b = makeEl();

    bringToFront(a);
    bringToFront(b);
    expect(parseInt(b.style.zIndex, 10)).toBeGreaterThan(parseInt(a.style.zIndex, 10));

    wireFocusOnInteract(a);
    a.dispatchEvent(new Event('mousedown', { bubbles: true }));

    expect(parseInt(a.style.zIndex, 10)).toBeGreaterThan(parseInt(b.style.zIndex, 10));
  });

  describe('dismissTop', () => {
    it('returns false when nothing can be dismissed', () => {
      bringToFront(makeEl());
      expect(dismissTop()).toBe(false);
    });

    it('dismisses the most recently promoted overlay, once per call', () => {
      const a = makeEl();
      const b = makeEl();
      const closed: string[] = [];
      bringToFront(a, () => { closed.push('a'); release(a); });
      bringToFront(b, () => { closed.push('b'); release(b); });

      expect(dismissTop()).toBe(true);
      expect(closed).toEqual(['b']);
      expect(dismissTop()).toBe(true);
      expect(closed).toEqual(['b', 'a']);
      expect(dismissTop()).toBe(false);
    });

    it('keeps the dismiss when re-promoted without one, and follows the new order', () => {
      const a = makeEl();
      const b = makeEl();
      const closed: string[] = [];
      bringToFront(a, () => closed.push('a'));
      bringToFront(b, () => closed.push('b'));
      wireFocusOnInteract(a);
      a.dispatchEvent(new Event('mousedown', { bubbles: true }));

      dismissTop();
      expect(closed).toEqual(['a']);
    });

    it('skips overlays with no dismiss, such as toasts', () => {
      const modal = makeEl();
      const toast = makeEl();
      let closed = false;
      bringToFront(modal, () => { closed = true; });
      bringToFront(toast);

      expect(dismissTop()).toBe(true);
      expect(closed).toBe(true);
    });

    it('ignores overlays removed without a release', () => {
      const a = makeEl();
      let closed = false;
      bringToFront(a, () => { closed = true; });
      a.remove();

      expect(dismissTop()).toBe(false);
      expect(closed).toBe(false);
    });

    it('registerDismiss covers in-screen panels without assigning a z-index', () => {
      const panel = makeEl();
      let closed = false;
      registerDismiss(panel, () => { closed = true; });
      expect(panel.style.zIndex).toBe('');

      expect(dismissTop()).toBe(true);
      expect(closed).toBe(true);

      release(panel);
      expect(dismissTop()).toBe(false);
    });
  });

  describe('keyboard focus', () => {
    function modalWithButtons(): { modal: HTMLElement; first: HTMLButtonElement; last: HTMLButtonElement } {
      const modal = makeEl();
      modal.innerHTML = '<button id="first"></button><button disabled></button><button id="last"></button>';
      return { modal, first: modal.querySelector('#first')!, last: modal.querySelector('#last')! };
    }

    function pressTab(shiftKey = false): KeyboardEvent {
      const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event;
    }

    function opener(): HTMLButtonElement {
      const button = document.createElement('button');
      document.body.appendChild(button);
      button.focus();
      return button;
    }

    it('moves focus from the opener into the modal once it can take it', async () => {
      const button = opener();
      const { modal } = modalWithButtons();
      bringToFront(modal, () => {});
      await Promise.resolve();

      expect(document.activeElement).toBe(modal);
      expect(modal.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).not.toBe(button);
      release(modal);
    });

    it('leaves focus alone when the modal focused itself', async () => {
      const { modal, last } = modalWithButtons();
      bringToFront(modal, () => {});
      last.focus();
      await Promise.resolve();

      expect(document.activeElement).toBe(last);
      release(modal);
    });

    it('keeps Tab inside the modal, in both directions', async () => {
      opener();
      const { modal, first, last } = modalWithButtons();
      bringToFront(modal, () => {});
      await Promise.resolve();

      expect(pressTab().defaultPrevented).toBe(false);
      last.focus();
      expect(pressTab().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
      expect(pressTab(true).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
      release(modal);
    });

    it('pulls a Tab that starts outside back in', async () => {
      const button = opener();
      const { modal, first } = modalWithButtons();
      bringToFront(modal, () => {});
      await Promise.resolve();
      button.focus();

      expect(pressTab().defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
      release(modal);
    });

    it('hands focus back to the opener on release', async () => {
      const button = opener();
      const { modal } = modalWithButtons();
      bringToFront(modal, () => {});
      await Promise.resolve();

      release(modal);
      expect(document.activeElement).toBe(button);
    });

    it('falls back to the modal underneath when the opener has gone', async () => {
      const lower = makeEl();
      bringToFront(lower, () => {});
      await Promise.resolve();
      const button = opener();
      const { modal } = modalWithButtons();
      bringToFront(modal, () => {});
      await Promise.resolve();
      button.remove();

      release(modal);
      expect(document.activeElement).toBe(lower);
      release(lower);
    });

    it('does not take focus back if something else was deliberately focused', async () => {
      const button = opener();
      const elsewhere = opener();
      const { modal } = modalWithButtons();
      bringToFront(modal, () => {});
      await Promise.resolve();
      elsewhere.focus();

      release(modal);
      expect(document.activeElement).toBe(elsewhere);
      expect(document.activeElement).not.toBe(button);
    });

    it('toasts, docked panels and opted-out panels never take focus', async () => {
      const button = opener();
      const toast = makeEl();
      bringToFront(toast);
      const docked = makeEl();
      registerDismiss(docked, () => {});
      const chat = makeEl();
      bringToFront(chat, () => {}, { holdFocus: false });
      await Promise.resolve();

      expect(document.activeElement).toBe(button);
      expect(pressTab().defaultPrevented).toBe(false);
      release(toast);
      release(docked);
      release(chat);
    });

    it('re-promoting on press keeps the opener to return to', async () => {
      const button = opener();
      const { modal } = modalWithButtons();
      bringToFront(modal, () => {});
      await Promise.resolve();
      bringToFront(modal);

      release(modal);
      expect(document.activeElement).toBe(button);
    });
  });

  describe('dismissModals', () => {
    it('closes every modal, newest first, and leaves docked panels', () => {
      const closed: string[] = [];
      const a = makeEl();
      const b = makeEl();
      const docked = makeEl();
      bringToFront(a, () => { closed.push('a'); release(a); });
      registerDismiss(docked, () => closed.push('docked'));
      bringToFront(b, () => { closed.push('b'); release(b); });

      dismissModals();
      expect(closed).toEqual(['b', 'a']);
      release(docked);
    });
  });
});
