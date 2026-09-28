import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DungeonDefinition, ForecastResult, ServerForecastMessage } from '@idle-party-rpg/shared';
import { DungeonEntryPopup } from '../src/ui/DungeonEntryPopup';
import type { GameClient } from '../src/network/GameClient';

const dungeon: DungeonDefinition = {
  id: 'trial',
  name: 'Crystal Caves Trial',
  description: 'A trial.',
  floors: [
    { gridShape: { cols: 3, rows: 3 }, encounterTable: [] },
    { gridShape: { cols: 3, rows: 3 }, encounterTable: [] },
    { gridShape: { cols: 3, rows: 3 }, encounterTable: [], isBoss: true, checkpoints: [0.66, 0.33], maxWipes: 3 },
  ],
  entryRequirements: { minLevel: 5 },
} as unknown as DungeonDefinition;

function result(overrides: Partial<ForecastResult> = {}): ForecastResult {
  return {
    key: 'v|1|pk1|dungeon:trial:2:1:1', partyKey: 'pk1', sims: 40, wins: 28, losses: 12, stalemates: 0,
    winPct: 70, ci: [55, 82], medianMs: 12 * 60_000, p90Ms: null, atMs: 0, killEtaMs: null, reasons: [],
    floors: [{ floor: 1, winPct: 100 }, { floor: 2, winPct: 100 }, { floor: 3, winPct: 70, boss: true, attempts: 2 }],
    firstTryPct: 40,
    ...overrides,
  };
}

function fakeClient(cached: ServerForecastMessage | null = null, previous: ServerForecastMessage | null = null) {
  let listener: ((msg: ServerForecastMessage) => void) | null = null;
  return {
    lastState: { social: { party: { forecastKey: 'pk1' } }, itemDefinitions: {} },
    requestForecast: vi.fn(() => cached),
    peekForecast: vi.fn(() => previous),
    sendEnterDungeon: vi.fn(),
    onForecast(cb: (msg: ServerForecastMessage) => void) {
      listener = cb;
      return () => { listener = null; };
    },
    emit(msg: ServerForecastMessage) {
      listener?.(msg);
    },
    get listening() {
      return listener !== null;
    },
  };
}

function message(r: ForecastResult | null, status: ServerForecastMessage['status'] = 'ok'): ServerForecastMessage {
  return { type: 'forecast', target: { kind: 'dungeon', dungeonId: 'trial' }, key: r?.key ?? '', result: r, status };
}

