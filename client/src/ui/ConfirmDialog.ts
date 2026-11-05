import { escapeHtml } from './ItemIcon';
import { bringToFront, release } from './ModalStack';

export interface ConfirmDialogOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Resolves true on confirm; false on cancel, the backdrop, Back or Escape. */
export function confirmDialog(opts: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="${escapeHtml(opts.title)}">
        <div class="confirm-title">${escapeHtml(opts.title)}</div>
        ${opts.body ? `<div class="confirm-body">${escapeHtml(opts.body)}</div>` : ''}
        <div class="confirm-actions">
          <button type="button" class="pixel-btn confirm-cancel">${escapeHtml(opts.cancelLabel ?? 'Cancel')}</button>
          <button type="button" class="pixel-btn confirm-ok${opts.danger ? ' confirm-ok-danger' : ''}">${escapeHtml(opts.confirmLabel ?? 'Confirm')}</button>
        </div>
      </div>
    `;

    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      release(overlay);
      overlay.remove();
      resolve(result);
    };

    let pressedBackdrop = false;
    overlay.addEventListener('pointerdown', (e) => { pressedBackdrop = e.target === overlay; });
    // Stays inside the dialog so document-level closers leave the panel that asked alone.
    overlay.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target === overlay && pressedBackdrop) finish(false);
    });
    overlay.querySelector('.confirm-cancel')!.addEventListener('click', () => finish(false));
    overlay.querySelector('.confirm-ok')!.addEventListener('click', () => finish(true));

    document.body.appendChild(overlay);
    bringToFront(overlay, () => finish(false));
    overlay.querySelector<HTMLElement>('.confirm-cancel')!.focus({ preventScroll: true });
  });
}
