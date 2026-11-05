/**
 * Asset helpers for the "image-everywhere" convention.
 *
 * Convention: every entity kind serves art at `/<kind>-artwork/{id}.png`,
 * mirroring the existing `/item-artwork/{id}.png` pipeline. The kinds
 * themselves live in `shared/src/assets/AssetKinds.ts`, which the server's
 * static mounts and the admin upload API derive from as well. When art is
 * missing, the image falls back to generated offline art (`placeholderUrl`).
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

export interface PlaceholderOpts {
  w?: number;
  h?: number;
  /** Solid base colour (hex, `#` optional) instead of the hue picked from the label. */
  bg?: string;
  /** Text / scenery colour (hex, `#` optional). */
  fg?: string;
  /** Emoji or short text drawn instead of the label's initials. */
  glyph?: string;
}

const PLACEHOLDER_HUES = [212, 262, 350, 148, 42, 24, 188, 318];
const PLACEHOLDER_FONT = "'Lilita One','Arial Rounded MT Bold','Nunito','Arial Black',system-ui,sans-serif";
const SCENE_MIN_ASPECT = 1.6;

/**
 * Offline generated art for missing artwork: an inline SVG data URI whose colour is derived
 * deterministically from `label`. Square-ish sizes get a glossy tile with initials (or `glyph`);
 * wide sizes get a text-free landscape backdrop.
 */
export function placeholderUrl(label: string, opts?: PlaceholderOpts): string {
  const w = Math.max(1, Math.round(opts?.w ?? 256));
  const h = Math.max(1, Math.round(opts?.h ?? 256));
  const hue = PLACEHOLDER_HUES[hashString(label) % PLACEHOLDER_HUES.length];
  const base = normalizeHex(opts?.bg);
  const top = base ?? `hsl(${hue},72%,58%)`;
  const bottom = base ?? `hsl(${hue},62%,28%)`;
  const fg = normalizeHex(opts?.fg);
  const svg = w / h >= SCENE_MIN_ASPECT
    ? sceneSvg(w, h, top, bottom, fg ?? `hsl(${hue},45%,40%)`)
    : tileSvg(w, h, top, bottom, fg ?? '#ffffff', opts?.glyph ?? placeholderInitials(label));
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** One letter for a single word, the first letters of the first two words otherwise. */
export function placeholderInitials(label: string): string {
  const [a, b] = label.match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = (word: string) => (Array.from(word)[0] ?? '').toUpperCase();
  if (!a) return '?';
  return b ? first(a) + first(b) : first(a);
}

function tileSvg(w: number, h: number, top: string, bottom: string, fg: string, text: string): string {
  const m = Math.min(w, h);
  const r = round(m * 0.18);
  const edge = Math.max(1, round(m * 0.03));
  const glyphLen = Array.from(text).length;
  const size = round(m * (glyphLen <= 1 ? 0.54 : glyphLen === 2 ? 0.42 : 0.3));
  const shadow = Math.max(1, round(size * 0.06));
  const t = escapeXml(text);
  const textAttrs = `x="${w / 2}" y="${round(h / 2 + size * 0.05)}" text-anchor="middle" dominant-baseline="central" font-family="${PLACEHOLDER_FONT}" font-size="${size}" font-weight="900"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + '<defs>'
    + `<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`
    + '<radialGradient id="l" cx=".5" cy=".38" r=".62"><stop offset="0" stop-color="#fff" stop-opacity=".26"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>'
    + '<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".32"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
    + '</defs>'
    + `<rect width="${w}" height="${h}" rx="${r}" fill="url(#b)"/>`
    + `<rect width="${w}" height="${h}" rx="${r}" fill="url(#l)"/>`
    + `<rect x="${edge}" y="${edge}" width="${w - edge * 2}" height="${round(h * 0.46)}" rx="${Math.max(0, r - edge)}" fill="url(#s)"/>`
    + `<rect x="${edge / 2}" y="${edge / 2}" width="${w - edge}" height="${h - edge}" rx="${Math.max(0, r - edge / 2)}" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="${edge}"/>`
    + `<text ${textAttrs} dy="${shadow}" fill="#060918" fill-opacity=".38">${t}</text>`
    + `<text ${textAttrs} fill="${fg}">${t}</text>`
    + '</svg>';
}

function sceneSvg(w: number, h: number, top: string, bottom: string, hill: string): string {
  const far = `M0 ${round(h * 0.62)} C${round(w * 0.18)} ${round(h * 0.5)} ${round(w * 0.32)} ${round(h * 0.56)} ${round(w * 0.5)} ${round(h * 0.6)} S${round(w * 0.82)} ${round(h * 0.46)} ${w} ${round(h * 0.56)} V${h} H0Z`;
  const near = `M0 ${round(h * 0.8)} C${round(w * 0.22)} ${round(h * 0.7)} ${round(w * 0.45)} ${round(h * 0.84)} ${round(w * 0.66)} ${round(h * 0.76)} S${round(w * 0.9)} ${round(h * 0.7)} ${w} ${round(h * 0.78)} V${h} H0Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMax slice">`
    + '<defs>'
    + `<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`
    + '<radialGradient id="l" cx=".5" cy=".2" r=".7"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>'
    + '<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#060918" stop-opacity="0"/><stop offset="1" stop-color="#060918" stop-opacity=".55"/></linearGradient>'
    + '</defs>'
    + `<rect width="${w}" height="${h}" fill="url(#b)"/>`
    + `<rect width="${w}" height="${h}" fill="url(#l)"/>`
    + `<path d="${far}" fill="${hill}" fill-opacity=".45"/>`
    + `<path d="${near}" fill="${hill}" fill-opacity=".85"/>`
    + `<rect width="${w}" height="${h}" fill="url(#v)"/>`
    + '</svg>';
}

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalizeHex(color: string | undefined): string | null {
  if (!color) return null;
  const hex = color.replace('#', '');
  return /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex) ? `#${hex}` : null;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
}

