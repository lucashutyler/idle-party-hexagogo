import { AUTO_RUN_ROOM_MS, MOVE_DURATION, type ServerBattleState } from '@idle-party-rpg/shared';
import { fx, reducedMotion } from './motion';

/** How long Autorun waits in each fight before it walks on. */
const WAIT_MS = AUTO_RUN_ROOM_MS - MOVE_DURATION;
/** Updates about one wait agree on its end this closely; a bigger move means a new wait. */
const SAME_WAIT_MS = 150;

export const AUTO_RUN_FILL_HTML = '<span class="autorun-fill" aria-hidden="true"></span>';

/** A button's timer: it fills while Autorun waits to leave a fight, and stays full while the party walks. */
export class AutoRunFill {
  private bar: HTMLElement | null = null;
  private anim: Animation | null = null;
  private endsAt = 0;

  /** Safe on every repaint, a rebuilt button included. `receivedAt` is when `battle` arrived (`Date.now()`). */
  paint(button: Element, battle: ServerBattleState | undefined, receivedAt: number): void {
    const bar = button.querySelector<HTMLElement>('.autorun-fill');
    if (!bar) return;
    if (!battle?.autoRunWalking || battle.regroupMs) {
      this.hold(bar, 0);
      return;
    }
    if (battle.autoRunLeaveMs === undefined || reducedMotion()) {
      this.hold(bar, 1);
      return;
    }
    const endsAt = (receivedAt || Date.now()) + battle.autoRunLeaveMs;
    if (this.anim && bar === this.bar && Math.abs(endsAt - this.endsAt) < SAME_WAIT_MS) return;
    this.hold(bar, 1);
    const leftMs = Math.max(0, endsAt - Date.now());
    const from = 1 - Math.min(1, leftMs / WAIT_MS);
    this.endsAt = endsAt;
    this.anim = fx(bar, [{ transform: `scaleX(${from})` }, { transform: 'scaleX(1)' }], { duration: leftMs, easing: 'linear' });
  }

  private hold(bar: HTMLElement, scale: 0 | 1): void {
    this.anim?.cancel();
    this.anim = null;
    this.bar = bar;
    bar.style.transform = `scaleX(${scale})`;
  }
}
