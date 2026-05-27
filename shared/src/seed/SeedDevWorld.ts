/**
 * Deterministic procedural generator for an expanded dev world.
 *
 * Produces 20 zones / ~1000 rooms placed in disjoint coordinate regions
 * far from the production starting area (col 0..13, row 0..13), so the
 * dev content never accidentally connects to the player's starting
 * island. Each zone uses a `style` generator (path, delta, dense,
 * scattered, archipelago, gridded) so the map reads as a mix of
 * meandering jungle/river layouts, sprawling deserts, dense forests,
 * and ruined grids — useful for stress-testing the renderer and
 * visualising at scale.
 *
 * Pure module: no fs / no server deps. Server-side seeding (player
 * accounts + persisted saves) lives in server/src/game/DevSeed.ts.
 *
 * Versioning: bump DEV_SEED_VERSION when you change generator output.
 * The server gates re-seeding on the presence of the marker zone, so
 * deleting the marker zone (or wiping data/zones.json) re-runs the
 * generator on next boot.
 */

import { TileType } from '../hex/HexTile.js';
import type { WorldTileDefinition } from '../hex/MapSchema.js';
import type { ZoneDefinition } from '../systems/ZoneTypes.js';

/** Bumped when the generator's output structure changes. */
export const DEV_SEED_VERSION = 1;

/** Prefix shared by every generated zone id; lets server-side code
 *  recognise + skip already-seeded content idempotently. */
export const DEV_ZONE_PREFIX = 'dev_';

/** First zone in the generated output; presence of this id in the
 *  ContentStore indicates the dev seed has already been applied. */
export const DEV_SEED_MARKER_ZONE_ID = `${DEV_ZONE_PREFIX}sunscar_plains`;

// ─── PRNG ────────────────────────────────────────────────────────
// mulberry32 — small, fast, well-distributed, fine for layout
// determinism. Don't use for crypto.
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

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function pickWeighted<T>(rng: () => number, options: readonly { value: T; weight: number }[]): T {
  const total = options.reduce((s, o) => s + o.weight, 0);
  let r = rng() * total;
  for (const o of options) {
    r -= o.weight;
    if (r <= 0) return o.value;
  }
  return options[options.length - 1].value;
}

// ─── Zone style + theme data ──────────────────────────────────────

type ZoneStyle = 'path' | 'delta' | 'dense' | 'scattered' | 'archipelago' | 'gridded';

/** Tile type weights drive both the primary terrain feel and a sprinkle
 *  of secondary / non-traversable variation. */
interface ZoneTheme {
  /** Stable id suffix; final id is `dev_<key>`. */
  key: string;
  displayName: string;
  style: ZoneStyle;
  levelRange: [number, number];
  /** Tile-type weights for traversable cells. */
  traversable: readonly { value: TileType; weight: number }[];
  /** Tile-type weights for the small fraction of non-traversable cells.
   *  When empty, the generator omits those cells entirely (creating a
   *  gap) rather than placing a wall. */
  nontraversable: readonly { value: TileType; weight: number }[];
  /** Words mixed into procedurally-generated room names. */
  nouns: readonly string[];
  /** Adjectives mixed into procedurally-generated room names. */
  adjectives: readonly string[];
  /** Target tile count for this zone. The generator will get within ±10%. */
  targetTiles: number;
}