export interface AssetImgOpts {
  /** Label the generated fallback art derives its initials and colour from. */
  label?: string;
  /** Emoji drawn on the generated fallback instead of initials. */
  glyph?: string;
  /** Extra CSS class on the <img>. */
  className?: string;
  /** Inline style additions. */
  style?: string;
  /** alt text. */
  alt?: string;
  /** Size of the generated fallback art. */
  width?: number;
  height?: number;
}

/**
 * `<img>` for the real artwork, falling back to generated art, then to the slot's background.
 * Outcomes are remembered per URL, so a re-render skips straight to whatever loaded last time.
 */
export function renderAssetImg(kind: AssetKind, id: string, opts?: AssetImgOpts): string {
  const label = opts?.label ?? id;
  return renderTrackedImg(artworkUrl(kind, id), {
    className: opts?.className,
    style: opts?.style,
    alt: opts?.alt ?? label,
    fallback: placeholderUrl(label, { w: opts?.width, h: opts?.height, glyph: opts?.glyph }),
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
let missingAssetRetries = 0;

/**
 * `<img>` that starts hidden and reveals on load (`.asset-loaded`, plus `.has-art` on its parent), or hides on failure (`.asset-failed`).
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

export function isAssetLoaded(src: string): boolean {
  return loadedUrls.has(src);
}

/** `renderTrackedImg` markup minus what changes once an image loads: the DOM is already up to date on that, so it isn't worth a rewrite. */
export function withoutArtLoadState(html: string): string {
  return html.replace(/ asset-loaded| loading="lazy" decoding="async"/g, '');
}

/** Forget art that failed to load, so newly uploaded art is tried again. */
export function forgetMissingAssets(): void {
  if (missingUrls.size > 0) missingAssetRetries++;
  missingUrls.clear();
}

/** Goes up when art that had failed may now load, for markup cached behind a key. */
export function missingAssetRetryCount(): number {
  return missingAssetRetries;
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
  img.parentElement?.classList.add('has-art');
}

function onAssetError(e: Event): void {
  const img = trackedImg(e);
  if (!img) return;
  const src = img.getAttribute('src') ?? '';
  missingUrls.add(src);
  loadedUrls.delete(src);
  img.classList.remove('asset-loaded');
  img.parentElement?.classList.remove('has-art');
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
