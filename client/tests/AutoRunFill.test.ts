// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerBattleState } from '@idle-party-rpg/shared';
import { AUTO_RUN_FILL_HTML, AutoRunFill } from '../src/ui/AutoRunFill';
import { setReducedMotionOverride } from '../src/ui/motion';

const battle = (over: Partial<ServerBattleState> = {}): ServerBattleState =>
  ({ state: 'battle', visual: 'fighting', duration: 0, ...over });

function button() {
  const el = document.createElement('button');
  el.innerHTML = `${AUTO_RUN_FILL_HTML}Autorun`;
  const bar = el.querySelector<HTMLElement>('.autorun-fill')!;
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ finished: Promise.resolve(), cancel }) as unknown as Animation);
  bar.animate = animate;
  return { el, bar, animate, cancel };
}

const frames = (from: number) => [{ transform: `scaleX(${from})` }, { transform: 'scaleX(1)' }];

describe('AutoRunFill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotionOverride(false);
  });
  afterEach(() => {
    setReducedMotionOverride(null);
    vi.useRealTimers();
  });

  it('fills from empty over the whole wait', () => {
    const b = button();
    new AutoRunFill().paint(b.el, battle({ autoRunWalking: true, autoRunLeaveMs: 600 }), Date.now());
    expect(b.animate).toHaveBeenCalledWith(frames(0), { duration: 600, easing: 'linear' });
  });

  it('picks up part way through a wait it joins late, and a replayed old update is already full', () => {
    const late = button();
    new AutoRunFill().paint(late.el, battle({ autoRunWalking: true, autoRunLeaveMs: 300 }), Date.now());
    expect(late.animate).toHaveBeenCalledWith(frames(0.5), { duration: 300, easing: 'linear' });

    const old = button();
    new AutoRunFill().paint(old.el, battle({ autoRunWalking: true, autoRunLeaveMs: 600 }), Date.now() - 5000);
    expect(old.animate).toHaveBeenCalledWith(frames(1), { duration: 0, easing: 'linear' });
  });

  it('leaves a running fill alone on a repaint, and carries it onto a rebuilt button', () => {
    const fill = new AutoRunFill();
    const first = button();
    const receivedAt = Date.now();
    const waiting = battle({ autoRunWalking: true, autoRunLeaveMs: 600 });
    fill.paint(first.el, waiting, receivedAt);
    vi.advanceTimersByTime(200);
    fill.paint(first.el, waiting, receivedAt);
    expect(first.animate).toHaveBeenCalledTimes(1);

    const rebuilt = button();
    fill.paint(rebuilt.el, waiting, receivedAt);
    expect(rebuilt.animate).toHaveBeenCalledWith(frames(1 - 400 / 600), { duration: 400, easing: 'linear' });
  });

  it('starts again for the next room', () => {
    const fill = new AutoRunFill();
    const b = button();
    fill.paint(b.el, battle({ autoRunWalking: true, autoRunLeaveMs: 600 }), Date.now());
    vi.advanceTimersByTime(1000);
    fill.paint(b.el, battle({ autoRunWalking: true, autoRunLeaveMs: 600 }), Date.now());
    expect(b.animate).toHaveBeenCalledTimes(2);
    expect(b.cancel).toHaveBeenCalled();
  });

  it('holds full while the party walks, and empties when Autorun stops or the party regroups', () => {
    const fill = new AutoRunFill();
    const b = button();
    fill.paint(b.el, battle({ visual: 'none', autoRunWalking: true }), Date.now());
    expect(b.bar.style.transform).toBe('scaleX(1)');
    fill.paint(b.el, battle(), Date.now());
    expect(b.bar.style.transform).toBe('scaleX(0)');
    fill.paint(b.el, battle({ autoRunWalking: true, regroupMs: 30_000 }), Date.now());
    expect(b.bar.style.transform).toBe('scaleX(0)');
    expect(b.animate).not.toHaveBeenCalled();
  });

  it('does not move for a player who asked for reduced motion', () => {
    setReducedMotionOverride(true);
    const b = button();
    new AutoRunFill().paint(b.el, battle({ autoRunWalking: true, autoRunLeaveMs: 600 }), Date.now());
    expect(b.bar.style.transform).toBe('scaleX(1)');
    expect(b.animate).not.toHaveBeenCalled();
  });
});
