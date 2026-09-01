#!/usr/bin/env node
/**
 * Bulk asset tooling for the admin imagery API.
 *
 * The admin dashboard uploads art one file at a time, which is fine for a
 * single fix and painful for a batch of eighty. This drives the same
 * `/api/admin/assets` endpoints from a directory of PNGs.
 *
 * Zero dependencies — Node 22 has fetch, FormData and Blob built in, and PNG
 * dimensions come from the IHDR header directly.
 *
 * Every upload is validated locally first (signature, dimensions, shape, size)
 * against the kind registry the server itself reports. A bad batch fails in
 * milliseconds with a full list of problems instead of one round trip per file
 * discovering them one at a time.
 *
 * Usage:
 *   node tools/assets-cli.mjs kinds
 *   node tools/assets-cli.mjs coverage [--kind <kind>] [--missing]
 *   node tools/assets-cli.mjs check <dir> [--kind <kind>]
 *   node tools/assets-cli.mjs push  <dir> [--kind <kind>] [--dry-run] [--force]
 *
 * Directory layout — one folder per asset kind, file named for the entity id:
 *   <dir>/nav-icon/map.png       -> kind "nav-icon",  id "map"
 *   <dir>/item/rusty_dagger.png  -> kind "item",      id "rusty_dagger"
 *
 * Environment:
 *   IPR_API_URL    default https://play.idlepartyrpg.com
 *   IPR_API_TOKEN  required. Create one at /admin -> API Tokens.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateAsset } from './assetValidation.mjs';

const DEFAULT_URL = 'https://play.idlepartyrpg.com';
/** Uploads run concurrently, but politely — this is someone's live game server. */
const CONCURRENCY = 4;

// ── tiny arg parsing ──────────────────────────────────────────

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--missing') flags.missing = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--kind') flags.kind = rest[++i];
    else if (arg.startsWith('--')) fail(`Unknown flag: ${arg}`);
    else positional.push(arg);
  }
  return { command, positional, flags };
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function fail(message) {
  console.error(c.red(`error: ${message}`));
  process.exit(1);
}

// ── api ───────────────────────────────────────────────────────

function config() {
  const token = process.env.IPR_API_TOKEN;
  if (!token) {
    fail('IPR_API_TOKEN is not set. Create a token at /admin -> API Tokens, then:\n' +
         '  export IPR_API_TOKEN=<token>');
  }
  const baseUrl = (process.env.IPR_API_URL ?? DEFAULT_URL).replace(/\/$/, '');
  return { token, baseUrl };
}

