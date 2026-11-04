import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapBaker } from '../src/ui/MapBaker';
import type { BakeRoom } from '../src/ui/MapBaker';

const WHOLE_MAP = { x: 0, y: 0, halfW: 1e6, halfH: 1e6 };

interface FakeImage {
  src: string;
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  decode: () => Promise<void>;
}

let images: FakeImage[] = [];
let drawCalls: { op: string; fillStyle: unknown; image?: unknown }[] = [];

function recordingContext(): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      return (...args: unknown[]) => {
        if (prop === 'fillText') drawCalls.push({ op: 'fillText', fillStyle: target.fillStyle });
        if (prop === 'drawImage') drawCalls.push({ op: 'drawImage', fillStyle: target.fillStyle, image: args[0] });
      };
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function room(index: number, over: Partial<BakeRoom> = {}): BakeRoom {
  return {
    index, col: index, row: 0, x: index * 60, y: 0,
    type: 'plains', zone: 'z', guid: `g${index}`, color: 0x77aa55, traversable: true,
    material: 'plain', icon: '', variant: 0, neighbors: [null, null, null, null, null, null],
    ...over,
  };
}

function bake(baker: MapBaker): void {
  baker.beginTerrain(8192, 1);
  while (!baker.stepTerrain(1000)) { /* run to the end */ }
}

async function settle(image: FakeImage): Promise<void> {
  image.onload?.();
  await Promise.resolve();
  await Promise.resolve();
}

function roomArtRequests(): string[] {
  return images.map(i => i.src).filter(src => src.includes('/tile-artwork/'));
}

describe('MapBaker', () => {
  beforeEach(() => {
    images = [];
    drawCalls = [];
    vi.stubGlobal('Path2D', class {
      moveTo() {} lineTo() {} closePath() {} quadraticCurveTo() {}
    });
    vi.stubGlobal('Image', class implements FakeImage {
      src = '';
      naturalWidth = 256;
      naturalHeight = 256;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      decode = vi.fn(async () => {});
      constructor() { images.push(this); }
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => recordingContext() as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws a landmark icon with an opaque fill, because colour emoji keep the fill alpha', () => {
    const baker = new MapBaker(() => {});
    const landmark = room(0, { icon: '🏰', type: 'keep' });
    baker.setRooms([landmark], new Set(['keep']), () => true, true);
    bake(baker);

    const icon = drawCalls.find(call => call.op === 'fillText');
    expect(icon?.fillStyle).toBe('#fff');
  });

  it('asks only for explored rooms near the view, nearest first, and a limited number at once', () => {
    const baker = new MapBaker(() => {});
    const rooms = Array.from({ length: 40 }, (_, i) => room(i));
    baker.setRooms(rooms, new Set(), r => r.index !== 1, true);
    baker.requestArt({ x: 0, y: 0, halfW: 120, halfH: 120 });

    expect(roomArtRequests().map(src => src.match(/g\d+/)![0])).toEqual(['g0', 'g2']);

    baker.requestArt(WHOLE_MAP);
    expect(roomArtRequests()).toHaveLength(12);
  });

  it('remembers a 404 for the session, also across a map change', () => {
    const baker = new MapBaker(() => {});
    const rooms = [room(0)];
    baker.setRooms(rooms, new Set(), () => true, true);
    baker.requestArt(WHOLE_MAP);
    expect(roomArtRequests()).toHaveLength(1);
    images.find(i => i.src.includes('/tile-artwork/'))!.onerror?.();

    baker.requestArt(WHOLE_MAP);
    baker.setRooms(rooms, new Set(), () => true, true);
    baker.requestArt(WHOLE_MAP);
    expect(roomArtRequests()).toHaveLength(1);

    baker.forgetFailedArt();
    baker.requestArt(WHOLE_MAP);
    expect(roomArtRequests()).toHaveLength(2);
  });

  it('decodes art before calling it ready', async () => {
    const onReady = vi.fn();
    const baker = new MapBaker(onReady);
    baker.setRooms([room(0)], new Set(), () => true, true);
    baker.requestArt(WHOLE_MAP);
    const image = images.find(i => i.src.includes('/tile-artwork/'))!;

    image.onload?.();
    expect(image.decode).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(onReady).toHaveBeenCalledOnce();
    expect(baker.hasPendingArt).toBe(true);
  });

  it('lets go of a room image once painted, then starts the next one in the queue', async () => {
    const baker = new MapBaker(() => {});
    const rooms = Array.from({ length: 14 }, (_, i) => room(i));
    baker.setRooms(rooms, new Set(), () => true, true);
    baker.requestArt(WHOLE_MAP);
    bake(baker);
    expect(roomArtRequests()).toHaveLength(12);

    const first = images.find(i => i.src.includes('/tile-artwork/g0'))!;
    await settle(first);
    baker.stepArt(1000);
    expect(drawCalls.some(call => call.image === first)).toBe(true);
    expect(roomArtRequests()).toHaveLength(13);

    drawCalls = [];
    const neighbour = room(99, { x: 60 });
    rooms[0].neighbors[0] = neighbour;
    (baker as unknown as { dirtyRooms: Set<BakeRoom> }).dirtyRooms.add(rooms[0]);
    baker.stepArt(1000);
    expect(drawCalls).toHaveLength(0);
  });

  it('reloads painted art after a re-bake, because the canvas was cleared', async () => {
    const baker = new MapBaker(() => {});
    baker.setRooms([room(0)], new Set(), () => true, true);
    baker.requestArt(WHOLE_MAP);
    bake(baker);
    await settle(images.find(i => i.src.includes('/tile-artwork/'))!);
    baker.stepArt(1000);
    expect(roomArtRequests()).toHaveLength(1);

    bake(baker);
    baker.requestArt(WHOLE_MAP);
    expect(roomArtRequests()).toHaveLength(2);
  });

  it('never asks for a full re-bake over room art, however much of the map arrives', async () => {
    const baker = new MapBaker(() => {});
    baker.setRooms([room(0), room(1)], new Set(), () => true, true);
    baker.requestArt(WHOLE_MAP);
    for (const image of images.filter(i => i.src.includes('/tile-artwork/'))) await settle(image);
    expect(baker.hasPendingArt).toBe(true);
    expect(baker.shouldRebakeForArt()).toBe(false);

    await settle(images.find(i => i.src.includes('/tile-type'))!);
    expect(baker.shouldRebakeForArt()).toBe(true);
  });

  it('checks the time budget after every room', () => {
    const baker = new MapBaker(() => {});
    baker.setRooms(Array.from({ length: 5 }, (_, i) => room(i)), new Set(), () => true, true);
    baker.beginTerrain(8192, 1);
    expect(baker.stepTerrain(-1)).toBe(false);
    expect(drawCalls.filter(call => call.op === 'drawImage')).toHaveLength(1);
  });
});