const THEMES: readonly ZoneTheme[] = [
  {
    key: 'sunscar_plains', displayName: 'Sunscar Plains', style: 'dense', levelRange: [1, 3],
    traversable: [{ value: TileType.Plains, weight: 8 }, { value: TileType.Forest, weight: 1 }, { value: TileType.Town, weight: 1 }],
    nontraversable: [{ value: TileType.Mountain, weight: 1 }],
    nouns: ['Field', 'Meadow', 'Cairn', 'Stretch', 'Hollow', 'Run', 'Crossing', 'Gate'],
    adjectives: ['Sunscar', 'Golden', 'Open', 'Lark', 'Quiet', 'Wide', 'Wheatpale'],
    targetTiles: 70,
  },
  {
    key: 'whispering_pines', displayName: 'Whispering Pines', style: 'path', levelRange: [2, 4],
    traversable: [{ value: TileType.Forest, weight: 9 }, { value: TileType.Plains, weight: 1 }],
    nontraversable: [{ value: TileType.Hedge, weight: 2 }, { value: TileType.Mountain, weight: 1 }],
    nouns: ['Path', 'Glade', 'Trail', 'Hollow', 'Brook', 'Stand', 'Grove'],
    adjectives: ['Whisper', 'Pine', 'Silent', 'Cedar', 'Moss', 'Owl'],
    targetTiles: 38,
  },
  {
    key: 'bramblewood_hedge', displayName: 'Bramblewood Hedge', style: 'dense', levelRange: [3, 5],
    traversable: [{ value: TileType.Forest, weight: 6 }, { value: TileType.Plains, weight: 2 }],
    nontraversable: [{ value: TileType.Hedge, weight: 4 }],
    nouns: ['Thicket', 'Snarl', 'Bramble', 'Knot', 'Burrow', 'Tangle'],
    adjectives: ['Bramble', 'Thorn', 'Yew', 'Ivy', 'Dusk', 'Briar'],
    targetTiles: 55,
  },
  {
    key: 'ashen_dunes', displayName: 'Ashen Dunes', style: 'scattered', levelRange: [4, 6],
    traversable: [{ value: TileType.Desert, weight: 9 }, { value: TileType.Plains, weight: 1 }],
    nontraversable: [{ value: TileType.Mountain, weight: 2 }],
    nouns: ['Dune', 'Wash', 'Pan', 'Sands', 'Drift', 'Bowl', 'Spire'],
    adjectives: ['Ashen', 'Bleached', 'Cracked', 'Hot', 'Salt', 'Bone'],
    targetTiles: 60,
  },
  {
    key: 'saltmarsh_delta', displayName: 'Saltmarsh Delta', style: 'delta', levelRange: [5, 7],
    traversable: [{ value: TileType.Beach, weight: 7 }, { value: TileType.Plains, weight: 2 }],
    nontraversable: [{ value: TileType.Water, weight: 6 }],
    nouns: ['Channel', 'Bank', 'Reach', 'Bend', 'Bar', 'Outlet', 'Wade'],
    adjectives: ['Salt', 'Brackish', 'Reed', 'Heron', 'Lowtide', 'Marsh'],
    targetTiles: 50,
  },
  {
    key: 'cinder_range', displayName: 'Cinder Range', style: 'archipelago', levelRange: [6, 8],
    traversable: [{ value: TileType.LavaField, weight: 5 }, { value: TileType.Plains, weight: 2 }, { value: TileType.Desert, weight: 1 }],
    nontraversable: [{ value: TileType.Mountain, weight: 4 }, { value: TileType.Volcano, weight: 1 }],
    nouns: ['Crag', 'Ridge', 'Vent', 'Ledge', 'Spire', 'Saddle'],
    adjectives: ['Cinder', 'Ash', 'Smoulder', 'Black', 'Soot', 'Ember'],
    targetTiles: 45,
  },
  {
    key: 'hollow_mire', displayName: 'Hollow Mire', style: 'scattered', levelRange: [7, 9],
    traversable: [{ value: TileType.Forest, weight: 5 }, { value: TileType.Plains, weight: 2 }],
    nontraversable: [{ value: TileType.Water, weight: 4 }, { value: TileType.Hedge, weight: 1 }],
    nouns: ['Bog', 'Pool', 'Knoll', 'Stump', 'Hummock', 'Drowned Tree'],
    adjectives: ['Hollow', 'Sunken', 'Croaking', 'Murk', 'Reed', 'Foxfire'],
    targetTiles: 55,
  },
  {
    key: 'glassreach_desert', displayName: 'Glassreach Desert', style: 'scattered', levelRange: [8, 10],
    traversable: [{ value: TileType.Desert, weight: 9 }],
    nontraversable: [{ value: TileType.Mountain, weight: 1 }],
    nouns: ['Reach', 'Shard', 'Glare', 'Mirror', 'Scour', 'Vista'],
    adjectives: ['Glass', 'Shard', 'Silver', 'Brittle', 'Mirage'],
    targetTiles: 80,
  },
  {
    key: 'tideforge_coast', displayName: 'Tideforge Coast', style: 'path', levelRange: [9, 11],
    traversable: [{ value: TileType.Beach, weight: 7 }, { value: TileType.Plains, weight: 2 }, { value: TileType.Town, weight: 1 }],
    nontraversable: [{ value: TileType.Water, weight: 5 }],
    nouns: ['Cove', 'Spit', 'Cliff', 'Shoal', 'Wharf', 'Anchorage'],
    adjectives: ['Tide', 'Salt', 'Gale', 'Forge', 'Stormwatch', 'Anchor'],
    targetTiles: 42,
  },
  {
    key: 'embergrave_volcano', displayName: 'Embergrave Volcano', style: 'archipelago', levelRange: [10, 12],
    traversable: [{ value: TileType.LavaField, weight: 7 }, { value: TileType.Desert, weight: 1 }],
    nontraversable: [{ value: TileType.Volcano, weight: 3 }, { value: TileType.Mountain, weight: 2 }],
    nouns: ['Vent', 'Caldera', 'Pyre', 'Maw', 'Brink'],
    adjectives: ['Ember', 'Magma', 'Choking', 'Pyric', 'Sunken'],
    targetTiles: 40,
  },
  {
    key: 'verdant_trail', displayName: 'Verdant Trail', style: 'path', levelRange: [11, 13],
    traversable: [{ value: TileType.Plains, weight: 5 }, { value: TileType.Forest, weight: 4 }],
    nontraversable: [{ value: TileType.Hedge, weight: 1 }, { value: TileType.Mountain, weight: 1 }],
    nouns: ['Trail', 'Crossing', 'Bridge', 'Bend', 'Lane', 'Stage'],
    adjectives: ['Verdant', 'Sunlit', 'Heron', 'Sparrow', 'Twin Oak', 'Foxglove'],
    targetTiles: 36,
  },
  {
    key: 'riftstone_ruins', displayName: 'Riftstone Ruins', style: 'gridded', levelRange: [12, 14],
    traversable: [{ value: TileType.Town, weight: 5 }, { value: TileType.Plains, weight: 3 }, { value: TileType.Dungeon, weight: 2 }],
    nontraversable: [{ value: TileType.Mountain, weight: 1 }],
    nouns: ['Plaza', 'Court', 'Stair', 'Wall', 'Vault', 'Atrium', 'Lintel'],
    adjectives: ['Riftstone', 'Toppled', 'Carved', 'Sigil', 'Lost'],
    targetTiles: 50,
  },
  {
    key: 'bone_atoll', displayName: 'Bone Atoll', style: 'archipelago', levelRange: [13, 15],
    traversable: [{ value: TileType.Beach, weight: 6 }, { value: TileType.Plains, weight: 2 }],
    nontraversable: [{ value: TileType.Water, weight: 6 }],
    nouns: ['Atoll', 'Reef', 'Spit', 'Ring', 'Bar', 'Lagoon'],
    adjectives: ['Bone', 'Coral', 'Pale', 'Whalebone', 'Drift'],
    targetTiles: 38,
  },
  {
    key: 'sable_canyon', displayName: 'Sable Canyon', style: 'path', levelRange: [14, 16],
    traversable: [{ value: TileType.Plains, weight: 4 }, { value: TileType.Desert, weight: 4 }],
    nontraversable: [{ value: TileType.Mountain, weight: 5 }],
    nouns: ['Pass', 'Rim', 'Wash', 'Floor', 'Narrows', 'Stair'],
    adjectives: ['Sable', 'Iron', 'Ochre', 'Hawk', 'Echo', 'Wind'],
    targetTiles: 40,
  },
  {
    key: 'mire_of_yore', displayName: 'Mire of Yore', style: 'dense', levelRange: [15, 17],
    traversable: [{ value: TileType.Forest, weight: 5 }, { value: TileType.Plains, weight: 2 }],
    nontraversable: [{ value: TileType.Water, weight: 3 }, { value: TileType.Hedge, weight: 2 }],
    nouns: ['Bog', 'Tarn', 'Stump', 'Marsh', 'Quag', 'Hummock'],
    adjectives: ['Old', 'Yore', 'Ancient', 'Witch', 'Crone', 'Lichgate'],
    targetTiles: 55,
  },
  {
    key: 'ironvein_hills', displayName: 'Ironvein Hills', style: 'dense', levelRange: [16, 18],
    traversable: [{ value: TileType.Plains, weight: 4 }, { value: TileType.Dungeon, weight: 2 }, { value: TileType.Town, weight: 1 }],
    nontraversable: [{ value: TileType.Mountain, weight: 4 }],
    nouns: ['Adit', 'Shaft', 'Crest', 'Knob', 'Outcrop', 'Vein'],
    adjectives: ['Ironvein', 'Cinder', 'Rusted', 'Lodestone', 'Slag'],
    targetTiles: 50,
  },
  {
    key: 'sapphire_reach', displayName: 'Sapphire Reach', style: 'archipelago', levelRange: [17, 19],
    traversable: [{ value: TileType.Beach, weight: 5 }, { value: TileType.Plains, weight: 2 }, { value: TileType.Town, weight: 1 }],
    nontraversable: [{ value: TileType.Water, weight: 7 }],
    nouns: ['Strand', 'Cay', 'Reef', 'Bight', 'Reach', 'Sandbar'],
    adjectives: ['Sapphire', 'Azure', 'Pearl', 'Coral', 'Glasswater'],
    targetTiles: 42,
  },
  {
    key: 'thornwall_maze', displayName: 'Thornwall Maze', style: 'gridded', levelRange: [18, 20],
    traversable: [{ value: TileType.Plains, weight: 4 }, { value: TileType.Forest, weight: 2 }],
    nontraversable: [{ value: TileType.Hedge, weight: 5 }],
    nouns: ['Junction', 'Corridor', 'Garden', 'Cul-de-sac', 'Niche', 'Court'],
    adjectives: ['Thorn', 'Maze', 'Twisting', 'Walled', 'Briar'],
    targetTiles: 48,
  },
  {
    key: 'skybound_peaks', displayName: 'Skybound Peaks', style: 'scattered', levelRange: [19, 21],
    traversable: [{ value: TileType.Plains, weight: 3 }, { value: TileType.Dungeon, weight: 1 }],
    nontraversable: [{ value: TileType.Mountain, weight: 5 }],
    nouns: ['Pinnacle', 'Cirque', 'Spur', 'Crest', 'Saddle', 'Eyrie'],
    adjectives: ['Skybound', 'Frostspar', 'Cloud', 'Eagle', 'Argent'],
    targetTiles: 35,
  },
  {
    key: 'forgotten_vale', displayName: 'Forgotten Vale', style: 'dense', levelRange: [20, 22],
    traversable: [{ value: TileType.Plains, weight: 5 }, { value: TileType.Forest, weight: 3 }, { value: TileType.Town, weight: 2 }],
    nontraversable: [{ value: TileType.Mountain, weight: 1 }],
    nouns: ['Vale', 'Holt', 'Mere', 'Ford', 'Hamlet', 'Glen'],
    adjectives: ['Forgotten', 'Misted', 'Hollow', 'Quiet', 'Whisper', 'Lichen'],
    targetTiles: 70,
  },
];

