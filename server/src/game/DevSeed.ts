/**
 * Dev-only seeding for content (zones + tiles) and bots (accounts +
 * player saves). Runs from GameLoop.init when NODE_ENV !== 'production'.
 *
 * Two seed passes, both idempotent:
 *   1. seedDevContent — merges 20 generated zones + ~1000 tiles into
 *      ContentStore. Skipped if the marker zone is already present (so
 *      restarts don't duplicate). Tiles that collide with existing
 *      coords are skipped too.
 *   2. seedDevPlayers — creates 100 verified accounts (bot_001..100),
 *      assigns each a class/level/position/party, and persists their
 *      saves to disk. Skipped if even one bot's save already exists,
 *      to avoid blowing away dev state on restart.
 *
 * Player saves are dropped onto disk; `GameLoop.init` then calls
 * `store.loadAll()` and `restoreFromSaveData()` as usual, which builds
 * the in-memory sessions + parties for us. The bots appear as other
 * players on the map because PlayerManager.getOtherPlayers() iterates
 * `this.sessions` — connection isn't required.
 */

import {
  generateDevWorld,
  DEV_SEED_MARKER_ZONE_ID,
  ALL_CLASS_NAMES,
  type ClassName,
  type WorldTileDefinition,
} from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';
import type { GameStateStore, PlayerSaveData } from './GameStateStore.js';
import type { AccountStore } from '../auth/AccountStore.js';

const DEV_BOT_COUNT = 100;
const DEV_PARTY_SEED = 7919;
const DEV_PLAYER_SEED = 1337;

/**
 * Mirror of the shared mulberry32 PRNG so server-side seeding is
 * deterministic too. Different seed values for content vs. players so
 * the two streams can be tuned independently.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Merge the procedurally-generated dev world (20 zones, ~1000 rooms)
 * into the content store. Idempotent — re-runs return immediately if
 * the marker zone is already present.
 */
export async function seedDevContent(content: ContentStore): Promise<boolean> {
  if (content.getZone(DEV_SEED_MARKER_ZONE_ID)) {
    console.log('[DevSeed] Dev world already seeded — skipping.');
    return false;
  }
  const t0 = performance.now();
  const { zones, tiles } = generateDevWorld({ seed: 1 });
  await content.mergeSeedContent(zones, tiles);
  console.log(
    `[DevSeed] Merged ${zones.length} dev zones + ${tiles.length} dev tiles in ` +
    `${(performance.now() - t0).toFixed(1)}ms.`,
  );
  return true;
}

/**
 * Persist 100 bot player saves to disk and register their accounts.
 * Idempotent — skipped if bot_001 already has a save (we assume the
 * whole batch is present together).
 *
 * Returns the saves we wrote so the caller can optionally feed them
 * straight into `restoreFromSaveData` without a second disk read.
 */
export async function seedDevPlayers(
  store: GameStateStore,
  accounts: AccountStore,
  contentTiles: WorldTileDefinition[],
): Promise<PlayerSaveData[]> {
  // Idempotency probe: if bot_001 is already on disk, assume the whole
  // batch was previously seeded. Cheaper than reading 100 files.
  const probe = await store.load(botUsername(1));
  if (probe) {
    console.log('[DevSeed] Bots already seeded — skipping.');
    return [];
  }

  // Only place bots on traversable tiles inside dev zones — putting
  // them on production tiles would crowd the starting island.
  const traversableDevTiles = contentTiles.filter(t =>
    t.zone.startsWith('dev_') && isLikelyTraversable(t.type),
  );
  if (traversableDevTiles.length === 0) {
    console.warn('[DevSeed] No dev tiles found — skipping bot seed.');
    return [];
  }

  const t0 = performance.now();
  const partyAssignments = assignParties(DEV_BOT_COUNT, mulberry32(DEV_PARTY_SEED));
  const rng = mulberry32(DEV_PLAYER_SEED);
  const saves: PlayerSaveData[] = [];

  for (let i = 1; i <= DEV_BOT_COUNT; i++) {
    const username = botUsername(i);
    const email = `${username}@dev.local`;
    const acct = await accounts.createAccount(email);
    await accounts.setVerified(email);
    if (!acct.username) {
      const result = await accounts.setUsername(email, username);
      if (!result.success) {
        // Username collision — could happen if a real player already
        // grabbed `bot_NNN`. Skip this bot.
        console.warn(`[DevSeed] Couldn't claim username ${username}: ${result.error}`);
        continue;
      }
    }

    const className = ALL_CLASS_NAMES[i % ALL_CLASS_NAMES.length];
    const level = 1 + Math.floor(rng() * 30);
    // Party members share a starting tile so they look grouped on the
    // map. Pick the tile from the first member's draw.
    const party = partyAssignments[i - 1];
    const tile = traversableDevTiles[
      Math.floor(mulberry32(party.partyHash).call(null) * traversableDevTiles.length)
    ];

    saves.push(buildBotSave({ username, className, level, tile, party }));
  }

  await store.saveAll(saves);
  console.log(
    `[DevSeed] Seeded ${saves.length} bots across ${countParties(saves)} parties ` +
    `in ${(performance.now() - t0).toFixed(1)}ms.`,
  );
  return saves;
}

