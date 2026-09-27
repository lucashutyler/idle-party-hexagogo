import { describe, expect, it } from 'vitest';
import { classIconHtml } from '@idle-party-rpg/shared';
import { placeholderInitials, placeholderUrl, renderAssetImg } from '../src/ui/assets';
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
  it('renderAssetImg falls back to generated art', () => {
    const html = renderAssetImg('class', 'Knight', { width: 120, height: 120 });
    expect(html).toContain("this.src='data:image/svg+xml");
    expect(html).not.toContain('placehold.co');
  });

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