describe('DungeonEntryPopup', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('opens on the modal stack and releases on hide', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    const overlay = document.querySelector('.dungeon-entry-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('flex');
    expect(parseInt(overlay.style.zIndex, 10)).toBeGreaterThanOrEqual(1500);
    popup.hide();
    expect(overlay.style.display).toBe('none');
    expect(overlay.style.zIndex).toBe('');
    expect(client.listening).toBe(false);
  });

  it('requests the dungeon forecast and shows a loading card until it arrives', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    expect(client.requestForecast).toHaveBeenCalledWith({ kind: 'dungeon', dungeonId: 'trial' });
    const card = document.querySelector('.dungeon-entry-forecast') as HTMLElement;
    expect(card.dataset.state).toBe('loading');
    expect(card.querySelectorAll('.dungeon-floor-pip')).toHaveLength(3);

    client.emit(message(result()));
    expect(card.dataset.state).toBe('ready');
    expect(card.querySelector('.dungeon-entry-forecast-verdict')!.textContent).toBe('Likely');
    expect(card.querySelector('.dungeon-entry-forecast-headline')!.textContent).toBe('Clears ~7 in 10 runs · ~12 min each');
    expect(card.textContent).toContain('Boss beaten on the first try: 40 %');
    expect(card.textContent).toContain('Win chance ~70\u202f%, likely 55–82\u202f%');
    expect(card.querySelector('.forecast-foot')!.textContent).toBe('Estimate from 40 simulated runs');
    popup.hide();
  });

  it('marks the floor strip and the resume point', () => {
    const client = fakeClient(message(result()));
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    const pips = [...document.querySelectorAll<HTMLElement>('.dungeon-floor-pip')];
    expect(pips.map(p => p.dataset.passed ?? '')).toEqual(['true', 'true', '']);
    expect(pips[2].dataset.boss).toBe('true');
    expect(pips[2].dataset.checkpoint).toBe('true');
    expect(pips[2].dataset.resume).toBe('true');
    expect(pips[2].dataset.band).toBe('1');
    expect(document.querySelector('.dungeon-entry-resume')!.textContent).toContain('Resume: Floor 3 · Checkpoint 1 · 2 retries left');
    popup.hide();
  });

  it('keeps cleared floors plain when a resumed forecast only lists the boss floor', () => {
    const client = fakeClient(message(result({ floors: [{ floor: 3, winPct: 0, boss: true, attempts: 3 }] })));
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    const pips = [...document.querySelectorAll<HTMLElement>('.dungeon-floor-pip')];
    expect(pips.map(p => p.dataset.boss ?? '')).toEqual(['', '', 'true']);
    expect(pips.map(p => p.dataset.band ?? '')).toEqual(['', '', '3']);
    expect(pips.map(p => p.querySelector('.dungeon-floor-glyph')!.textContent)).toEqual(['1', '2', '♛']);
    popup.hide();
  });

  it('shows no resume marker for a fresh start', () => {
    const client = fakeClient(message(result({ key: 'v|1|pk1|dungeon:trial:0:0:0' })));
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    expect(document.querySelector('.dungeon-entry-resume')).toBeNull();
    expect(document.querySelector('.dungeon-floor-pip[data-resume]')).toBeNull();
    popup.hide();
  });

  it('explains checkpoint regroups when a floor has checkpoints', () => {
    const popup = new DungeonEntryPopup(fakeClient() as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    expect(document.querySelector('.dungeon-entry-warning')!.textContent).toBe(
      'Falling on the boss floor regroups your party at its last checkpoint (up to 3 times). Falling anywhere else sends you back to this entrance.',
    );
    popup.show({ ...dungeon, floors: [dungeon.floors[0]] } as DungeonDefinition, 1, 2);
    expect(document.querySelector('.dungeon-entry-warning')!.textContent).toBe('If your party is defeated, you\'ll be sent back to this entrance.');
    popup.hide();
  });

  it('is read-only for members, with a note on whose progress counts', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2, { canEnter: false });
    const enter = document.querySelector('.dungeon-entry-enter') as HTMLButtonElement;
    expect(enter.disabled).toBe(true);
    enter.click();
    expect(client.sendEnterDungeon).not.toHaveBeenCalled();
    expect(document.querySelector('.dungeon-entry-note')!.textContent).toBe('Your party leader\'s progress decides where you start.');
    popup.hide();
  });

  it('enters for leaders', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    expect(document.querySelector('.dungeon-entry-note')).toBeNull();
    (document.querySelector('.dungeon-entry-enter') as HTMLButtonElement).click();
    expect(client.sendEnterDungeon).toHaveBeenCalledWith(1, 2, 'trial');
  });

  it('keeps showing the last estimate, dimmed, when the server cannot compute a new one', () => {
    const client = fakeClient(message(null, 'unavailable'), message(result()));
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    const card = document.querySelector('.dungeon-entry-forecast') as HTMLElement;
    expect(card.dataset.state).toBe('stale');
    expect(card.querySelector('.forecast-foot')!.textContent).toContain('updating…');
    client.emit(message(null, 'unavailable'));
    expect(card.dataset.state).toBe('stale');
    popup.hide();
  });

  it('hides the forecast when unavailable and nothing was estimated before', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    client.emit(message(null, 'unavailable'));
    expect((document.querySelector('.dungeon-entry-forecast') as HTMLElement).dataset.state).toBe('none');
    popup.hide();
  });

  it('marks results for another party as stale and hides denied forecasts', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(dungeon, 1, 2);
    client.emit(message(result({ partyKey: 'old' })));
    const card = document.querySelector('.dungeon-entry-forecast') as HTMLElement;
    expect(card.dataset.state).toBe('stale');
    client.emit(message(null, 'denied'));
    expect(card.dataset.state).toBe('none');
    client.emit({ ...message(result()), target: { kind: 'dungeon', dungeonId: 'other' } });
    expect(card.dataset.state).toBe('none');
    popup.hide();
  });
});