async function api(pathname, { method = 'GET', body, headers = {} } = {}) {
  const { token, baseUrl } = config();
  const url = `${baseUrl}/api/admin${pathname}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      body,
      headers: { authorization: `Bearer ${token}`, ...headers },
    });
  } catch (err) {
    throw new Error(`could not reach ${baseUrl} — ${err.message}`);
  }

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    // An HTML body here almost always means the request was answered by the
    // SPA or a proxy rather than the API, which is worth saying plainly.
    throw new Error(`${res.status} ${res.statusText} — expected JSON from ${url}, got ${text.slice(0, 80)}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${payload.error ?? res.statusText}`);
  return payload;
}

/**
 * The server describes its own kinds, so shapes are never hard-coded here.
 *
 * `/assets` returns `{ kinds: { item: {...}, monster: {...} } }` — an object
 * keyed by kind. An array is accepted too, so the CLI keeps working if that
 * ever changes.
 */
async function loadKinds() {
  const payload = await api('/assets');
  const raw = payload.kinds ?? payload.assetKinds ?? payload;
  const list = Array.isArray(raw) ? raw : Object.values(raw ?? {});
  const byKind = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = entry.kind ?? entry.id ?? entry.name;
    if (kind) {
      byKind.set(kind, {
        kind,
        shape: entry.shape ?? 'any',
        label: entry.label ?? kind,
        mount: entry.mount,
      });
    }
  }
  if (byKind.size === 0) throw new Error('server returned no asset kinds');
  return byKind;
}

// ── local validation ──────────────────────────────────────────

/** Walk `<dir>/<kind>/<id>.png` into a flat, validated work list. */
async function collect(dir, kinds, only) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    fail(`cannot read directory: ${dir}`);
  }

  const files = [];
  const unknownKinds = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const kind = entry.name;
    if (only && kind !== only) continue;
    if (!kinds.has(kind)) { unknownKinds.push(kind); continue; }

    const kindDir = path.join(dir, kind);
    for (const f of await readdir(kindDir)) {
      if (!f.toLowerCase().endsWith('.png')) continue;
      const full = path.join(kindDir, f);
      if (!(await stat(full)).isFile()) continue;
      const buf = await readFile(full);
      const { problems, size } = validateAsset(buf, kinds.get(kind));
      files.push({ kind, id: path.basename(f, path.extname(f)), full, buf, problems, size });
    }
  }
  return { files, unknownKinds };
}

function describe(file) {
  const dims = file.size ? `${file.size.width}x${file.size.height}` : '?';
  const kb = `${Math.ceil(file.buf.length / 1024)} KB`;
  return `${file.kind}/${file.id}  ${c.dim(`${dims}, ${kb}`)}`;
}

function reportProblems(files, unknownKinds) {
  for (const kind of unknownKinds) {
    console.log(c.yellow(`skipped unknown kind: ${kind}`));
  }
  const bad = files.filter((f) => f.problems.length > 0);
  for (const f of bad) {
    console.log(`${c.red('invalid')}  ${f.kind}/${f.id} — ${f.problems.join('; ')}`);
  }
  return bad;
}

// ── commands ──────────────────────────────────────────────────

async function cmdKinds() {
  const kinds = await loadKinds();
  console.log(c.bold(`${kinds.size} asset kinds`));
  for (const { kind, shape, label } of [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind))) {
    console.log(`  ${kind.padEnd(14)} ${c.dim(shape.padEnd(7))} ${label}`);
  }
}

async function cmdCoverage(flags) {
  const params = new URLSearchParams();
  if (flags.kind) params.set('kind', flags.kind);
  // Entry detail is only worth pulling when it will be shown — it is the bulk
  // of the payload and useless without --missing or a single --kind.
  if (flags.missing || flags.kind) {
    params.set('includeEntries', 'true');
    if (flags.missing) params.set('missingOnly', 'true');
  }
  const report = await api(`/assets/coverage${params.size ? `?${params}` : ''}`);

  const kinds = report.kinds ?? [];
  if (!Array.isArray(kinds) || kinds.length === 0) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(c.bold('kind            present  missing  required'));
  for (const k of kinds) {
    const line = `  ${String(k.kind).padEnd(14)} ${String(k.present ?? 0).padStart(7)}  ${String(k.missing ?? 0).padStart(7)}  ${String(k.required ?? 0).padStart(8)}`;
    console.log((k.missing ?? 0) > 0 ? c.yellow(line) : c.green(line));
    // `hasOwnAsset` false means nothing is stored for that id — it is resolving
    // via a fallback kind or the placeholder, which is what "missing" means here.
    const ids = (k.entries ?? []).filter((e) => e.hasOwnAsset === false).map((e) => e.id);
    if (ids.length) {
      console.log(c.dim(`      ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? ` … +${ids.length - 12} more` : ''}`));
    }
    // An orphan is stored art with no content pointing at it — usually a
    // renamed or deleted entity, so worth surfacing rather than hiding.
    if (k.orphans?.length) console.log(c.dim(`      orphaned: ${k.orphans.join(', ')}`));
  }

  const s = report.summary;
  if (s) {
    console.log(`\n${c.bold('total')}  ${c.green(`${s.present} present`)}, ${c.yellow(`${s.missing} missing`)} of ${s.required} required`
      + (s.orphans ? `, ${s.orphans} orphaned` : ''));
  }
}

async function cmdCheck(dir, flags) {
  const kinds = await loadKinds();
  const { files, unknownKinds } = await collect(dir, kinds, flags.kind);
  if (files.length === 0) fail(`no PNGs found under ${dir} (expected ${dir}/<kind>/<id>.png)`);

  const bad = reportProblems(files, unknownKinds);
  const ok = files.length - bad.length;
  console.log(`\n${c.green(`${ok} ready`)}${bad.length ? `, ${c.red(`${bad.length} invalid`)}` : ''}`);
  if (bad.length) process.exit(1);
}

async function cmdPush(dir, flags) {
  const kinds = await loadKinds();
  const { files, unknownKinds } = await collect(dir, kinds, flags.kind);
  if (files.length === 0) fail(`no PNGs found under ${dir} (expected ${dir}/<kind>/<id>.png)`);

  const bad = reportProblems(files, unknownKinds);
  const good = files.filter((f) => f.problems.length === 0);

  // Default to refusing a partial upload: a half-applied batch is harder to
  // reason about than one that never started. --force opts into it.
  if (bad.length && !flags.force) {
    fail(`${bad.length} file(s) would be rejected. Fix them, or re-run with --force to upload the other ${good.length}.`);
  }

  if (flags.dryRun) {
    for (const f of good) console.log(`${c.dim('would upload')}  ${describe(f)}`);
    console.log(`\n${good.length} file(s) would be uploaded to ${config().baseUrl}`);
    return;
  }

  let done = 0, failed = 0;
  const queue = [...good];
  async function worker() {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      const form = new FormData();
      form.append('artwork', new Blob([f.buf], { type: 'image/png' }), `${f.id}.png`);
      try {
        await api(`/assets/${encodeURIComponent(f.kind)}/${encodeURIComponent(f.id)}`, {
          method: 'POST',
          body: form,
        });
        done++;
        console.log(`${c.green('uploaded')}  ${describe(f)}`);
      } catch (err) {
        failed++;
        console.log(`${c.red('failed  ')}  ${f.kind}/${f.id} — ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  console.log(`\n${c.green(`${done} uploaded`)}${failed ? `, ${c.red(`${failed} failed`)}` : ''}`);
  if (failed) process.exit(1);
}

// ── entry ─────────────────────────────────────────────────────

const USAGE = `Bulk asset upload for the Idle Party RPG admin API.

  node tools/assets-cli.mjs kinds
  node tools/assets-cli.mjs coverage [--kind <kind>] [--missing]
  node tools/assets-cli.mjs check <dir> [--kind <kind>]
  node tools/assets-cli.mjs push  <dir> [--kind <kind>] [--dry-run] [--force]

Layout: <dir>/<kind>/<id>.png   e.g.  art/nav-icon/map.png

Env:  IPR_API_TOKEN  (required — create at /admin -> API Tokens)
      IPR_API_URL    (default ${DEFAULT_URL})`;

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'kinds': return cmdKinds();
    case 'coverage': return cmdCoverage(flags);
    case 'check': return cmdCheck(positional[0] ?? fail('check needs a directory'), flags);
    case 'push': return cmdPush(positional[0] ?? fail('push needs a directory'), flags);
    case 'help': case '--help': case '-h': case undefined:
      console.log(USAGE);
      return;
    default:
      fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main().catch((err) => fail(err.message));
