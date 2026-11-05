/** Badge text for a count: anything above 99 reads "99+". */
export function countText(count: number): string {
  return count > 99 ? '99+' : String(count);
}
