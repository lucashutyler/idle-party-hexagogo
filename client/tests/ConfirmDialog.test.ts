import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmDialog } from '../src/ui/ConfirmDialog';
import { dismissTop } from '../src/ui/ModalStack';

const overlay = () => document.querySelector('.confirm-overlay') as HTMLElement | null;
const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();

describe('confirmDialog', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves true on confirm and removes itself', async () => {
    const result = confirmDialog({ title: 'Sure?', confirmLabel: 'Yes' });
    expect(document.querySelector('.confirm-ok')?.textContent).toBe('Yes');
    click('.confirm-ok');
    await expect(result).resolves.toBe(true);
    expect(overlay()).toBeNull();
  });

  it('resolves false on cancel', async () => {
    const result = confirmDialog({ title: 'Sure?' });
    click('.confirm-cancel');
    await expect(result).resolves.toBe(false);
  });

  it('resolves false from Back and Escape through the modal stack', async () => {
    const result = confirmDialog({ title: 'Sure?' });
    expect(dismissTop()).toBe(true);
    await expect(result).resolves.toBe(false);
    expect(dismissTop()).toBe(false);
  });

  it('resolves false from the backdrop only when the press began there', async () => {
    const result = confirmDialog({ title: 'Sure?' });
    const el = overlay()!;

    (document.querySelector('.confirm-title') as HTMLElement).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.click();
    expect(overlay()).not.toBeNull();

    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    el.click();
    await expect(result).resolves.toBe(false);
  });

  it('keeps its clicks from reaching document-level closers', async () => {
    const closer = vi.fn();
    document.addEventListener('click', closer);
    const result = confirmDialog({ title: 'Sure?' });
    click('.confirm-cancel');
    await result;
    document.removeEventListener('click', closer);
    expect(closer).not.toHaveBeenCalled();
  });

  it('escapes its text and marks danger', () => {
    void confirmDialog({ title: '<b>x</b>', body: '<i>y</i>', danger: true });
    expect(document.querySelector('.confirm-title')?.textContent).toBe('<b>x</b>');
    expect(document.querySelector('.confirm-body')?.textContent).toBe('<i>y</i>');
    expect(document.querySelector('.confirm-ok-danger')).not.toBeNull();
    dismissTop();
  });
});
