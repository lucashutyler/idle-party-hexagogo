import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForecastResult } from '@idle-party-rpg/shared';
import { RoomView } from '../src/ui/RoomView';
import type { RoomForecastProvider } from '../src/ui/RoomView';
import type { TileClickInfo } from '../src/ui/ThreeWorldMap';

function makeInfo(overrides: Partial<TileClickInfo> = {}): TileClickInfo {
  return {
    col: 3, row: 4, tileType: 'Plains', zoneName: 'Hatchetmill', roomName: 'Town Square', zoneId: 'hatchetmill',
    isTraversable: true, isUnlocked: true, isSameZone: true, isCurrentTile: false, playersHere: [], partyMemberUsernames: [],
    ...overrides,
  };
}

function result(overrides: Partial<ForecastResult> = {}): ForecastResult {
  return {
    key: 'k', partyKey: 'pk', sims: 200, wins: 184, losses: 16, stalemates: 0, winPct: 92, ci: [88, 95],
    medianMs: 12_000, p90Ms: null, atMs: 0, killEtaMs: null, reasons: [], ...overrides,
  };
}

function setup(provider: RoomForecastProvider) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new RoomView(parent, () => {}, undefined, undefined, undefined, undefined, undefined, provider);
  return { parent, view };
}

describe('RoomView forecast slot', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders no slot without a provider or a forecast room', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const plain = new RoomView(parent, () => {});
    plain.forecastTileId = 't1';
    plain.show(makeInfo());
    expect(parent.querySelector('.room-view-forecast')).toBeNull();

    const { parent: p2, view } = setup(() => 'loading');
    view.forecastTileId = null;
    view.show(makeInfo());
    expect(p2.querySelector('.room-view-forecast')).toBeNull();
  });

  it('asks the provider for the room and shows a loading chip, then patches in the result', () => {
    const provider = vi.fn<RoomForecastProvider>(() => 'loading');
    const { parent, view } = setup(provider);
    view.forecastTileId = 't1';
    view.show(makeInfo({ isCurrentTile: true }));
    expect(provider).toHaveBeenCalledWith('t1');
    const slot = parent.querySelector('.room-view-forecast') as HTMLElement;
    expect(slot.dataset.state).toBe('loading');
    expect(slot.previousElementSibling?.classList.contains('room-view-header')).toBe(true);

    view.updateForecast('t1', { result: result(), autoRetreat: 25 });
    expect(slot.dataset.state).toBe('ready');
    expect(slot.querySelector('.room-view-forecast-text')!.textContent).toBe('Wins ~9 in 10 fights · ~0:12 each');
    expect(slot.querySelector('.forecast-chip')!.getAttribute('data-verdict')).toBe('safe');
  });

  it('ignores updates for other rooms or while hidden', () => {
    const { parent, view } = setup(() => 'loading');
    view.forecastTileId = 't1';
    view.show(makeInfo());
    view.updateForecast('t2', { result: result() });
    const slot = parent.querySelector('.room-view-forecast') as HTMLElement;
    expect(slot.dataset.state).toBe('loading');
    view.hide();
    view.updateForecast('t1', { result: result() });
    expect(slot.dataset.state).toBe('loading');
  });

  it('places the remote-room chip after the room name and hides it when unavailable', () => {
    const { parent, view } = setup(() => ({ result: result({ winPct: 55, ci: [48, 62] }) }));
    view.forecastTileId = 't9';
    view.show(makeInfo({ isCurrentTile: false }));
    const slot = parent.querySelector('.room-view-forecast') as HTMLElement;
    expect(slot.previousElementSibling?.classList.contains('room-view-name')).toBe(true);
    expect(slot.querySelector('.forecast-chip')!.getAttribute('data-verdict')).toBe('slow');
    view.updateForecast('t9', null);
    expect(slot.hidden).toBe(true);
  });

  it('expands the details popover on tap, keeping it open across updates', () => {
    const { parent, view } = setup(() => ({ result: result(), autoRetreat: { belowPct: 40, setBy: 'owner' } }));
    view.forecastTileId = 't1';
    view.show(makeInfo({ isCurrentTile: true }));
    const slot = parent.querySelector('.room-view-forecast') as HTMLElement;
    const details = () => slot.querySelector('.room-view-forecast-details') as HTMLElement;
    expect(details().hidden).toBe(true);
    (slot.querySelector('.room-view-forecast-btn') as HTMLButtonElement).click();
    expect(details().hidden).toBe(false);
    expect(details().querySelector('.forecast-retreat')!.textContent).toContain('below 40');
    view.updateForecast('t1', { result: result({ winPct: 60, ci: [55, 65] }) });
    expect(details().hidden).toBe(false);
    expect(slot.querySelector('.room-view-forecast-btn')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('marks stale results', () => {
    const { parent, view } = setup(() => ({ result: result(), stale: true }));
    view.forecastTileId = 't1';
    view.show(makeInfo());
    expect((parent.querySelector('.room-view-forecast') as HTMLElement).dataset.state).toBe('stale');
    expect(parent.querySelector('.forecast-chip')!.getAttribute('data-state')).toBe('stale');
    expect(parent.querySelector('.room-view-forecast-text')!.textContent).toBe('Wins ~9 in 10 fights · ~0:12 each · updating…');
  });
});
