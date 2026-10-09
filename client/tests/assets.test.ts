import { describe, it, expect, beforeEach } from 'vitest';
import * as assets from '../src/ui/assets';

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
    const img = mount(assets.renderTrackedImg('/item-artwork/a0.png', { fallback: '/fb0.png', className: 'x' }));
    expect(img.getAttribute('src')).toBe('/item-artwork/a0.png');
    expect(img.dataset.fallback).toBe('/fb0.png');
    expect(img.classList.contains('asset-img')).toBe(true);
    expect(img.classList.contains('x')).toBe(true);
    expect(img.classList.contains('asset-loaded')).toBe(false);
  });

  it('remembers a loaded source and renders it already visible', () => {
    const img = mount(assets.renderTrackedImg('/a1.png', { lazy: true }));
    img.dispatchEvent(new Event('load'));
    expect(img.classList.contains('asset-loaded')).toBe(true);
    const again = mount(assets.renderTrackedImg('/a1.png', { lazy: true }));
    expect(again.classList.contains('asset-loaded')).toBe(true);
    expect(again.hasAttribute('loading')).toBe(false);
  });

  it('swaps to the fallback on error and starts there next time', () => {
    const img = mount(assets.renderTrackedImg('/a2.png', { fallback: '/fb2.png' }));
    img.dispatchEvent(new Event('error'));
    expect(img.getAttribute('src')).toBe('/fb2.png');
    const again = mount(assets.renderTrackedImg('/a2.png', { fallback: '/fb2.png' }));
    expect(again.getAttribute('src')).toBe('/fb2.png');
    expect(again.dataset.fallback).toBeUndefined();
  });

  it('marks the image failed when every source fails, then renders nothing', () => {
    const img = mount(assets.renderTrackedImg('/a3.png', { fallback: '/fb3.png' }));
    img.dispatchEvent(new Event('error'));
    img.dispatchEvent(new Event('error'));
    expect(img.classList.contains('asset-failed')).toBe(true);
    expect(assets.renderTrackedImg('/a3.png', { fallback: '/fb3.png' })).toBe('');
    expect(assets.renderTrackedImg('/a3.png')).toBe('');
  });

  it('tries a missing source again after forgetMissingAssets', () => {
    const img = mount(assets.renderTrackedImg('/a4.png'));
    img.dispatchEvent(new Event('error'));
    expect(assets.renderTrackedImg('/a4.png')).toBe('');
    assets.forgetMissingAssets();
    expect(mount(assets.renderTrackedImg('/a4.png')).getAttribute('src')).toBe('/a4.png');
  });

  it('ignores images it did not render', () => {
    const img = mount('<img src="/a.png">');
    img.dispatchEvent(new Event('error'));
    expect(assets.renderTrackedImg('/a5.png')).not.toBe('');
  });

  it('escapes attribute values', () => {
    const img = mount(assets.renderTrackedImg('/a6.png', { alt: 'Say "hi" <b>', style: 'width:1px;"' }));
    expect(img.getAttribute('alt')).toBe('Say "hi" <b>');
    expect(img.getAttribute('style')).toBe('width:1px;"');
  });
});

describe('renderAssetImg', () => {
  it('uses the artwork URL with a placeholder fallback', () => {
    const img = mount(assets.renderAssetImg('shop', 'smithy', { label: 'Smithy', className: 'icon' }));
    expect(img.getAttribute('src')).toBe(assets.artworkUrl('shop', 'smithy'));
    expect(img.dataset.fallback).toContain('placehold.co');
    expect(img.getAttribute('alt')).toBe('Smithy');
    expect(img.getAttribute('loading')).toBe('lazy');
  });
});
