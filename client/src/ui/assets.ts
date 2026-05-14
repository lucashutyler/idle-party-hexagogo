/**
 * Asset helpers for the "image-everywhere" convention.
 *
 * Convention: every entity kind serves art at `/<kind>-artwork/{id}.png`,
 * mirroring the existing `/item-artwork/{id}.png` pipeline. When art is
 * missing, the image falls back to a placehold.co URL so the layout still
 * looks like art is there. Background-color-only fallback is reserved for
 * places where we deliberately want a tinted swatch instead of a placeholder.
 */

export type AssetKind =
  | 'item'
  | 'monster'
  | 'zone'
  | 'tile'
  | 'tile-type'
  | 'class'
  | 'set'
  | 'shop'
  | 'logo'
  | 'parchment'
  | 'combat-bg'
  | 'room-bg';

/** Real artwork URL — same convention as the existing item-artwork path. */
export function artworkUrl(kind: AssetKind, id: string): string {
  return `/${kind}-artwork/${encodeURIComponent(id)}.png`;
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
 * Render an `<img>` HTML string that loads the real artwork first, then
 * falls back to a placehold.co URL on error. The img starts at opacity:0
 * and only reveals on successful load (whether real or fallback) so the
 * browser's broken-image glyph never flashes between a 404 and the
 * fallback completing. Callers should size the slot via CSS (className)
 * or inline style so the layout space is preserved while loading.
 */
export function renderAssetImg(kind: AssetKind, id: string, opts?: AssetImgOpts): string {
  const real = artworkUrl(kind, id);
  const label = opts?.label ?? id;
  const fallback = placeholderUrl(label, { w: opts?.width, h: opts?.height });
  const cls = opts?.className ? ` class="${opts.className}"` : '';
  // Prepend opacity:0 to any caller-provided inline style. onload below
  // restores opacity once the (real or fallback) image is in.
  const inlineStyle = `opacity:0;${opts?.style ?? ''}`;
  const alt = opts?.alt ?? label;
  // Fallback chain: real → placehold.co → hide the img (background color shows through).
  const onerror = `if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${fallback}';}else{this.style.display='none';}`;
  const onload = `this.style.opacity='1'`;
  return `<img${cls} style="${inlineStyle}" src="${real}" alt="${escapeAttr(alt)}" onload="${onload}" onerror="${onerror}" loading="lazy" decoding="async" />`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Best-effort URL for an entity image with placehold.co fallback baked in. Useful for `background-image: url(...)` style sites. */
export function assetUrlWithFallback(kind: AssetKind, id: string, label?: string, w = 512, h = 512): string {
  return artworkUrl(kind, id) + `?_fb=${encodeURIComponent(placeholderUrl(label ?? id, { w, h }))}`;
}