// Validate target tile counts sum to ~1000 (sanity check at module load).
// 70+38+55+60+50+45+55+80+42+40+36+50+38+40+55+50+42+48+35+70 = 999.

// ─── Region placement ─────────────────────────────────────────────
//
// Production seed lives at col 0..13, row 0..13. Dev zones start at
// col 30 so there's a gap of ~16 empty cells that visually separates
// the two regions on the map. Zones are laid out in a 5-wide × 4-tall
// grid; each cell of the grid is a 42×42 region inside which the
// zone's generator places its tiles. Adjacent dev zones therefore
// have a comfortable buffer of empty cells between them too.

const DEV_REGION_START_COL = 30;
const DEV_REGION_START_ROW = 0;
const ZONES_PER_ROW = 5;
// Tight regions keep the static-layer bake under ~8000×7000 pixels at
// zoom=1, which fits comfortably inside the WebGL texture cap on any
// modern desktop GPU. Per-zone styles still get enough room to read
// distinctly (a 20-wide × 25-tall cell box per zone). Bumping these
// also bumps the bake canvas — watch the WebGL limit if you do.
const REGION_WIDTH = 20;
const REGION_HEIGHT = 25;

function regionCenter(zoneIndex: number): { col: number; row: number } {
  const gx = zoneIndex % ZONES_PER_ROW;
  const gy = Math.floor(zoneIndex / ZONES_PER_ROW);
  return {
    col: DEV_REGION_START_COL + gx * REGION_WIDTH + Math.floor(REGION_WIDTH / 2),
    row: DEV_REGION_START_ROW + gy * REGION_HEIGHT + Math.floor(REGION_HEIGHT / 2),
  };
}

