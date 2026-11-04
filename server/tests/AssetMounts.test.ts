import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { ASSET_KIND_INFO } from '@idle-party-rpg/shared';
import { mountAssetDirs } from '../src/assetMounts.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let tmpDir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-mounts-'));
  const itemDir = path.join(tmpDir, ASSET_KIND_INFO.item.dir);
  await fs.mkdir(itemDir, { recursive: true });
  await fs.writeFile(path.join(itemDir, 'sword.png'), PNG_BYTES);

  const app = express();
  mountAssetDirs(app, dir => path.join(tmpDir, dir));
  app.get('*', (_req, res) => { res.type('html').send('<!doctype html>spa'); });

  server = await new Promise<Server>(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('asset mounts', () => {
  it('serves art that exists', async () => {
    const res = await fetch(`${base}${ASSET_KIND_INFO.item.mount}/sword.png`);

    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('answers 404 for missing art instead of the SPA page', async () => {
    const res = await fetch(`${base}${ASSET_KIND_INFO.item.mount}/missing.png`);

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('spa');
  });

  it('answers 404 for a mount whose folder does not exist yet', async () => {
    const res = await fetch(`${base}${ASSET_KIND_INFO.monster.mount}/goblin.png`);

    expect(res.status).toBe(404);
  });

  it('leaves other paths to the SPA fallback', async () => {
    const res = await fetch(`${base}/map`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('spa');
  });
});
