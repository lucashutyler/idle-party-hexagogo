import {
  RESULT_PAUSE,
  MOVE_DURATION,
  COMBAT_STEP_MS,
  COMBAT_SEND_MS,
  COMBAT_SNAPSHOT_MS,
  KILL_BEAT_MS,
  RUN_AVAILABLE_MS,
  combatRealElapsedMs,
  combatRealStepMs,
  processCombatStep,
} from '@idle-party-rpg/shared';
import type {
  BattleTimerState,
  BattleResult,
  BattleVisual,
  CombatEvent,
  PartyCombatState,
} from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty.js';

export const LIVE_LOG_RING_SIZE = 30;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

let nextBattleId = Date.now();

export type CombatSnapshotKind = 'full' | 'dynamic';

/** One batch of live combat output, handed to the delivery layer. */
export interface CombatFlush {
  battleId: number;
  combat: PartyCombatState;
  events: CombatEvent[];
  log: string[];
  /** Which snapshot to attach, if any. Building it is left to the receiver (skipped when nobody listens). */
  snapshot: CombatSnapshotKind | null;
}

export interface ServerBattleCallbacks {
  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  onMove?: () => void;
  canMoveToNextTile?: () => boolean;
  onCombatFlush?: (flush: CombatFlush) => void;
  /** A retreat is ending battle `battleId`; runs before the party moves on, so it may still set the route. */
  onRetreat?: (battleId: number) => void;
}

/** Drives one party's battle loop. See docs/architecture/combat.md (battle state machine). */
export class ServerBattleTimer {
  private party: ServerParty;
  private label: string;
  private state: BattleTimerState = 'battle';
  private currentVisual: BattleVisual = 'none';
  private currentResult?: BattleResult;
  private battleDuration = 0;
  private currentBattleId = 0;

  private started = false;
  private destroyed = false;
  private consecutiveFailures = 0;
  private loggedFailureBattleId = -1;

  private stepInterval?: ReturnType<typeof setInterval>;
  private killBeatTimeout?: ReturnType<typeof setTimeout>;
  private resultTimeout?: ReturnType<typeof setTimeout>;
  private moveTimeout?: ReturnType<typeof setTimeout>;
  private retryTimeout?: ReturnType<typeof setTimeout>;
  private retreatTimeout?: ReturnType<typeof setTimeout>;

  private combatState: PartyCombatState | null = null;
  private createCombat: () => PartyCombatState;
  private pendingResult: BattleResult | null = null;
  private resultSettled = false;

  private pendingEvents: CombatEvent[] = [];
  private pendingLog: string[] = [];
  private liveLog: string[] = [];
  private lastFlushMs = 0;
  private lastSnapshotMs = 0;

  onBattleStart?: () => void;
  onBattleEnd?: (result: BattleResult) => void;
  onStateChange?: (state: BattleTimerState) => void;
  onMove?: () => void;
  canMoveToNextTile?: () => boolean;
  onCombatFlush?: (flush: CombatFlush) => void;
  onRetreat?: (battleId: number) => void;

  constructor(
    party: ServerParty,
    createCombat: () => PartyCombatState,
    callbacks?: ServerBattleCallbacks,
    label = 'party',
  ) {
    this.party = party;
    this.createCombat = createCombat;
    this.label = label;

    if (callbacks) {
      this.onBattleStart = callbacks.onBattleStart;
      this.onBattleEnd = callbacks.onBattleEnd;
      this.onStateChange = callbacks.onStateChange;
      this.onMove = callbacks.onMove;
      this.canMoveToNextTile = callbacks.canMoveToNextTile;
      this.onCombatFlush = callbacks.onCombatFlush;
      this.onRetreat = callbacks.onRetreat;
    }
  }

  get currentState(): BattleTimerState {
    return this.state;
  }

  get visual(): BattleVisual {
    return this.currentVisual;
  }