// ─── Per-style generators ─────────────────────────────────────────
//
// Each generator returns a Set of "col,row" cell keys that the zone
// occupies. The caller then assigns tile types (mostly the theme's
// `traversable` distribution; a small fraction gets nontraversable
// types if the theme has any). For sparse styles, cells the generator
// chose not to include simply don't get tiles — visible as gaps in
// the rendered map.

function genPathCells(rng: () => number, center: { col: number; row: number }, target: number): Set<string> {
  // Random-walk a 2-3 wide ribbon from one edge of the region to roughly
  // the opposite edge. The path bends but trends in a chosen direction.
  const cells = new Set<string>();
  const dirX = rng() < 0.5 ? 1 : -1;
  const dirY = rng() < 0.5 ? 1 : -1;
  let cx = center.col - dirX * Math.floor(REGION_WIDTH / 3);
  let cy = center.row - dirY * Math.floor(REGION_HEIGHT / 3);
  const steps = target * 2; // each step adds ~0.5 cells on average
  for (let i = 0; i < steps; i++) {
    // Brush a 1-2 wide perpendicular band around the head.
    const band = Math.floor(rng() * 2) + 1;
    for (let bx = -band; bx <= band; bx++) {
      for (let by = -band; by <= band; by++) {
        if (Math.abs(bx) + Math.abs(by) > band) continue;
        cells.add(`${Math.round(cx + bx)},${Math.round(cy + by)}`);
        if (cells.size >= target) return cells;
      }
    }
    // Wander: mostly trend forward, occasionally sidestep.
    if (rng() < 0.7) cx += dirX;
    else cx += rng() < 0.5 ? 1 : -1;
    if (rng() < 0.55) cy += dirY;
    else cy += rng() < 0.5 ? 1 : -1;
  }
  return cells;
}

