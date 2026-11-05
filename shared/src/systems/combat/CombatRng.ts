/** Seeded mulberry32 generator returning floats in [0, 1), a drop-in for `Math.random`. */
export function createRng(seed: number): () => number {
  let a = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
