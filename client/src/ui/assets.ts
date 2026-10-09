/**
 * Asset helpers for the "image-everywhere" convention.
 *
 * Convention: every entity kind serves art at `/<kind>-artwork/{id}.png`,
 * mirroring the existing `/item-artwork/{id}.png` pipeline. The kinds
 * themselves live in `shared/src/assets/AssetKinds.ts`, which the server's
 * static mounts and the admin upload API derive from as well. When art is
 * missing, the image falls back to a placehold.co URL so the layout still
 * looks like art is there. Background-color-only fallback is reserved for
 * places where we deliberately want a tinted swatch instead of a placeholder.
 */

import { assetPublicPath } from '@idle-party-rpg/shared';
import type { AssetKind } from '@idle-party-rpg/shared';

export type { AssetKind };

/**
 * Real artwork URL. The mount per kind comes from the shared `ASSET_KIND_INFO`
 * registry rather than being spelled `/${kind}-artwork/` here, because the
 * icon sets (`class-icon`, `slot-icon`, `nav-icon`) predate that convention
 * and serve from their own paths.
 */
export function artworkUrl(kind: AssetKind, id: string): string {
  return assetPublicPath(kind, id);
}

/** placehold.co fallback. Keeps text short to stay readable in small slots. */
export function placeholderUrl(label: string, opts?: { w?: number; h?: number; bg?: string; fg?: string }): string {
  const w = opts?.w ?? 256;
  const h = opts?.h ?? 256;
  const bg = (opts?.bg ?? '2a2a40').replace('#', '');
  const fg = (opts?.fg ?? 'e8e8e8').replace('#', '');
  const safe = label.replace(/[^A-Za-z0-9 ]/g, '').slice(0, 18) || '?';
  return `https://placehold.co/${w}x${h}/${bg}/${fg}/png?text=${encodeURIComponent(safe)}`;
}

export interface AssetImgOpts {
  /** Display label used for the placehold.co fallback. */
  label?: string;
  /** Extra CSS class on the <img>. */
  className?: string;
  /** Inline style additions. */
  style?: string;
  /** alt text. */
  alt?: string;
  /** Background color visible if the placehold.co request also fails. */
  fallbackBg?: string;
  /** Sizing hints for the placehold.co fallback. */
  width?: number;
  height?: number;
}

/**
 * `<img>` for the real artwork, falling back to a placehold.co image, then to the slot's background.
 * Outcomes are remembered per URL, so a re-render skips straight to whatever loaded last time.
 */
export function renderAssetImg(kind: AssetKind, id: string, opts?: AssetImgOpts): string {
  const label = opts?.label ?? id;
  return renderTrackedImg(artworkUrl(kind, id), {
    className: opts?.className,
    style: opts?.style,
    alt: opts?.alt ?? label,
    fallback: placeholderUrl(label, { w: opts?.width, h: opts?.height }),
    lazy: true,
  });
}

export interface TrackedImgOpts {
  className?: string;
  style?: string;
  alt?: string;
  /** Tried once when `src` fails. */
  fallback?: string;
  lazy?: boolean;
}

const missingUrls = new Set<string>();
const loadedUrls = new Set<string>();
let tracking = false;

/**
 * `<img>` that starts hidden and reveals on load (`.asset-loaded`), or hides on failure (`.asset-failed`).
 * Returns '' when every source is already known to be missing, so callers' own placeholders show alone.
 */
export function renderTrackedImg(src: string, opts: TrackedImgOpts = {}): string {
  trackAssetImages();
  const fallback = opts.fallback && !missingUrls.has(opts.fallback) ? opts.fallback : '';
  const url = missingUrls.has(src) ? fallback : src;
  if (!url) return '';
  const loaded = loadedUrls.has(url);
  const cls = ['asset-img', loaded ? 'asset-loaded' : '', opts.className ?? ''].filter(Boolean).join(' ');
  const fb = url === src && fallback ? ` data-fallback="${escapeAttr(fallback)}"` : '';
  const style = opts.style ? ` style="${escapeAttr(opts.style)}"` : '';
  const lazy = opts.lazy && !loaded ? ' loading="lazy" decoding="async"' : '';
  return `<img class="${escapeAttr(cls)}" src="${escapeAttr(url)}"${fb}${style} alt="${escapeAttr(opts.alt ?? '')}"${lazy} />`;
}

/** Forget art that failed to load, so newly uploaded art is tried again. */
export function forgetMissingAssets(): void {
  missingUrls.clear();
}

function trackAssetImages(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  // Image load/error events don't bubble, but capture-phase listeners on document still see them.
  document.addEventListener('load', onAssetLoad, true);
  document.addEventListener('error', onAssetError, true);
}

function trackedImg(e: Event): HTMLImageElement | null {
  const t = e.target;
  return t instanceof HTMLImageElement && t.classList.contains('asset-img') ? t : null;
}

function onAssetLoad(e: Event): void {
  const img = trackedImg(e);
  if (!img) return;
  loadedUrls.add(img.getAttribute('src') ?? '');
  img.classList.add('asset-loaded');
}

function onAssetError(e: Event): void {
  const img = trackedImg(e);
  if (!img) return;
  const src = img.getAttribute('src') ?? '';
  missingUrls.add(src);
  loadedUrls.delete(src);
  img.classList.remove('asset-loaded');
  const fallback = img.dataset.fallback;
  if (fallback && !missingUrls.has(fallback)) {
    delete img.dataset.fallback;
    img.src = fallback;
    return;
  }
  img.classList.add('asset-failed');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
