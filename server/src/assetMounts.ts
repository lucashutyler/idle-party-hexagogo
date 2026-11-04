import path from 'path';
import express from 'express';
import { ASSET_KINDS, ASSET_KIND_INFO } from '@idle-party-rpg/shared';

/**
 * Serve every asset kind's folder at its public mount. A missing file answers 404
 * instead of falling through to the production SPA fallback's index.html.
 */
export function mountAssetDirs(app: express.Express, resolveDir: (dir: string) => string = dir => path.resolve(dir)): void {
  for (const kind of ASSET_KINDS) {
    const info = ASSET_KIND_INFO[kind];
    app.use(info.mount, express.static(resolveDir(info.dir)));
    app.use(info.mount, (_req, res) => { res.sendStatus(404); });
  }
}
