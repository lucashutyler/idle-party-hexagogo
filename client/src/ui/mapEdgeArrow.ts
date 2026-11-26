/** Where an arrow pointing at an off-screen spot sits, in screen pixels, and which way it points. */
export interface EdgeArrow {
  x: number;
  y: number;
  /** Clockwise from pointing right, as CSS `rotate()` reads it. */
  angleDeg: number;
}

/** A box in screen pixels. */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The arrow for a screen point outside `view` shrunk by `inset` on every side, pinned to that inner edge on the line
 * from the view's centre to the point, then slid back along that line until it is `inset` clear of every `avoid` box.
 * Null while the point is inside, when the view is too small to hold an arrow, or when no spot on the line is clear.
 */
export function edgeArrowPlacement(
  point: { x: number; y: number },
  view: ScreenRect,
  inset: number,
  avoid: readonly ScreenRect[] = [],
): EdgeArrow | null {
  const cx = (view.left + view.right) / 2;
  const cy = (view.top + view.bottom) / 2;
  const halfW = (view.right - view.left) / 2 - inset;
  const halfH = (view.bottom - view.top) / 2 - inset;
  if (!(halfW > 0 && halfH > 0) || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const dx = point.x - cx;
  const dy = point.y - cy;
  if (Math.abs(dx) <= halfW && Math.abs(dy) <= halfH) return null;
  const scale = Math.min(dx === 0 ? Infinity : halfW / Math.abs(dx), dy === 0 ? Infinity : halfH / Math.abs(dy));
  let x = cx + dx * scale;
  let y = cy + dy * scale;
  for (let slides = 0; slides <= avoid.length; slides++) {
    const box = avoid.find(r => x > r.left - inset && x < r.right + inset && y > r.top - inset && y < r.bottom + inset);
    if (!box) return { x, y, angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI };
    const exitX = x > cx ? (x - (box.left - inset)) / (x - cx) : x < cx ? (box.right + inset - x) / (cx - x) : Infinity;
    const exitY = y > cy ? (y - (box.top - inset)) / (y - cy) : y < cy ? (box.bottom + inset - y) / (cy - y) : Infinity;
    const along = Math.min(exitX, exitY);
    if (along >= 1) return null;
    const nextX = x + (cx - x) * along;
    const nextY = y + (cy - y) * along;
    x = exitX <= exitY ? (x > cx ? box.left - inset : box.right + inset) : nextX;
    y = exitY <= exitX ? (y > cy ? box.top - inset : box.bottom + inset) : nextY;
  }
  return null;
}
