/** 1 / sum of squared shares: how many layouts would share the lead if they shared it evenly. */
export function effectiveNumber(counts: readonly number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return 1 / counts.reduce((sum, c) => sum + (c / total) ** 2, 0);
}

/** Greedy smallest set of keys covering every stop, where each stop lists the keys that serve it. */
export function coverOfStops(stops: readonly (readonly string[])[]): string[] {
  const left = new Set(stops.map((_, i) => i));
  const cover: string[] = [];
  while (left.size > 0) {
    const score = new Map<string, number>();
    for (const i of left) for (const key of stops[i]) score.set(key, (score.get(key) ?? 0) + 1);
    let best: string | undefined;
    let bestScore = 0;
    for (const [key, s] of [...score].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (s > bestScore) {
        best = key;
        bestScore = s;
      }
    }
    if (best === undefined) break;
    cover.push(best);
    for (const i of [...left]) if (stops[i].includes(best)) left.delete(i);
  }
  return cover;
}

export interface Domination {
  /** Rooms both win. */
  shared: number;
  /** Of those, share where the other layout earns over `margin` more. */
  worseShare: number;
  /** Rooms this layout wins that the other doesn't, as a share of its rooms. */
  extraShare: number;
  medianRatio: number;
}

/** Room by room against one other layout. */
export function compareLayouts(mine: ReadonlyMap<string, number>, other: ReadonlyMap<string, number>, margin: number): Domination {
  const ratios: number[] = [];
  let worse = 0;
  let extra = 0;
  for (const [room, xp] of mine) {
    const theirs = other.get(room);
    if (theirs === undefined) {
      extra++;
      continue;
    }
    const r = theirs / xp;
    ratios.push(r);
    if (r > 1 + margin) worse++;
  }
  ratios.sort((a, b) => a - b);
  return {
    shared: ratios.length,
    worseShare: ratios.length ? worse / ratios.length : 0,
    extraShare: mine.size ? extra / mine.size : 0,
    medianRatio: ratios.length ? ratios[ratios.length >> 1] : NaN,
  };
}

export interface SpreadRow {
  y: number;
  room: number;
  level: number;
  region: number;
  layout: string;
}

export interface SpreadShares {
  cells: number;
  /** Shares of the spread left once room and level are taken out. */
  layout: number;
  layoutByLevel: number;
  layoutByRegion: number;
  layoutByRoom: number;
  rest: number;
  /** Per layout and room: mean log residual once room, level and layout at this level are taken out. */
  favour: Map<string, { layout: string; room: number; effect: number; pairs: number }>;
}

const FIT_ITERATIONS = 300;
const FIT_CONVERGED = 1e-5;

/** Backfits additive effects; returns the residuals. */
function fitEffects(rows: readonly SpreadRow[], factors: readonly ((r: SpreadRow) => string)[]): Float64Array {
  const n = rows.length;
  const mean = rows.reduce((sum, r) => sum + r.y, 0) / Math.max(1, n);
  const codes = factors.map(factor => {
    const index = new Map<string, number>();
    const coded = new Int32Array(n);
    rows.forEach((r, i) => {
      const key = factor(r);
      let code = index.get(key);
      if (code === undefined) {
        code = index.size;
        index.set(key, code);
      }
      coded[i] = code;
    });
    return { coded, size: index.size };
  });
  const effects = codes.map(c => new Float64Array(c.size));
  const residual = new Float64Array(n);
  rows.forEach((r, i) => {
    residual[i] = r.y - mean;
  });
  for (let iteration = 0; iteration < FIT_ITERATIONS; iteration++) {
    let delta = 0;
    codes.forEach(({ coded, size }, k) => {
      const sums = new Float64Array(size);
      const counts = new Int32Array(size);
      for (let i = 0; i < n; i++) {
        sums[coded[i]] += residual[i] + effects[k][coded[i]];
        counts[coded[i]]++;
      }
      for (let code = 0; code < size; code++) {
        const next = counts[code] ? sums[code] / counts[code] : 0;
        delta = Math.max(delta, Math.abs(next - effects[k][code]));
        sums[code] = next - effects[k][code];
        effects[k][code] = next;
      }
      for (let i = 0; i < n; i++) residual[i] -= sums[coded[i]];
    });
    if (delta < FIT_CONVERGED) break;
  }
  return residual;
}

function sumSquares(values: Float64Array): number {
  let total = 0;
  for (const v of values) total += v * v;
  return total;
}

/**
 * How much of the spread in log XP/hr, once room and level are out, each layout term explains, added in turn:
 * layout alone (simply better everywhere), layout at this level, layout in this region, layout in this room.
 */
export function layoutSpread(rows: readonly SpreadRow[]): SpreadShares {
  const room = (r: SpreadRow): string => `${r.room}`;
  const level = (r: SpreadRow): string => `${r.level}`;
  const layout = (r: SpreadRow): string => r.layout;
  const layoutLevel = (r: SpreadRow): string => `${r.layout}|${r.level}`;
  const layoutRegion = (r: SpreadRow): string => `${r.layout}|${r.region}`;
  const layoutRoom = (r: SpreadRow): string => `${r.layout}|${r.room}`;
  const within = sumSquares(fitEffects(rows, [room, level]));
  const afterLayout = sumSquares(fitEffects(rows, [room, level, layout]));
  const stageResidual = fitEffects(rows, [room, level, layoutLevel]);
  const afterLevel = sumSquares(stageResidual);
  const afterRegion = sumSquares(fitEffects(rows, [room, level, layoutLevel, layoutRegion]));
  const afterRoom = sumSquares(fitEffects(rows, [room, level, layoutLevel, layoutRoom]));
  const share = (value: number): number => (within > 0 ? Math.max(0, value) / within : 0);
  const favour = new Map<string, { layout: string; room: number; effect: number; pairs: number }>();
  rows.forEach((r, i) => {
    const key = `${r.layout}|${r.room}`;
    const entry = favour.get(key) ?? { layout: r.layout, room: r.room, effect: 0, pairs: 0 };
    entry.effect += stageResidual[i];
    entry.pairs++;
    favour.set(key, entry);
  });
  for (const entry of favour.values()) entry.effect /= entry.pairs;
  return {
    cells: rows.length,
    layout: share(within - afterLayout),
    layoutByLevel: share(afterLayout - afterLevel),
    layoutByRegion: share(afterLevel - afterRegion),
    layoutByRoom: share(afterRegion - afterRoom),
    rest: share(afterRoom),
    favour,
  };
}