function genDeltaCells(rng: () => number, center: { col: number; row: number }, target: number): Set<string> {
  // Trunk + 3-5 branches, each a thinner random walk. Mimics a river
  // delta or fork in a road.
  const cells = new Set<string>();
  const dirX = rng() < 0.5 ? 1 : -1;
  // Trunk grows from one edge toward center.
  let cx = center.col - dirX * Math.floor(REGION_WIDTH / 3);
  let cy = center.row + (Math.floor(rng() * 6) - 3);
  const trunkLen = Math.floor(target * 0.4);
  for (let i = 0; i < trunkLen; i++) {
    for (let by = -1; by <= 1; by++) cells.add(`${cx},${cy + by}`);
    cx += dirX;
    if (rng() < 0.3) cy += rng() < 0.5 ? 1 : -1;
    if (cells.size >= target) return cells;
  }
  // Branches fan out.
  const branchCount = 3 + Math.floor(rng() * 3);
  for (let b = 0; b < branchCount; b++) {
    let bx = cx;
    let by = cy + (b - branchCount / 2) * 3;
    const len = Math.floor((target - cells.size) / Math.max(1, branchCount - b));
    for (let i = 0; i < len; i++) {
      cells.add(`${bx},${by}`);
      if (rng() < 0.6) bx += dirX;
      if (rng() < 0.55) by += b % 2 === 0 ? 1 : -1;
      if (cells.size >= target) return cells;
    }
  }
  return cells;
}

