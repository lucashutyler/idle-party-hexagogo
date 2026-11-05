import { describe, expect, it } from 'vitest';
import type { ForecastResult, ServerForecastMessage } from '@idle-party-rpg/shared';
import { headerOpensLog, mergeLiveForecast } from '../src/screens/CombatScreen';

describe('headerOpensLog', () => {
  it('opens the log from the header only on short screens with the chat sheet closed', () => {
    expect(headerOpensLog(true, false)).toBe(true);
    expect(headerOpensLog(true, true)).toBe(false);
    expect(headerOpensLog(false, false)).toBe(false);
    expect(headerOpensLog(false, true)).toBe(false);
  });
});

describe('mergeLiveForecast', () => {
  const result = { key: 'battle:7:1000', winPct: 62 } as unknown as ForecastResult;
  const msg = (status: ServerForecastMessage['status'], r: ForecastResult | null = null): ServerForecastMessage =>
    ({ type: 'forecast', target: { kind: 'battle', battleId: 7 }, key: r?.key ?? '', result: r, status });

  it('keeps the last estimate, marked as updating, while a re-forecast is pending', () => {
    const first = mergeLiveForecast(undefined, msg('pending'));
    expect(first).toEqual({ result: null, pending: true });
    const ready = mergeLiveForecast(first, msg('ok', result));
    expect(ready).toEqual({ result, pending: false });
    expect(mergeLiveForecast(ready, msg('pending'))).toEqual({ result, pending: true });
  });

  it('drops the estimate when the server has none', () => {
    const ready = mergeLiveForecast(undefined, msg('ok', result));
    expect(mergeLiveForecast(ready, msg('unavailable'))).toEqual({ result: null, pending: false });
    expect(mergeLiveForecast(ready, msg('ok'))).toEqual({ result: null, pending: false });
  });
});