// ─── Helpers ──────────────────────────────────────────────────────

function botUsername(n: number): string {
  return `bot_${String(n).padStart(3, '0')}`;
}

/**
 * Tile types that are traversable in the production tile catalog.
 * Kept local so the seeder doesn't need to depend on ContentStore's
 * tile-type map (which is mid-rebuild during init).
 */
function isLikelyTraversable(type: string): boolean {
  return type === 'plains' || type === 'forest' || type === 'town' ||
    type === 'dungeon' || type === 'desert' || type === 'lava_field' ||
    type === 'beach';
}

interface PartyAssignment {
  partyId: string;
  /** Position 0-8 on the 3×3 grid (4 = center → owner). */
  gridPosition: number;
  role: 'owner' | 'leader' | 'member';
  /** Hash unique per party, fed back into the PRNG so all members of a
   *  party land on the same tile. */
  partyHash: number;
}

/**
 * Group `count` bots into mixed-size parties (some solo, some small,
 * some at the 5-cap). Mirrors the "always in a party" invariant.
 *
 * Distribution:
 *   ~30% solo (party of 1)
 *   ~30% duo (party of 2)
 *   ~20% trio (party of 3)
 *   ~15% quartet (party of 4)
 *   ~5%  full (party of 5)
 */
function assignParties(count: number, rng: () => number): PartyAssignment[] {
  const out: PartyAssignment[] = [];
  let bot = 0;
  let partyIndex = 0;
  while (bot < count) {
    const remaining = count - bot;
    const r = rng();
    let size: number;
    if (r < 0.30) size = 1;
    else if (r < 0.60) size = 2;
    else if (r < 0.80) size = 3;
    else if (r < 0.95) size = 4;
    else size = 5;
    size = Math.min(size, remaining);

    const partyId = `seed_party_${String(partyIndex).padStart(3, '0')}`;
    // Stable hash per party so all members land on the same tile.
    const partyHash = (partyIndex * 0x9e3779b9) >>> 0;
    for (let m = 0; m < size; m++) {
      out.push({
        partyId,
        gridPosition: m === 0 ? 4 : firstFreeGridSlot(m),
        role: m === 0 ? 'owner' : 'member',
        partyHash,
      });
      bot++;
    }
    partyIndex++;
  }
  return out;
}

/** 3×3 grid positions in fill order (center first, then ring around). */
const GRID_FILL_ORDER = [4, 1, 7, 3, 5, 0, 2, 6, 8] as const;
function firstFreeGridSlot(memberIndex: number): number {
  return GRID_FILL_ORDER[memberIndex % GRID_FILL_ORDER.length];
}

function countParties(saves: PlayerSaveData[]): number {
  return new Set(saves.map(s => s.partyId).filter(Boolean)).size;
}

interface BuildBotOpts {
  username: string;
  className: ClassName;
  level: number;
  tile: WorldTileDefinition;
  party: PartyAssignment;
}

/** Minimal-but-valid PlayerSaveData for a bot. */
function buildBotSave(o: BuildBotOpts): PlayerSaveData {
  return {
    username: o.username,
    battleCount: 0,
    combatLog: [],
    // Only the bot's current tile is in their unlocked set — they look
    // like a fresh player who happens to be standing in a dev zone.
    unlockedKeys: [o.tile.id],
    position: { col: o.tile.col, row: o.tile.row },
    target: null,
    movementQueue: [],
    character: {
      className: o.className,
      level: o.level,
      xp: 0,
      gold: 0,
      inventory: {},
      equipment: {},
    },
    friends: [],
    outgoingFriendRequests: [],
    blockedUsers: {},
    guildId: null,
    partyId: o.party.partyId,
    partyRole: o.party.role,
    partyGridPosition: o.party.gridPosition,
    chatHistory: [],
    mailbox: [],
    activeQuests: [],
    completedQuests: [],
    weeklyCompletions: {},
  };
}