function genDenseCells(rng: () => number, center: { col: number; row: number }, target: number): Set<string> {
  // Rectangular blob with a few small omissions for variety. Fills
  // ~85% of a region sized to hit `target`.
  const cells = new Set<string>();
  const side = Math.ceil(Math.sqrt(target / 0.85));
  const half = Math.floor(side / 2);
  for (let dx = -half; dx <= half; dx++) {
    for (let dy = -half; dy <= half; dy++) {
      // 15% chance of skipping a cell to create internal gaps.
      if (rng() < 0.15) continue;
      cells.add(`${center.col + dx},${center.row + dy}`);
      if (cells.size >= target) return cells;
    }
  }
  return cells;
}

function genScatteredCells(rng: () => number, center: { col: number; row: number }, target: number): Set<string> {
  // Random points within a wide region — sparse, no clumping. Models
  // a desert dotted with rocks or a plain dotted with cairns.
  const cells = new Set<string>();
  const half = Math.floor(REGION_WIDTH / 2) - 2;
  let attempts = 0;
  while (cells.size < target && attempts < target * 8) {
    attempts++;
    const dx = Math.floor((rng() - 0.5) * 2 * half);
    const dy = Math.floor((rng() - 0.5) * 2 * half);
    cells.add(`${center.col + dx},${center.row + dy}`);
  }
  return cells;
}

function genArchipelagoCells(rng: () => number, center: { col: number; row: number }, target: number): Set<string> {
  // 3-6 small dense clusters spread over the region. Gaps between
  // clusters dominate, so the rendered zone looks like islands.
  const cells = new Set<string>();
  const clusterCount = 3 + Math.floor(rng() * 4);
  const perCluster = Math.ceil(target / clusterCount);
  const half = Math.floor(REGION_WIDTH / 2) - 4;
  for (let c = 0; c < clusterCount && cells.size < target; c++) {
    const cx = center.col + Math.floor((rng() - 0.5) * 2 * half);
    const cy = center.row + Math.floor((rng() - 0.5) * 2 * half);
    const r = 2 + Math.floor(rng() * 2);
    for (let dx = -r; dx <= r && cells.size < target; dx++) {
      for (let dy = -r; dy <= r && cells.size < target; dy++) {
        if (Math.abs(dx) + Math.abs(dy) > r + 1) continue;
        if (rng() < 0.2) continue;
        cells.add(`${cx + dx},${cy + dy}`);
        if (cells.size >= (c + 1) * perCluster) break;
      }
    }
  }
  return cells;
}

function genGriddedCells(rng: () => number, center: { col: number; row: number }, target: number): Set<string> {
  // Every-other-cell checkerboard pattern within a rectangle, with
  // some cells omitted. Reads as ruins or a hedge maze.
  const cells = new Set<string>();
  const side = Math.ceil(Math.sqrt(target * 2));
  const half = Math.floor(side / 2);
  for (let dx = -half; dx <= half; dx++) {
    for (let dy = -half; dy <= half; dy++) {
      // Checkerboard with a 25% chance of dropping a chosen cell.
      if ((dx + dy) % 2 !== 0) continue;
      if (rng() < 0.25) continue;
      cells.add(`${center.col + dx},${center.row + dy}`);
      if (cells.size >= target) return cells;
    }
  }
  return cells;
}

