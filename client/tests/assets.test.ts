import { beforeEach, describe, expect, it } from 'vitest';
import { classIconHtml } from '@idle-party-rpg/shared';
import {
  artworkUrl,
  forgetMissingAssets,
  isAssetLoaded,
  placeholderInitials,
  placeholderUrl,
  renderAssetImg,
  renderTrackedImg,
} from '../src/ui/assets';
import { renderEmptySlotIcon } from '../src/ui/ItemIcon';

const PREFIX = 'data:image/svg+xml;charset=utf-8,';

function decodeSvg(url: string): string {
  expect(url.startsWith(PREFIX)).toBe(true);
  return decodeURIComponent(url.slice(PREFIX.length));
}

function parseSvg(url: string): SVGElement {
  const host = document.createElement('div');
  host.innerHTML = decodeSvg(url);
  expect(host.children).toHaveLength(1);
  const svg = host.querySelector('svg');
  expect(svg).not.toBeNull();
  return svg!;
}

describe('placeholderUrl', () => {
  it('is deterministic per label', () => {
    expect(placeholderUrl('Goblin', { w: 160, h: 160 })).toBe(placeholderUrl('Goblin', { w: 160, h: 160 }));
  });

  it('derives the colour from the label', () => {
    const fills = new Set(['Goblin', 'Knight', 'Bandit Cutthroat', 'Mage', 'Slime', 'Wolf'].map(label => {
      const stop = parseSvg(placeholderUrl(label)).querySelector('stop');
      return stop?.getAttribute('stop-color');
    }));
    expect(fills.size).toBeGreaterThan(1);
  });

  it('returns an offline SVG data URI with the requested size', () => {
    const url = placeholderUrl('Goblin Shaman', { w: 96, h: 120 });
    expect(url).not.toContain('placehold.co');
    const svg = parseSvg(url);
    expect(svg.getAttribute('width')).toBe('96');
    expect(svg.getAttribute('height')).toBe('120');
    expect(svg.textContent).toContain('GS');
  });

  it('never emits characters that break inline handlers or CSS url()', () => {
    const url = placeholderUrl(`<b>"it's" (x) & y</b>`, { w: 64, h: 64 });
    expect(url).not.toMatch(/['"<>()\s]/);
  });

  it('escapes the label inside the SVG', () => {
    const svg = decodeSvg(placeholderUrl('x', { glyph: '<&>' }));
    expect(svg).toContain('&lt;&amp;&gt;');
    expect(svg).not.toContain('<&>');
  });

  it('draws a glyph instead of initials when given one', () => {
    expect(parseSvg(placeholderUrl('Settings', { glyph: '⚙️' })).textContent).toContain('⚙️');
  });

  it('honours explicit colours and drops text on wide backdrops', () => {
    const svg = decodeSvg(placeholderUrl('Hatchetmill', { w: 800, h: 400, bg: '18234d', fg: '#304186' }));
    expect(svg).toContain('#18234d');
    expect(svg).toContain('#304186');
    expect(svg).not.toContain('<text');
  });

  it('ignores malformed colour overrides', () => {
    expect(decodeSvg(placeholderUrl('x', { bg: 'red;"><script>' }))).not.toContain('script');
  });
});

describe('placeholderInitials', () => {
  it('uses one letter for one word and two for several', () => {
    expect(placeholderInitials('goblin')).toBe('G');
    expect(placeholderInitials('goblin shaman king')).toBe('GS');
    expect(placeholderInitials('  --  ')).toBe('?');
    expect(placeholderInitials('élan vital')).toBe('ÉV');
  });
});

describe('fallback wiring', () => {
  it('classIconHtml swaps a missing icon for its class glyph', () => {
    const host = document.createElement('div');
    host.innerHTML = classIconHtml('Knight');
    const img = host.querySelector('img')!;
    new Function(img.getAttribute('onerror')!).call(img);
    const glyph = host.querySelector('.icon-glyph');
    expect(glyph?.textContent).toBe('🛡️');
    expect(glyph?.classList.contains('icon-class')).toBe(true);
    expect(host.innerHTML).not.toContain('placehold.co');
  });

  it('empty equipment slots show a slot glyph', () => {
    const html = renderEmptySlotIcon('ring');
    expect(html).toContain('item-slot-ghost-glyph');
    expect(html).toContain('💍');
  });
});

// Outcomes are module-wide and only missing ones can be forgotten, so each test uses its own URLs.
beforeEach(() => {
  document.body.innerHTML = '';
});

function mount(html: string): HTMLImageElement {
  document.body.innerHTML = html;
  return document.body.querySelector('img')!;
}

describe('renderTrackedImg', () => {
  it('starts hidden on the real source with the fallback attached', () => {
    const img = mount(renderTrackedImg('/item-artwork/a0.png', { fallback: '/fb0.png', className: 'x' }));
    expect(img.getAttribute('src')).toBe('/item-artwork/a0.png');
    expect(img.dataset.fallback).toBe('/fb0.png');
    expect(img.classList.contains('asset-img')).toBe(true);
    expect(img.classList.contains('x')).toBe(true);
    expect(img.classList.contains('asset-loaded')).toBe(false);
  });

  it('remembers a loaded source and renders it already visible', () => {
    const img = mount(renderTrackedImg('/a1.png', { lazy: true }));
    img.dispatchEvent(new Event('load'));
    expect(img.classList.contains('asset-loaded')).toBe(true);
    const again = mount(renderTrackedImg('/a1.png', { lazy: true }));
    expect(again.classList.contains('asset-loaded')).toBe(true);
    expect(again.hasAttribute('loading')).toBe(false);
  });

  it('swaps to the fallback on error and starts there next time', () => {
    const img = mount(renderTrackedImg('/a2.png', { fallback: '/fb2.png' }));
    img.dispatchEvent(new Event('error'));
    expect(img.getAttribute('src')).toBe('/fb2.png');
    const again = mount(renderTrackedImg('/a2.png', { fallback: '/fb2.png' }));
    expect(again.getAttribute('src')).toBe('/fb2.png');
    expect(again.dataset.fallback).toBeUndefined();
  });

  it('marks the image failed when every source fails, then renders nothing', () => {
    const img = mount(renderTrackedImg('/a3.png', { fallback: '/fb3.png' }));
    img.dispatchEvent(new Event('error'));
    img.dispatchEvent(new Event('error'));
    expect(img.classList.contains('asset-failed')).toBe(true);
    expect(renderTrackedImg('/a3.png', { fallback: '/fb3.png' })).toBe('');
    expect(renderTrackedImg('/a3.png')).toBe('');
  });

  it('tries a missing source again after forgetMissingAssets', () => {
    const img = mount(renderTrackedImg('/a4.png'));
    img.dispatchEvent(new Event('error'));
    expect(renderTrackedImg('/a4.png')).toBe('');
    forgetMissingAssets();
    expect(mount(renderTrackedImg('/a4.png')).getAttribute('src')).toBe('/a4.png');
  });

  it('ignores images it did not render', () => {
    const img = mount('<img src="/untracked.png">');
    img.dispatchEvent(new Event('error'));
    expect(img.classList.contains('asset-failed')).toBe(false);
    expect(renderTrackedImg('/untracked.png')).not.toBe('');
  });

  it('drops a remembered success when the same source later fails', () => {
    mount(renderTrackedImg('/flaky.png')).dispatchEvent(new Event('load'));
    const img = mount(renderTrackedImg('/flaky.png', { fallback: '/flaky-fb.png' }));
    expect(img.classList.contains('asset-loaded')).toBe(true);

    img.dispatchEvent(new Event('error'));
    expect(img.classList.contains('asset-loaded')).toBe(false);
    expect(img.getAttribute('src')).toBe('/flaky-fb.png');

    forgetMissingAssets();
    expect(mount(renderTrackedImg('/flaky.png')).classList.contains('asset-loaded')).toBe(false);
  });

  it('escapes attribute values', () => {
    const img = mount(renderTrackedImg('/a6.png', { alt: 'Say "hi" <b>', style: 'width:1px;"' }));
    expect(img.getAttribute('alt')).toBe('Say "hi" <b>');
    expect(img.getAttribute('style')).toBe('width:1px;"');
  });
});

describe('renderAssetImg', () => {
  it('uses the artwork URL with a generated offline fallback', () => {
    const img = mount(renderAssetImg('shop', 'smithy', { label: 'Smithy', className: 'icon' }));
    expect(img.getAttribute('src')).toBe(artworkUrl('shop', 'smithy'));
    expect(img.dataset.fallback?.startsWith(PREFIX)).toBe(true);
    expect(img.dataset.fallback).not.toContain('placehold.co');
    expect(img.getAttribute('alt')).toBe('Smithy');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('draws the requested glyph on the fallback', () => {
    const img = mount(renderAssetImg('shop', 'glyph_shop', { label: 'Smithy', glyph: '⚒️' }));
    expect(decodeSvg(img.dataset.fallback!)).toContain('⚒️');
  });

  it('swaps to the generated art when the artwork is missing', () => {
    const img = mount(renderAssetImg('shop', 'missing_shop', { label: 'Smithy' }));
    img.dispatchEvent(new Event('error'));
    expect(img.getAttribute('src')?.startsWith(PREFIX)).toBe(true);
    expect(img.classList.contains('asset-failed')).toBe(false);
    const again = mount(renderAssetImg('shop', 'missing_shop', { label: 'Smithy' }));
    expect(again.getAttribute('src')?.startsWith(PREFIX)).toBe(true);
  });
});

describe('art presence on the parent', () => {
  it('marks the parent while the art is showing', () => {
    document.body.innerHTML = `<span>${renderTrackedImg('/p1.png')}</span>`;
    const img = document.body.querySelector('img')!;
    expect(isAssetLoaded('/p1.png')).toBe(false);
    img.dispatchEvent(new Event('load'));
    expect(img.parentElement?.classList.contains('has-art')).toBe(true);
    expect(isAssetLoaded('/p1.png')).toBe(true);
    img.dispatchEvent(new Event('error'));
    expect(img.parentElement?.classList.contains('has-art')).toBe(false);
    expect(isAssetLoaded('/p1.png')).toBe(false);
  });

  it('renders loaded slot art with its glyph already hidden', () => {
    mount(renderEmptySlotIcon('necklace')).dispatchEvent(new Event('load'));
    document.body.innerHTML = renderEmptySlotIcon('necklace');
    expect(document.querySelector('.item-slot-ghost')?.classList.contains('has-art')).toBe(true);
    expect(document.querySelector('img')?.classList.contains('asset-loaded')).toBe(true);
  });

  it('renders only the glyph once slot art is known to be missing', () => {
    mount(renderEmptySlotIcon('back')).dispatchEvent(new Event('error'));
    document.body.innerHTML = renderEmptySlotIcon('back');
    expect(document.querySelector('.item-slot-ghost img')).toBeNull();
    expect(document.querySelector('.item-slot-ghost-glyph')?.textContent).toBe('🧥');
  });
});
