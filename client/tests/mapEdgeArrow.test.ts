import { describe, expect, it } from 'vitest';
import { edgeArrowPlacement } from '../src/ui/mapEdgeArrow';

const VIEW = { left: 0, top: 0, right: 400, bottom: 300 };
const INSET = 30;

describe('edgeArrowPlacement', () => {
  it('gives no arrow for a point on screen, up to the inset from the edge', () => {
    expect(edgeArrowPlacement({ x: 200, y: 150 }, VIEW, INSET)).toBeNull();
    expect(edgeArrowPlacement({ x: INSET, y: INSET }, VIEW, INSET)).toBeNull();
    expect(edgeArrowPlacement({ x: 400 - INSET, y: 300 - INSET }, VIEW, INSET)).toBeNull();
  });

  it.each([
    ['right', { x: 900, y: 150 }, { x: 370, y: 150, angleDeg: 0 }],
    ['bottom', { x: 200, y: 900 }, { x: 200, y: 270, angleDeg: 90 }],
    ['left', { x: -500, y: 150 }, { x: 30, y: 150, angleDeg: 180 }],
    ['top', { x: 200, y: -500 }, { x: 200, y: 30, angleDeg: -90 }],
  ])('pins a point off the %s edge to it, pointing out', (_edge, point, expected) => {
    const arrow = edgeArrowPlacement(point, VIEW, INSET)!;
    expect(arrow.x).toBeCloseTo(expected.x, 6);
    expect(arrow.y).toBeCloseTo(expected.y, 6);
    expect(arrow.angleDeg).toBeCloseTo(expected.angleDeg, 6);
  });

  it('pins a point past a corner into that corner, pointing diagonally', () => {
    const arrow = edgeArrowPlacement({ x: 200 + 1700, y: 150 + 1200 }, VIEW, INSET)!;
    expect(arrow.x).toBeCloseTo(370, 6);
    expect(arrow.y).toBeCloseTo(270, 6);
    expect(arrow.angleDeg).toBeCloseTo((Math.atan2(1200, 1700) * 180) / Math.PI, 6);

    const topLeft = edgeArrowPlacement({ x: 200 - 1700, y: 150 - 1200 }, VIEW, INSET)!;
    expect(topLeft.x).toBeCloseTo(30, 6);
    expect(topLeft.y).toBeCloseTo(30, 6);
    expect(topLeft.angleDeg).toBeCloseTo((Math.atan2(-1200, -1700) * 180) / Math.PI, 6);
  });

  it('stays on the line from the centre, on whichever edge it meets first', () => {
    const arrow = edgeArrowPlacement({ x: 1200, y: 400 }, VIEW, INSET)!;
    expect(arrow.x).toBeCloseTo(370, 6);
    expect((arrow.y - 150) / (arrow.x - 200)).toBeCloseTo((400 - 150) / (1200 - 200), 6);
  });

  it('keeps a bigger inset off the edge', () => {
    expect(edgeArrowPlacement({ x: 900, y: 150 }, VIEW, 50)!.x).toBeCloseTo(350, 6);
    expect(edgeArrowPlacement({ x: 360, y: 150 }, VIEW, 50)!.x).toBeCloseTo(350, 6);
    expect(edgeArrowPlacement({ x: 360, y: 150 }, VIEW, 30)).toBeNull();
  });

  it('gives no arrow in a view too small to hold one, or for a point it cannot place', () => {
    expect(edgeArrowPlacement({ x: 900, y: 10 }, { left: 0, top: 0, right: 50, bottom: 300 }, INSET)).toBeNull();
    expect(edgeArrowPlacement({ x: NaN, y: 10 }, VIEW, INSET)).toBeNull();
  });

  it('works in the part of the map a docked sheet leaves, so a spot under the sheet counts as off screen', () => {
    const aboveSheet = { left: 0, top: 0, right: 400, bottom: 188 };
    const underSheet = { x: 200, y: 250 };
    expect(edgeArrowPlacement(underSheet, VIEW, INSET)).toBeNull();
    const arrow = edgeArrowPlacement(underSheet, aboveSheet, INSET)!;
    expect(arrow.x).toBeCloseTo(200, 6);
    expect(arrow.y).toBeCloseTo(158, 6);
    expect(arrow.angleDeg).toBeCloseTo(90, 6);

    const leftOfSideSheet = { left: 0, top: 0, right: 720 - 320, bottom: 300 };
    expect(edgeArrowPlacement({ x: 500, y: 150 }, leftOfSideSheet, INSET)!.x).toBeCloseTo(370, 6);
  });

  it('slides back along the line toward the centre until it is clear of the controls over the map', () => {
    const zoomColumn = { left: 344, top: 82, right: 388, bottom: 288 };
    const right = edgeArrowPlacement({ x: 900, y: 200 }, VIEW, INSET, [zoomColumn])!;
    expect(right.x).toBeCloseTo(zoomColumn.left - INSET, 6);
    expect((right.y - 150) / (right.x - 200)).toBeCloseTo((200 - 150) / (900 - 200), 6);
    expect(right.angleDeg).toBeCloseTo((Math.atan2(50, 700) * 180) / Math.PI, 6);

    const corner = edgeArrowPlacement({ x: 200 + 1700, y: 150 + 1200 }, VIEW, INSET, [zoomColumn])!;
    expect(corner.x <= zoomColumn.left - INSET || corner.y >= zoomColumn.bottom + INSET).toBe(true);
    expect((corner.y - 150) / (corner.x - 200)).toBeCloseTo(1200 / 1700, 6);

    expect(edgeArrowPlacement({ x: 900, y: -300 }, VIEW, INSET, [zoomColumn])!.x).toBeCloseTo(370, 6);
  });

  it('clears one box after another, and gives up when they cover the way to the centre', () => {
    const lower = { left: 0, top: 244, right: 300, bottom: 300 };
    const upper = { left: 0, top: 190, right: 400, bottom: 214 };
    const down = edgeArrowPlacement({ x: 200, y: 900 }, VIEW, INSET, [lower, upper])!;
    expect(down.x).toBeCloseTo(200, 6);
    expect(down.y).toBeCloseTo(upper.top - INSET, 6);

    expect(edgeArrowPlacement({ x: 200, y: 900 }, VIEW, INSET, [{ left: 0, top: 100, right: 400, bottom: 300 }])).toBeNull();
  });
});