  get lastResult(): BattleResult | undefined {
    return this.currentResult;
  }

  get currentDuration(): number {
    return this.battleDuration;
  }

  get currentCombat(): PartyCombatState | null {
    return this.combatState;
  }

  get battleId(): number {
    return this.currentBattleId;
  }

  get isStarted(): boolean {
    return this.started;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** True while a fight (including its kill beat) is on screen. */
  get isLive(): boolean {
    return !this.destroyed && this.state === 'battle' && this.combatState !== null;
  }

  /** The current battle's last flushed live log lines, oldest first. */
  get recentLog(): string[] {
    return [...this.liveLog];
  }

  /** Send whatever the stream is holding now, so a snapshot built next already accounts for it. */
  flushPending(): void {
    if (!this.isLive) return;
    if (this.pendingEvents.length === 0 && this.pendingLog.length === 0) return;
    this.flush(null);
  }

  /** Begin the loop. Idempotent; a destroyed timer never starts. */
  start(): void {
    if (this.started || this.destroyed) return;
    this.started = true;
    this.guard(() => this.triggerBattle());
  }

  canEscape(): boolean {
    const combat = this.combatState;
    return !!combat && !combat.finished && combatRealElapsedMs(combat) >= RUN_AVAILABLE_MS;
  }

  /** Escape the current battle — skip rewards, move like defeat (only to discovered rooms). */
  escapeBattle(): boolean {
    if (this.destroyed || !this.canEscape()) return false;
    this.clearTimers();
    this.combatState = null;
    this.currentVisual = 'none';
    this.party.exitBattle();
    this.moveOnOrFightHere();
    return true;
  }

  /** Whether battle `battleId` is the current one and still undecided (not won, lost or retreated from). */
  isFighting(battleId: number): boolean {
    const combat = this.combatState;
    return !this.destroyed && battleId === this.currentBattleId && !!combat && !combat.finished && this.pendingResult === null;
  }

  /**
   * End battle `battleId` as a retreat: no rewards, no defeat. Only a live, undecided fight at least
   * RUN_AVAILABLE_MS old can be left. The party then shows the result and walks on, or fights here again.
   */
  retreat(battleId: number, reason: string): boolean {
    const combat = this.combatState;
    if (!combat || !this.isLive || !this.isFighting(battleId) || combatRealElapsedMs(combat) < RUN_AVAILABLE_MS) return false;
    this.clearTimers();
    combat.finished = true;
    combat.result = 'retreat';
    this.pendingEvents.push({ id: combat.nextEventId++, t: combatRealElapsedMs(combat), kind: 'battle_end', result: 'retreat' });
    this.pendingLog.push(reason);
    try {
      this.onRetreat?.(battleId);
    } catch (err) {
      console.error(`[ServerBattleTimer] ${this.label} battle ${battleId}: retreat bookkeeping failed:`, err);
    }
    this.flush('dynamic');
    this.currentResult = undefined;
    this.currentVisual = 'retreat';
    this.party.exitBattle();
    this.continueAfterResult(this.party.hasDestination && (this.canMoveToNextTile?.() ?? false));
    return true;
  }

  /** Retreat from battle `battleId` after `delayMs`, or as soon after as it is allowed. Cancelled with the battle. */
  scheduleRetreat(battleId: number, delayMs: number, reason: string): void {
    if (!this.isFighting(battleId)) return;
    if (this.retreatTimeout) clearTimeout(this.retreatTimeout);
    this.retreatTimeout = setTimeout(() => this.guard(() => {
      this.retreatTimeout = undefined;
      const combat = this.combatState;
      if (!combat || !this.isFighting(battleId)) return;
      const wait = RUN_AVAILABLE_MS - combatRealElapsedMs(combat);
      if (wait > 0) this.scheduleRetreat(battleId, Math.max(COMBAT_STEP_MS, wait), reason);
      else this.retreat(battleId, reason);
    }), Math.max(0, delayMs));
  }

  /** Call off a retreat scheduled with {@link scheduleRetreat}; the fight goes on. */
  cancelRetreat(): void {
    if (this.retreatTimeout) clearTimeout(this.retreatTimeout);
    this.retreatTimeout = undefined;
  }

  /** After a fight ends early: walk on if the next room is open (after the result pause), else fight again here at once. */
  private moveOnOrFightHere(): void {
    const canMove = this.party.hasDestination && (this.canMoveToNextTile?.() ?? false);
    if (canMove) {
      this.setState('result');
      this.resultTimeout = setTimeout(() => this.guard(() => this.moveThenFight()), RESULT_PAUSE);
    } else {
      this.guard(() => this.triggerBattle());
    }
  }

  /** Grant a finished-but-unshown battle's result now, without moving. The kill beat stays armed
   *  (and then skips the grant) so a caller that bails out afterwards doesn't strand the party. */
  settlePendingResult(): void {
    if (this.destroyed || this.pendingResult === null || this.resultSettled) return;
    this.resultSettled = true;
    this.currentResult = this.pendingResult;
    try {
      this.onBattleEnd?.(this.pendingResult);
    } catch (err) {
      console.error(`[ServerBattleTimer] ${this.label} battle ${this.currentBattleId}: settling the result failed:`, err);
    }
  }

  /** Throw away the current fight and start a fresh one. On a never-started timer this is `start()`. */
  restartBattle(): void {
    if (this.destroyed) return;
    if (!this.started) {
      this.start();
      return;
    }
    this.settlePendingResult();
    this.clearTimers();
    this.guard(() => this.triggerBattle());
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimers();
  }

  private triggerBattle(): void {
    this.clearTimers();
    this.currentBattleId = ++nextBattleId;
    this.combatState = null;
    this.pendingResult = null;
    this.resultSettled = false;
    this.currentResult = undefined;
    this.pendingEvents = [];
    this.pendingLog = [];
    this.liveLog = [];
    this.lastFlushMs = 0;
    this.lastSnapshotMs = 0;
    this.battleDuration = 0;

    this.combatState = this.createCombat();
    this.currentVisual = 'fighting';
    this.party.enterBattle();

    this.onBattleStart?.();
    this.setState('battle');
    this.flush('full');

    this.stepInterval = setInterval(() => this.guard(() => this.step()), combatRealStepMs(this.combatState));
  }

  private step(): void {
    const combat = this.combatState;
    if (!combat || combat.finished) return;

    const tick = processCombatStep(combat, COMBAT_STEP_MS);
    const elapsed = combatRealElapsedMs(combat);
    this.battleDuration = elapsed;
    if (tick.events.length > 0) this.pendingEvents.push(...tick.events);
    if (tick.logEntries.length > 0) this.pendingLog.push(...tick.logEntries);

    if (tick.finished) {
      this.stopStepping();
      this.pendingResult = tick.result === 'victory' ? 'victory' : 'defeat';
      this.killBeatTimeout = setTimeout(() => this.guard(() => this.showBattleResult()), KILL_BEAT_MS);
      this.flush('dynamic');
      return;
    }

    // The nearest step to COMBAT_SEND_MS: rounding up would hold events past the client's playback delay.
    if (elapsed - this.lastFlushMs + combatRealStepMs(combat) / 2 < COMBAT_SEND_MS) return;
    const snapshotDue = elapsed - this.lastSnapshotMs >= COMBAT_SNAPSHOT_MS;
    if (snapshotDue || this.pendingEvents.length > 0 || this.pendingLog.length > 0) {
      this.flush(snapshotDue ? 'dynamic' : null);
    } else {
      this.lastFlushMs = elapsed;
    }
  }

  private flush(snapshot: CombatSnapshotKind | null): void {
    const combat = this.combatState;
    if (!combat) return;
    const events = this.pendingEvents;
    const log = this.pendingLog;
    this.pendingEvents = [];
    this.pendingLog = [];
    if (log.length > 0) {
      this.liveLog.push(...log);
      if (this.liveLog.length > LIVE_LOG_RING_SIZE) this.liveLog.splice(0, this.liveLog.length - LIVE_LOG_RING_SIZE);
    }
    const elapsed = combatRealElapsedMs(combat);
    this.lastFlushMs = elapsed;
    if (snapshot) this.lastSnapshotMs = elapsed;
    this.onCombatFlush?.({ battleId: this.currentBattleId, combat, events, log, snapshot });
  }

  private showBattleResult(): void {
    this.killBeatTimeout = undefined;
    const result = this.pendingResult;
    if (result === null) return;
    const alreadySettled = this.resultSettled;
    this.pendingResult = null;
    this.resultSettled = true;

    this.currentResult = result;
    this.currentVisual = result === 'victory' ? 'victory' : 'defeat';
    this.party.exitBattle();

    // Before the move check, so rooms unlocked by this victory are walkable this cycle.
    if (!alreadySettled) this.onBattleEnd?.(result);
    this.consecutiveFailures = 0;

    const canMove = this.party.hasDestination && (
      result === 'victory' ||
      (this.canMoveToNextTile?.() ?? false)
    );
    this.continueAfterResult(canMove);
  }

  /** Show the result, then walk on or fight again in this room. */
  private continueAfterResult(canMove: boolean): void {
    this.setState('result');

    if (canMove) {
      this.resultTimeout = setTimeout(() => this.guard(() => this.moveThenFight()), RESULT_PAUSE);
    } else {
      this.resultTimeout = setTimeout(() => this.guard(() => {
        this.currentVisual = 'none';
        this.triggerBattle();
      }), RESULT_PAUSE + MOVE_DURATION);
    }
  }

  private moveThenFight(): void {
    this.resultTimeout = undefined;
    if (this.party.moveToNextTile()) this.onMove?.();
    this.currentVisual = 'none';
    this.onStateChange?.(this.state);
    this.moveTimeout = setTimeout(() => this.guard(() => this.triggerBattle()), MOVE_DURATION);
  }

  private guard(fn: () => void): void {
    if (this.destroyed) return;
    try {
      fn();
    } catch (err) {
      this.recoverFromFailure(err);
    }
  }

  private recoverFromFailure(err: unknown): void {
    if (this.loggedFailureBattleId !== this.currentBattleId) {
      this.loggedFailureBattleId = this.currentBattleId;
      console.error(`[ServerBattleTimer] ${this.label} battle ${this.currentBattleId} failed:`, err);
    }
    this.clearTimers();
    this.combatState = null;
    this.pendingResult = null;
    this.resultSettled = true;
    this.currentVisual = 'none';
    this.party.exitBattle();
    try {
      this.state = 'result';
      this.onStateChange?.('result');
    } catch (broadcastErr) {
      console.error(`[ServerBattleTimer] ${this.label}: broadcast after failure failed:`, broadcastErr);
    }
    if (this.destroyed) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.consecutiveFailures);
    this.consecutiveFailures++;
    this.retryTimeout = setTimeout(() => this.guard(() => this.triggerBattle()), delay);
  }

  private stopStepping(): void {
    if (this.stepInterval) {
      clearInterval(this.stepInterval);
      this.stepInterval = undefined;
    }
  }

  private clearTimers(): void {
    this.stopStepping();
    for (const t of [this.killBeatTimeout, this.resultTimeout, this.moveTimeout, this.retryTimeout, this.retreatTimeout]) {
      if (t) clearTimeout(t);
    }
    this.killBeatTimeout = undefined;
    this.resultTimeout = undefined;
    this.moveTimeout = undefined;
    this.retryTimeout = undefined;
    this.retreatTimeout = undefined;
  }

  private setState(newState: BattleTimerState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.onStateChange?.(newState);
    }
  }
}
