/**
 * Reusable "Artwork" section for any CRM admin edit modal — PNG upload +
 * delete + live preview, all driven by the generic
 * `/api/admin/assets/:kind/:id` server endpoint.
 *
 * Caller workflow:
 *   1. Inject the HTML returned by `renderArtworkSection({ kind, id })` into
 *      the modal's body (typically inside a fieldset).
 *   2. After the modal is mounted, call `wireArtworkSection(root, opts)` once
 *      to attach the upload/remove click handlers.
 *
 * `kind` is any of the shared registry's `MANAGED_ASSET_KINDS`, which also
 * drive the server's static mounts and the `/api/admin/assets` endpoints.
 * Kinds listed in `DEFERRED_ASSET_KINDS` have no working endpoint yet and are
 * excluded by the type.
 */

import { assetPublicPath } from '@idle-party-rpg/shared';
import type { ManagedAssetKind } from '@idle-party-rpg/shared';

export interface ArtworkSectionOpts {
  /**
   * Server kind id — picks the folder. Restricted to the kinds the assets API
   * manages, so wiring an uploader to a deferred kind is a compile error rather
   * than a modal that 400s when the admin clicks Upload.
   */
  kind: ManagedAssetKind;
  /** The entity id whose artwork is being edited. Empty for unsaved entities. */
  id: string;
  /** DOM id prefix so multiple sections can coexist; defaults to `if-art-${kind}`. */
  idPrefix?: string;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function publicArtworkUrl(kind: ManagedAssetKind, id: string): string {
  return assetPublicPath(kind, id);
}

/** HTML for the artwork upload section. Caller wraps in a fieldset/legend. */
export function renderArtworkSection(opts: ArtworkSectionOpts): string {
  const prefix = opts.idPrefix ?? `if-art-${opts.kind}`;
  const preview = opts.id
    ? `<img src="${publicArtworkUrl(opts.kind, opts.id)}" class="admin-art-preview"
              onerror="this.style.display='none'" data-artwork-preview>`
    : `<div class="admin-art-preview-empty">No artwork yet — save first to enable upload.</div>`;
  return `
    <input type="hidden" data-artwork-id value="${escapeAttr(opts.id)}">
    <input type="hidden" data-artwork-kind value="${opts.kind}">
    ${preview}
    <input type="file" id="${prefix}-file" accept="image/png">
    <div class="admin-modal-actions">
      <button class="admin-btn admin-btn-sm" id="${prefix}-upload" type="button">Upload</button>
      <button class="admin-btn admin-btn-sm admin-btn-danger" id="${prefix}-remove" type="button">Remove Artwork</button>
    </div>
  `;
}

/** Wire upload/remove handlers. Call once per modal after the body is mounted. */
export function wireArtworkSection(root: HTMLElement, opts: ArtworkSectionOpts): void {
  const prefix = opts.idPrefix ?? `if-art-${opts.kind}`;
  root.querySelector(`#${prefix}-upload`)?.addEventListener('click', () => uploadArtwork(root, opts));
  root.querySelector(`#${prefix}-remove`)?.addEventListener('click', () => removeArtwork(root, opts));
}

async function uploadArtwork(root: HTMLElement, opts: ArtworkSectionOpts): Promise<void> {
  const id = currentId(root, opts);
  if (!id) { alert(`Save the ${opts.kind} first before uploading artwork.`); return; }
  const prefix = opts.idPrefix ?? `if-art-${opts.kind}`;
  const fileInput = root.querySelector(`#${prefix}-file`) as HTMLInputElement | null;
  if (!fileInput?.files?.length) { alert('Select a PNG file first.'); return; }
  const formData = new FormData();
  formData.append('artwork', fileInput.files[0]);
  try {
    const res = await fetch(`/api/admin/assets/${opts.kind}/${encodeURIComponent(id)}`, {
      method: 'POST', credentials: 'include', body: formData,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Failed to upload artwork');
      return;
    }
    alert('Artwork uploaded successfully.');
    // The response carries the stored file's URL already stamped with its
    // write time, so the preview refreshes without a cache-busting guess.
    const data = await res.json().catch(() => ({}));
    const preview = root.querySelector('[data-artwork-preview]') as HTMLImageElement | null;
    if (preview) {
      preview.src = data?.asset?.url ?? `${publicArtworkUrl(opts.kind, id)}?t=${Date.now()}`;
      preview.style.display = '';
    }
  } catch {
    alert('Network error uploading artwork.');
  }
}

async function removeArtwork(root: HTMLElement, opts: ArtworkSectionOpts): Promise<void> {
  const id = currentId(root, opts);
  if (!id) return;
  if (!confirm(`Remove artwork for this ${opts.kind}?`)) return;
  try {
    const res = await fetch(`/api/admin/assets/${opts.kind}/${encodeURIComponent(id)}`, {
      method: 'DELETE', credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Failed to remove artwork');
      return;
    }
    alert('Artwork removed.');
    const preview = root.querySelector('[data-artwork-preview]') as HTMLImageElement | null;
    if (preview) preview.style.display = 'none';
  } catch {
    alert('Network error removing artwork.');
  }
}

function currentId(root: HTMLElement, opts: ArtworkSectionOpts): string {
  // The hidden id input is preferred so callers can update it after save;
  // fall back to the original opts.id if present.
  const hidden = root.querySelector('[data-artwork-id]') as HTMLInputElement | null;
  return hidden?.value.trim() || opts.id;
}
