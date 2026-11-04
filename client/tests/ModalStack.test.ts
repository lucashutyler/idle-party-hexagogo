import { beforeEach, describe, expect, it } from 'vitest';
import { bringToFront, dismissTop, registerDismiss, release, wireFocusOnInteract } from '../src/ui/ModalStack';

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
});
