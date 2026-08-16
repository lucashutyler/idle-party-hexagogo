# tools

Developer tooling. Not part of the app build — plain Node ESM, run directly.

## assets-cli

Bulk uploads artwork through the admin imagery API (`/api/admin/assets`). The
admin dashboard uploads one file at a time, which is fine for a single fix and
painful for a batch of eighty.

Zero dependencies: Node 22 has `fetch`, `FormData` and `Blob` built in, and PNG
dimensions come straight from the IHDR header.

### Setup

Create a token at **`/admin` → API Tokens**, then:

```bash
export IPR_API_TOKEN=<token>
export IPR_API_URL=https://play.idlepartyrpg.com   # default; override for local
```

For a local server: `export IPR_API_URL=http://localhost:3001`.

### Directory layout

One folder per asset kind, each file named for the entity id:

```
art/
  nav-icon/map.png          -> kind "nav-icon",  id "map"
  slot-icon/head.png        -> kind "slot-icon", id "head"
  item/rusty_dagger.png     -> kind "item",      id "rusty_dagger"
```

Folders whose name isn't a known kind are skipped with a warning rather than
guessed at. Run `kinds` to see the current list — it comes from the server, so
it's never out of date here.

### Commands

```bash
# List the kinds the server accepts, with their shape rules
node tools/assets-cli.mjs kinds

# What content is missing art
node tools/assets-cli.mjs coverage
node tools/assets-cli.mjs coverage --kind item --missing

# Validate locally without uploading anything
node tools/assets-cli.mjs check art/

# Upload
node tools/assets-cli.mjs push art/ --dry-run
node tools/assets-cli.mjs push art/
node tools/assets-cli.mjs push art/ --kind nav-icon
```

### Why it validates locally first

`check` and `push` apply the same rules as `AssetStore.write` — PNG signature,
512 KB ceiling, and square dimensions for kinds that require them — before
sending anything. A bad batch then fails in milliseconds with the full list of
problems, instead of one rejected round trip at a time.

The server still validates every upload. These checks are a fast path, not the
authority, and `server/tests/assetValidation.test.ts` asserts the size limit
matches the server's constant so the two can't drift apart silently.

`push` refuses to upload anything if some files would be rejected, so a batch
doesn't land half-applied. `--force` uploads the valid ones anyway.
