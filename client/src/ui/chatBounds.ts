export interface VerticalExtent {
  top: number;
  bottom: number;
  height: number;
}

/** Band a floating window may occupy: below visible top-docked extents, above visible bottom-docked ones (zero-height = hidden, ignored). */
export function floatingVerticalBounds(
  viewportHeight: number,
  above: readonly (VerticalExtent | null)[],
  below: readonly (VerticalExtent | null)[],
): { top: number; bottom: number } {
  let top = 0;
  let bottom = viewportHeight;
  for (const r of above) {
    if (r && r.height > 0) top = Math.max(top, r.bottom);
  }
  for (const r of below) {
    if (r && r.height > 0) bottom = Math.min(bottom, r.top);
  }
  return { top, bottom: Math.max(top, bottom) };
}
