import { describe, it, expect } from 'vitest';
import {
  ASSET_KINDS,
  ASSET_KIND_INFO,
  MANAGED_ASSET_KINDS,
  DEFERRED_ASSET_KINDS,
  isAssetKind,
  isManagedAssetKind,
  isDeferredAssetKind,
  isValidAssetId,
  assetPublicPath,
  canonicalAssetId,
} from '../src/index.js';

describe('asset kind registry', () => {
  it('splits every kind into exactly one of managed or deferred', () => {
    // The guard behind the registry: a kind added to ASSET_KINDS without being
    // classified would silently be invisible to both the API and the docs.
    const managed = new Set<string>(MANAGED_ASSET_KINDS);
    const deferred = new Set<string>(DEFERRED_ASSET_KINDS);

    for (const kind of ASSET_KINDS) {
      expect(managed.has(kind) || deferred.has(kind), `"${kind}" is neither managed nor deferred`).toBe(true);
      expect(managed.has(kind) && deferred.has(kind), `"${kind}" is both managed and deferred`).toBe(false);
    }
    expect(managed.size + deferred.size).toBe(ASSET_KINDS.length);
  });

  it('only lists real kinds as managed or deferred', () => {
    for (const kind of [...MANAGED_ASSET_KINDS, ...DEFERRED_ASSET_KINDS]) {
      expect(isAssetKind(kind)).toBe(true);
    }
  });

  it('gives every kind a distinct folder and mount', () => {
    const dirs = ASSET_KINDS.map(kind => ASSET_KIND_INFO[kind].dir);
    const mounts = ASSET_KINDS.map(kind => ASSET_KIND_INFO[kind].mount);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(new Set(mounts).size).toBe(mounts.length);
    for (const mount of mounts) expect(mount.startsWith('/')).toBe(true);
  });

  it('points every declared fallback at a kind that exists', () => {
    for (const kind of ASSET_KINDS) {
      for (const fallback of ASSET_KIND_INFO[kind].fallbacks ?? []) {
        expect(isAssetKind(fallback.kind)).toBe(true);
      }
    }
  });

  it('narrows kinds without being fooled by inherited object keys', () => {
    // The allow-list is scanned as an array precisely so these don't pass.
    expect(isAssetKind('constructor')).toBe(false);
    expect(isAssetKind('__proto__')).toBe(false);
    expect(isAssetKind('toString')).toBe(false);
    expect(isManagedAssetKind('constructor')).toBe(false);
    expect(isDeferredAssetKind('constructor')).toBe(false);
  });

  it('reports deferred kinds as unmanaged and vice versa', () => {
    expect(isDeferredAssetKind('shop')).toBe(true);
    expect(isManagedAssetKind('shop')).toBe(false);
    expect(isDeferredAssetKind('set')).toBe(true);
    expect(isManagedAssetKind('set')).toBe(false);
    expect(isManagedAssetKind('monster')).toBe(true);
    expect(isDeferredAssetKind('monster')).toBe(false);
  });

  it('rejects ids that could climb out of a kind folder', () => {
    expect(isValidAssetId('goblin_king')).toBe(true);
    expect(isValidAssetId('hatchetmill-3-7')).toBe(true);
    expect(isValidAssetId('../escape')).toBe(false);
    expect(isValidAssetId('a/b')).toBe(false);
    expect(isValidAssetId('a\\b')).toBe(false);
    expect(isValidAssetId('.hidden')).toBe(false);
    expect(isValidAssetId('nested..name')).toBe(false);
    expect(isValidAssetId('')).toBe(false);
  });

  it('folds class ids to one canonical spelling so all three render sites agree', () => {
    expect(canonicalAssetId('class', 'Knight')).toBe('knight');
    expect(assetPublicPath('class', 'Knight')).toBe('/class-artwork/knight.png');
    // class-icon deliberately keeps its casing — CLASS_ICONS requests Knight.png.
    expect(canonicalAssetId('class-icon', 'Knight')).toBe('Knight');
    expect(assetPublicPath('class-icon', 'Knight')).toBe('/class-icons/Knight.png');
  });
});
