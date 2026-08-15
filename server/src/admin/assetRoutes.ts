import type { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { MANAGED_ASSET_KINDS, DEFERRED_ASSET_KINDS, ASSET_KIND_INFO, isManagedAssetKind, isDeferredAssetKind } from '@idle-party-rpg/shared';
import type { ManagedAssetKind } from '@idle-party-rpg/shared';
import type { ContentStore } from '../game/ContentStore.js';
import type { AssetStore } from '../game/AssetStore.js';
import { AssetValidationError, MAX_ASSET_BYTES } from '../game/AssetStore.js';
import { computeAssetCoverage } from '../game/AssetCoverage.js';

/**
 * `/api/admin/assets/*` — one surface for every kind of imagery in the game.
 *
 * Artwork deliberately isn't a field on `MonsterDefinition` or any other
 * content type: half the kinds have no owning entity at all (map parchment
 * keys on a map id, backdrops on a zone, the logo is a singleton, icon sets
 * aren't content), and putting it on the entities would drag binary art into
 * `ContentSnapshot` and the whole draft/publish flow. So the imagery lives on
 * its own resource, described by the shared `ASSET_KIND_INFO` registry.
 *
 * Registered onto the admin router from `createAdminRoutes`, so the
 * router-wide `adminMiddleware` gate already applies — no per-route auth here.
 */

const assetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_ASSET_BYTES } });

export interface AssetRouteOptions {
  contentStore: () => ContentStore;
  assetStore: AssetStore;
}

/** Public registry view — what kinds exist, where they live, how they're keyed. */
export function describeAssetKinds() {
  const kinds = Object.fromEntries(
    MANAGED_ASSET_KINDS.map(kind => {
      const info = ASSET_KIND_INFO[kind];
      return [kind, {
        kind,
        label: info.label,
        description: info.description,
        mount: info.mount,
        dir: info.dir,
        idFormat: info.idFormat,
        shape: info.shape,
        urlTemplate: `${info.mount}/{id}.png`,
        fallbacks: info.fallbacks ?? [],
      }];
    })
  );
  // Surfaced so a client can see these kinds exist and are coming, rather than
  // concluding the game has no shop or set artwork at all.
  const deferred = DEFERRED_ASSET_KINDS.map(kind => ({
    kind,
    label: ASSET_KIND_INFO[kind].label,
    reason: ASSET_KIND_INFO[kind].description,
  }));
  return { kinds, deferred, maxBytes: MAX_ASSET_BYTES };
}

/** Reject unknown and not-yet-supported `:kind` values the same way everywhere. */
function resolveKind(req: Request, res: Response): ManagedAssetKind | null {
  const kind = req.params.kind;
  if (isDeferredAssetKind(kind)) {
    res.status(400).json({
      error: `The "${kind}" asset kind is not managed through this API yet: ${ASSET_KIND_INFO[kind].description}`,
    });
    return null;
  }
  if (!isManagedAssetKind(kind)) {
    res.status(400).json({ error: `Unknown asset kind: ${kind}. Valid kinds: ${MANAGED_ASSET_KINDS.join(', ')}.` });
    return null;
  }
  return kind;
}

/** Caller mistakes become 400s; anything else is a genuine 500. */
function sendError(res: Response, err: unknown): void {
  if (err instanceof AssetValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error('Asset route error:', err);
  res.status(500).json({ error: 'Failed to complete the asset operation.' });
}

export function registerAssetRoutes(router: Router, { contentStore, assetStore }: AssetRouteOptions): void {
  /** The kind registry itself — lets a client discover kinds instead of hard-coding them. */
  router.get('/assets', (_req, res) => {
    res.json(describeAssetKinds());
  });

  /**
   * Which content is missing art, broken down by kind. `includeEntries` adds
   * the per-id detail; `missingOnly` trims that to just the gaps.
   */
  router.get('/assets/coverage', async (req, res) => {
    const kindParam = req.query.kind;
    if (kindParam !== undefined && !isManagedAssetKind(kindParam)) {
      const deferred = isDeferredAssetKind(kindParam)
        ? ` The "${String(kindParam)}" kind is not covered by this report yet.`
        : '';
      res.status(400).json({
        error: `Unknown asset kind: ${String(kindParam)}. Valid kinds: ${MANAGED_ASSET_KINDS.join(', ')}.${deferred}`,
      });
      return;
    }
    try {
      const report = await computeAssetCoverage(contentStore(), assetStore, {
        kind: kindParam,
        includeEntries: req.query.includeEntries === 'true',
        missingOnly: req.query.missingOnly === 'true',
        entryLimit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json(report);
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Every asset stored for one kind. */
  router.get('/assets/:kind', async (req, res) => {
    const kind = resolveKind(req, res);
    if (!kind) return;
    try {
      const assets = await assetStore.list(kind);
      res.json({ kind, count: assets.length, assets });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Metadata for one asset. */
  router.get('/assets/:kind/:id', async (req, res) => {
    const kind = resolveKind(req, res);
    if (!kind) return;
    try {
      const asset = await assetStore.stat(kind, req.params.id);
      if (!asset) {
        res.status(404).json({ error: `No ${kind} artwork stored for "${req.params.id}".` });
        return;
      }
      res.json({ asset });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Upload (or replace) a PNG. Multipart field name: `artwork`. */
  router.post('/assets/:kind/:id', assetUpload.single('artwork'), async (req, res) => {
    const kind = resolveKind(req, res);
    if (!kind) return;
    if (!req.file) { res.status(400).json({ error: 'No file uploaded.' }); return; }
    try {
      const asset = await assetStore.write(kind, req.params.id, req.file.buffer);
      res.json({ success: true, asset });
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Delete an asset. Idempotent — deleting art that isn't there still succeeds. */
  router.delete('/assets/:kind/:id', async (req, res) => {
    const kind = resolveKind(req, res);
    if (!kind) return;
    try {
      const removed = await assetStore.remove(kind, req.params.id);
      res.json({ success: true, removed });
    } catch (err) {
      sendError(res, err);
    }
  });

}

/**
 * Multer rejects oversized uploads by throwing, which would otherwise reach
 * Express's default handler and return an HTML error page instead of the
 * `{ error }` envelope every other admin route returns.
 *
 * Registered by the caller *after* every upload route — including the
 * deprecated `/artwork` and `/items/:id/artwork` aliases — because an Express
 * error handler only sees errors from middleware mounted before it.
 */
export function assetUploadErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (!err) { next(); return; }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? `Image is too large — the limit is ${MAX_ASSET_BYTES / 1024} KB.`
      : `Upload failed: ${err.message}.`;
    res.status(400).json({ error: message });
    return;
  }
  sendError(res, err);
}
