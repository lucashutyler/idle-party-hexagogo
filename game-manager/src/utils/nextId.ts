/**
 * Compute the next auto-increment ID from a set of existing keys.
 * Parses all keys as integers, finds the max, and returns max + 1.
 * Non-numeric keys (e.g. legacy "goblin") are skipped.
 * Returns "1" if no numeric keys exist.
 */
export function nextId(existingKeys: string[]): string {
  let max = 0;
  for (const key of existingKeys) {
    const n = parseInt(key, 10);
    if (!isNaN(n) && n > max) {
      max = n;
    }
  }
  return String(max + 1);
}