function genCellsForStyle(style: ZoneStyle, rng: () => number, center: { col: number; row: number }, target: number): Set<string> {
  switch (style) {
    case 'path': return genPathCells(rng, center, target);
    case 'delta': return genDeltaCells(rng, center, target);
    case 'dense': return genDenseCells(rng, center, target);
    case 'scattered': return genScatteredCells(rng, center, target);
    case 'archipelago': return genArchipelagoCells(rng, center, target);
    case 'gridded': return genGriddedCells(rng, center, target);
  }
}

// ─── Name generator ───────────────────────────────────────────────

function generateRoomName(rng: () => number, theme: ZoneTheme, usedNames: Set<string>): string {
  // Try adjective + noun; if collision, append a small numeric suffix
  // so every name in a zone is unique.
  for (let tries = 0; tries < 8; tries++) {
    const adj = pick(rng, theme.adjectives);
    const noun = pick(rng, theme.nouns);
    const candidate = `${adj} ${noun}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  // Suffix with a roman numeral to guarantee uniqueness.
  for (let n = 2; n < 50; n++) {
    const adj = pick(rng, theme.adjectives);
    const noun = pick(rng, theme.nouns);
    const candidate = `${adj} ${noun} ${toRoman(n)}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  // Last-ditch — should be unreachable for our theme/target sizes.
  return `${theme.displayName} Outpost ${usedNames.size}`;
}

function toRoman(n: number): string {
  const lookup: [number, string][] = [
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [v, s] of lookup) {
    while (n >= v) { out += s; n -= v; }
  }
  return out;
}

// ─── Main generator ───────────────────────────────────────────────

export interface DevWorldOutput {
  zones: ZoneDefinition[];
  tiles: WorldTileDefinition[];
}

export interface GenerateOptions {
  /** Seed for the PRNG. Same seed → identical output. */
  seed?: number;
  /** Optional GUID factory; defaults to deterministic counter ids
   *  (`dev_tile_0000` etc.) so the seed output is reproducible
   *  byte-for-byte. */
  idFactory?: () => string;
}

/**
 * Generate the full dev world (20 zones, ~1000 rooms). Deterministic
 * for a given seed; defaults to seed=1.
 */
export function generateDevWorld(opts: GenerateOptions = {}): DevWorldOutput {
  const seed = opts.seed ?? 1;
  const rng = mulberry32(seed);

  let counter = 0;
  const idFactory = opts.idFactory ?? (() => `dev_tile_${String(counter++).padStart(5, '0')}`);

  const zones: ZoneDefinition[] = [];
  const tiles: WorldTileDefinition[] = [];

  for (let i = 0; i < THEMES.length; i++) {
    const theme = THEMES[i];
    const zoneId = `${DEV_ZONE_PREFIX}${theme.key}`;
    zones.push({
      id: zoneId,
      displayName: theme.displayName,
      // Dev zones don't reference real encounters — encounter IDs that
      // don't exist in ContentStore would crash combat. Empty table is
      // safe: the encounter selector falls back gracefully.
      encounterTable: [],
      levelRange: theme.levelRange,
    });

    const center = regionCenter(i);
    const cellSet = genCellsForStyle(theme.style, rng, center, theme.targetTiles);

    const usedNames = new Set<string>();
    for (const key of cellSet) {
      const [colStr, rowStr] = key.split(',');
      const col = parseInt(colStr, 10);
      const row = parseInt(rowStr, 10);

      // Decide tile type: small chance to use a nontraversable from
      // the theme (if any), otherwise pick a traversable.
      const nontravWeight = theme.nontraversable.reduce((s, o) => s + o.weight, 0);
      const useNontrav = theme.nontraversable.length > 0 && rng() < nontravWeight / (nontravWeight + 20);
      const tileType = useNontrav
        ? pickWeighted(rng, theme.nontraversable)
        : pickWeighted(rng, theme.traversable);

      tiles.push({
        id: idFactory(),
        col,
        row,
        type: tileType,
        zone: zoneId,
        name: generateRoomName(rng, theme, usedNames),
      });
    }
  }

  return { zones, tiles };
}
