/** Open a modal overlay containing the given content. Returns the overlay element. */
export interface ModalHandle {
  overlay: HTMLDivElement;
  body: HTMLDivElement;
  close: () => void;
}

export function openModal(opts: {
  title: string;
  bodyHtml: string;
  width?: string;
  onClose?: () => void;
}): ModalHandle {
  const overlay = document.createElement('div');
  overlay.className = 'admin-modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'admin-modal';
  if (opts.width) modal.style.maxWidth = opts.width;

  modal.innerHTML = `
    <div class="admin-modal-header">
      <h3 class="admin-modal-title">${opts.title}</h3>
      <button class="admin-modal-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="admin-modal-body">${opts.bodyHtml}</div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  document.body.classList.add('admin-modal-open');

  const close = () => {
    overlay.remove();
    document.body.classList.remove('admin-modal-open');
    opts.onClose?.();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  modal.querySelector('.admin-modal-close')?.addEventListener('click', close);

  // Close on Escape
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      window.removeEventListener('keydown', onKey);
      close();
    }
  };
  window.addEventListener('keydown', onKey);

  const body = modal.querySelector<HTMLDivElement>('.admin-modal-body')!;
  return { overlay, body, close };
}

export function closeAllModals(): void {
  document.querySelectorAll('.admin-modal-overlay').forEach(el => el.remove());
  document.body.classList.remove('admin-modal-open');
}
