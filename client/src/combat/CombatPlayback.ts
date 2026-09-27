import type {
  ClientCombatSkill,
  ClientCombatSnapshot,
  ClientCombatStatus,
  ClientCombatUnit,
  CombatEvent,
  CombatRef,
  CombatSide,
  SkillCardType,
  SkillDefinition,
  SkillTrigger,
} from '@idle-party-rpg/shared';
import { BASE_ACTION_INTERVAL_MS, COMBAT_STEP_MS, getSkillTrigger, MIN_COOLDOWN_MS, PLAYBACK_DELAY_MS } from '@idle-party-rpg/shared';

export const CLOCK_SNAP_MS = 500;
export const CLOCK_SLEW_MS = 15;
export const CATCH_UP_MS = 1500;
/** Older than this (server time) on activation, the model waits for a fresh snapshot instead of extrapolating. */
export const STALE_RESUME_MS = 1000;
export const SYNC_WAIT_MS = 2500;
/** A snapshot this little behind a local ring or cooldown (a step's actor-order skew) does not pull it back. */
export const RING_LEAD_TOLERANCE_MS = 150;

export interface UnitStatics {
  name: string;
  id?: string;
  className?: string;
  henchman: boolean;
  passive: boolean;
  description?: string;
  passives: string[];
}

export interface SkillStatics {
  name?: string;
  cardType?: SkillCardType;
  trigger?: SkillTrigger;
  castTimeMs?: number;
}

export interface PlaybackSkill {
  id: string;
  remainingMs: number;
  cooldownMs: number;
  snapState: ClientCombatSkill['state'];
  /** Cooldown length after a use, read from a snapshot taken after one; 0 until then. */
  useCooldownMs: number;
  /** Cooldown at battle start (the warm-up); undefined when the fight was joined mid-way. */
  warmupMs: number | undefined;
  usedAt: number;
}

export interface PlaybackCast {
  skill: string;
  skillId: string;
  totalMs: number;
  remainingMs: number;
  target?: CombatRef;
}

export interface PlaybackUnit {
  readonly key: string;
  readonly side: CombatSide;
  readonly pos: number;
  hp: number;
  maxHp: number;
  shield: number;
  stunMs: number;
  stunTotalMs: number;
  actionMs: number;
  actionTotalMs: number;
  intervalMs: number;
  /** `intervalMs` came from the server rather than being inferred from observed waits. */
  intervalKnown: boolean;
  cast: PlaybackCast | null;
  statuses: ClientCombatStatus[];
  skills: PlaybackSkill[] | null;
  /** Server time the timer values above are valid at. */
  t0: number;
  castEndedAt: number;
  attacks: number;
  waitIsCast: boolean;
}

export interface PlaybackTick {
  renderTime: number;
  /** Events whose time was reached this tick, in timeline order. */
  events: CombatEvent[];
  snapshotApplied: boolean;
  /** The model jumped (catch-up, resync or new battle) instead of playing forward. */
  jumped: boolean;
}

export interface PlaybackOptions {
  now?: () => number;
  delayMs?: number;
  /** Cooldown length to restart a skill with until a snapshot has reported one after a use. */
  cooldownHint?: (skillId: string, warmupMs: number | undefined) => number | undefined;
}

const STACKING_STATUSES = new Set(['Ignite', 'Sunder']);

export function unitKey(side: CombatSide, pos: number): string {
  return `${side}:${pos}`;
}

export function refKey(ref: CombatRef | undefined): string | undefined {
  return ref ? unitKey(ref.side, ref.pos) : undefined;
}

/** Best guess of a status's kind from its name, for statuses seen in events before a snapshot names them. */
export function guessStatusKind(name: string): ClientCombatStatus['kind'] {
  const n = name.toLowerCase();
  if (n.includes('sunder')) return 'mark';
  if (n.includes('chaos')) return 'chaos';
  if (n.includes('scorch')) return 'scorch';
  if (n.includes('war song') || n.includes('rally')) return 'buff';
  if (n.includes('mending') || n.includes('renew') || n.includes('regen')) return 'hot';
  if (n.includes('ignite') || n.includes('bleed') || n.includes('rot') || n.includes('burn') || n.includes('poison')) return 'dot';
  return 'debuff';
}

/**
 * DOM-free combat timeline player: delays server events by PLAYBACK_DELAY_MS, applies
 * snapshots at their own time and extrapolates timers in between. See docs/architecture/client.md.
 */
export class CombatPlayback {
  private readonly now: () => number;
  private readonly delayMs: number;
  private readonly cooldownHint?: (skillId: string, warmupMs: number | undefined) => number | undefined;

  private active = false;
  private currentBattleId: number | null = null;
  private offset: number | null = null;
  private currentRenderTime = -Infinity;
  private queue: CombatEvent[] = [];
  private pendingSnapshots: ClientCombatSnapshot[] = [];
  private seen = new Set<number>();
  private newestSnapshotT = -Infinity;
  private lastAppliedT = -Infinity;
  private unitMap = new Map<string, PlaybackUnit>();
  private unitOrder: PlaybackUnit[] = [];
  private staticMap = new Map<string, UnitStatics>();
  private skillStaticMap = new Map<string, SkillStatics>();
  private endT = Infinity;
  private isFinished = false;
  private battleResult: 'victory' | 'defeat' | null = null;
  private structureVersion = 0;
  private newestEventT = -Infinity;
  private syncUntil = 0;
  private pendingJump = false;

  constructor(options: PlaybackOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.delayMs = options.delayMs ?? PLAYBACK_DELAY_MS;
    this.cooldownHint = options.cooldownHint;
  }

  get battleId(): number | null {
    return this.currentBattleId;
  }

  get renderTime(): number {
    return this.currentRenderTime;
  }

  get units(): readonly PlaybackUnit[] {
    return this.unitOrder;
  }

  /** Bumped when the unit roster (not its values) changes. */
  get version(): number {
    return this.structureVersion;
  }

  get finished(): boolean {
    return this.isFinished;
  }

  get result(): 'victory' | 'defeat' | null {
    return this.battleResult;
  }

  get queuedEvents(): number {
    return this.queue.length;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Waiting for a fresh snapshot after the view was away; timers are frozen meanwhile. */
  get syncing(): boolean {
    return this.syncUntil > 0;
  }

  /** Combat time shown to the player: the render clock, clamped to the fight's span. */
  get elapsedMs(): number {
    if (this.currentBattleId === null || !Number.isFinite(this.currentRenderTime)) return 0;
    return Math.max(0, Math.min(this.currentRenderTime, this.endT));
  }

  serverNow(at = this.now()): number | null {
    return this.offset === null ? null : at + this.offset;
  }

  unit(side: CombatSide, pos: number): PlaybackUnit | undefined {
    return this.unitMap.get(unitKey(side, pos));
  }

  unitByKey(key: string): PlaybackUnit | undefined {
    return this.unitMap.get(key);
  }

  statics(key: string): UnitStatics | undefined {
    return this.staticMap.get(key);
  }

  skillStatics(key: string, skillId: string): SkillStatics | undefined {
    return this.skillStaticMap.get(`${key}:${skillId}`);
  }

  setActive(active: boolean, at = this.now()): void {
    if (!active) {
      this.active = false;
      this.syncUntil = 0;
      this.queue = [];
      this.pendingSnapshots = this.pendingSnapshots.slice(-1);
      return;
    }
    this.active = true;
    this.catchUp(at);
    this.pendingJump = true;
    const serverNow = this.serverNow(at);
    const newest = Math.max(this.newestSnapshotT, this.newestEventT);
    if (serverNow !== null && this.currentBattleId !== null && !this.isFinished && serverNow - newest > STALE_RESUME_MS) {
      this.syncUntil = at + SYNC_WAIT_MS;
    }
  }

  ingestMessage(msg: { battleId: number; snapshot?: ClientCombatSnapshot; events: CombatEvent[] }, receivedAt = this.now()): void {
    this.ingest(msg.battleId, msg.snapshot, msg.events, receivedAt);
  }

  /** `state.battle.combat`: a full snapshot, or undefined when no fight is live. */
  ingestState(combat: ClientCombatSnapshot | undefined, receivedAt = this.now()): void {
    if (!combat) {
      this.clear();
      return;
    }
    this.ingest(combat.battleId, combat, [], receivedAt);
  }

  clear(): void {
    if (this.currentBattleId === null && this.unitOrder.length === 0) return;
    this.resetBattle(null);
  }

  tick(at = this.now()): PlaybackTick {
    const played: CombatEvent[] = [];
    let snapshotApplied = false;
    let jumped = this.pendingJump;
    this.pendingJump = false;
    if (this.offset === null || this.currentBattleId === null) {
      return { renderTime: this.currentRenderTime, events: played, snapshotApplied, jumped };
    }
    if (this.syncUntil > 0) {
      if (at < this.syncUntil) return { renderTime: this.currentRenderTime, events: played, snapshotApplied, jumped };
      this.syncUntil = 0;
    }
    const serverNow = at + this.offset;
    if (this.active && Number.isFinite(this.currentRenderTime) && serverNow - this.currentRenderTime > CATCH_UP_MS) {
      snapshotApplied = this.catchUp(at);
      jumped = true;
    }
    const rt = Math.max(this.currentRenderTime, serverNow - this.delayMs);
    this.currentRenderTime = rt;

    for (;;) {
      const ev = this.queue[0];
      const snap = this.pendingSnapshots[0];
      const evDue = ev !== undefined && ev.t <= rt;
      const snapDue = snap !== undefined && snap.elapsedMs <= rt;
      if (!evDue && !snapDue) break;
      if (evDue && (!snapDue || ev.t <= snap.elapsedMs)) {
        this.queue.shift();
        played.push(ev);
        this.playEvent(ev);
      } else {
        this.pendingSnapshots.shift();
        this.applySnapshot(snap);
        snapshotApplied = true;
      }
    }
    for (const unit of this.unitOrder) this.advance(unit, rt);
    return { renderTime: rt, events: played, snapshotApplied, jumped };
  }

  private ingest(battleId: number, snapshot: ClientCombatSnapshot | undefined, events: CombatEvent[], receivedAt: number): void {
    const changed = battleId !== this.currentBattleId;
    if (changed) this.resetBattle(battleId);
    if (snapshot?.full) this.cacheStatics(snapshot);

    const clockT = snapshot ? snapshot.elapsedMs : latestEventTime(events);
    if (clockT !== undefined) this.updateClock(clockT, receivedAt, changed, !!snapshot);

    const fresh = !!snapshot && snapshot.elapsedMs >= this.newestSnapshotT;
    if (snapshot && fresh) {
      this.newestSnapshotT = snapshot.elapsedMs;
      if (this.active) insertSorted(this.pendingSnapshots, snapshot, s => s.elapsedMs);
      else this.pendingSnapshots = [snapshot];
    }
    const latest = latestEventTime(events);
    if (latest !== undefined) this.newestEventT = Math.max(this.newestEventT, latest);

    if (this.active) {
      for (const ev of events) {
        if (this.seen.has(ev.id)) continue;
        this.seen.add(ev.id);
        insertSorted(this.queue, ev, e => e.t);
      }
    }

    if (changed && this.active) {
      this.applyNewestSnapshot();
      this.pendingJump = true;
    } else if (snapshot && fresh && this.syncUntil > 0) {
      this.resync(snapshot);
    }
  }

  private resync(snapshot: ClientCombatSnapshot): void {
    this.syncUntil = 0;
    this.pendingJump = true;
    this.applyNewestSnapshot();
    this.queue = this.queue.filter(e => e.t > snapshot.elapsedMs || e.kind === 'battle_end');
    this.currentRenderTime = Math.max(this.currentRenderTime, snapshot.elapsedMs);
  }

  private resetBattle(battleId: number | null): void {
    this.currentBattleId = battleId;
    this.queue = [];
    this.pendingSnapshots = [];
    this.seen.clear();
    this.newestSnapshotT = -Infinity;
    this.lastAppliedT = -Infinity;
    this.currentRenderTime = -Infinity;
    this.unitMap.clear();
    this.unitOrder = [];
    this.staticMap.clear();
    this.skillStaticMap.clear();
    this.endT = Infinity;
    this.isFinished = false;
    this.battleResult = null;
    this.newestEventT = -Infinity;
    this.syncUntil = 0;
    this.structureVersion++;
  }

  private updateClock(serverT: number, receivedAt: number, battleChanged: boolean, fromSnapshot: boolean): void {
    const target = serverT - receivedAt;
    if (this.offset === null || battleChanged) {
      this.offset = target;
      return;
    }
    // Event times trail the server's send time, so without a snapshot they only prove the clock is behind.
    if (!fromSnapshot && target <= this.offset) return;
    const diff = target - this.offset;
    if (Math.abs(diff) > CLOCK_SNAP_MS) {
      this.offset = target;
      return;
    }
    this.offset += Math.max(-CLOCK_SLEW_MS, Math.min(CLOCK_SLEW_MS, diff));
  }

  private catchUp(at = this.now()): boolean {
    const pendingEnd = this.queue.find(e => e.kind === 'battle_end');
    this.queue = pendingEnd ? [pendingEnd] : [];
    const applied = this.applyNewestSnapshot();
    if (this.offset !== null && this.currentBattleId !== null) {
      this.currentRenderTime = Math.max(this.currentRenderTime, at + this.offset - this.delayMs);
    }
    return applied;
  }

  private applyNewestSnapshot(): boolean {
    const newest = this.pendingSnapshots[this.pendingSnapshots.length - 1];
    this.pendingSnapshots = [];
    if (!newest) return false;
    this.applySnapshot(newest);
    return true;
  }

  private cacheStatics(snapshot: ClientCombatSnapshot): void {
    for (const u of snapshot.units) {
      const key = unitKey(u.side, u.pos);
      this.staticMap.set(key, {
        name: u.name ?? '',
        id: u.id,
        className: u.className,
        henchman: !!u.henchman,
        passive: !!u.passive,
        description: u.description,
        passives: u.passives ?? [],
      });
      for (const s of u.skills ?? []) {
        this.skillStaticMap.set(`${key}:${s.id}`, {
          name: s.name, cardType: s.cardType, trigger: s.trigger, castTimeMs: s.castTimeMs,
        });
      }
    }
  }

  private applySnapshot(snapshot: ClientCombatSnapshot): void {
    const nextOrder: PlaybackUnit[] = [];
    let structural = snapshot.units.length !== this.unitOrder.length;
    for (const u of snapshot.units) {
      const key = unitKey(u.side, u.pos);
      let unit = this.unitMap.get(key);
      if (!unit) {
        unit = createUnit(u);
        this.unitMap.set(key, unit);
        structural = true;
      } else {
        this.advance(unit, snapshot.elapsedMs);
      }
      writeSnapshotUnit(unit, u, snapshot.elapsedMs);
      nextOrder.push(unit);
    }
    if (structural) {
      const keep = new Set(nextOrder.map(u => u.key));
      for (const key of [...this.unitMap.keys()]) if (!keep.has(key)) this.unitMap.delete(key);
      this.structureVersion++;
    }
    this.unitOrder = nextOrder;
    this.lastAppliedT = Math.max(this.lastAppliedT, snapshot.elapsedMs);
    if (snapshot.finished) {
      this.isFinished = true;
      this.battleResult = snapshot.result;
      this.endT = Math.min(this.endT, snapshot.elapsedMs);
    }
  }

  private playEvent(ev: CombatEvent): void {
    if (ev.kind === 'battle_end') {
      this.isFinished = true;
      this.battleResult = ev.result ?? this.battleResult;
      this.endT = Math.min(this.endT, ev.t);
    }
    if (ev.t <= this.lastAppliedT) return;
    this.applyEvent(ev);
  }

  private applyEvent(ev: CombatEvent): void {
    const src = ev.src ? this.unitMap.get(unitKey(ev.src.side, ev.src.pos)) : undefined;
    const dst = ev.dst ? this.unitMap.get(unitKey(ev.dst.side, ev.dst.pos)) : undefined;
    if (src) this.advance(src, ev.t);
    if (dst) this.advance(dst, ev.t);
    const amount = ev.amount ?? 0;

    switch (ev.kind) {
      case 'damage':
        if (dst) dst.hp = Math.max(0, dst.hp - amount);
        break;
      case 'heal':
        if (dst) dst.hp = Math.min(dst.maxHp, dst.hp + amount);
        break;
      case 'absorb':
        if (dst) dst.shield = Math.max(0, dst.shield - amount);
        break;
      case 'shield':
        if (dst) dst.shield = amount;
        break;
      case 'death':
        if (dst) {
          dst.hp = 0;
          dst.cast = null;
          dst.stunMs = 0;
          dst.shield = 0;
          dst.statuses = [];
        }
        break;
      case 'revive':
        if (dst) dst.hp = Math.max(1, amount);
        break;
      case 'stun':
        if (dst && (ev.durationMs ?? 0) > dst.stunMs) {
          dst.stunMs = ev.durationMs ?? 0;
          dst.stunTotalMs = dst.stunMs;
        }
        break;
      case 'cast_start':
        if (src) {
          const castMs = ev.durationMs ?? 0;
          src.cast = { skill: ev.skill ?? '', skillId: ev.skillId ?? '', totalMs: castMs, remainingMs: castMs, target: ev.dst };
          src.waitIsCast = true;
          src.actionTotalMs = Math.max(src.intervalMs, castMs);
          src.actionMs = src.actionTotalMs;
          this.restartCooldown(src, ev.skillId, ev.t);
        }
        break;
      case 'cast_end':
        if (src) {
          src.cast = null;
          src.castEndedAt = ev.t;
        }
        break;
      case 'interrupt':
        if (dst) dst.cast = null;
        break;
      case 'attack':
        if (src) {
          if (src.castEndedAt !== ev.t) {
            src.attacks++;
            src.waitIsCast = false;
            src.actionTotalMs = src.intervalMs;
            src.actionMs = src.intervalMs;
          }
          this.restartCooldown(src, ev.skillId, ev.t);
        }
        break;
      case 'reaction':
        if (src) this.restartCooldown(src, ev.skillId, ev.t);
        break;
      case 'status':
        if (dst && ev.name) addStatus(dst, ev.name);
        break;
      case 'cleanse':
        if (dst) {
          if (dst.side === 'player') {
            dst.statuses = dst.statuses.filter(s => s.kind !== 'dot' && s.kind !== 'debuff' && s.kind !== 'scorch');
            dst.stunMs = 0;
          } else {
            dst.statuses = dst.statuses.filter(s => s.kind !== 'buff');
          }
        }
        break;
      default:
        break;
    }
  }

  private restartCooldown(unit: PlaybackUnit, skillId: string | undefined, t: number): void {
    if (!skillId || !unit.skills) return;
    const skill = unit.skills.find(s => s.id === skillId);
    if (!skill) return;
    skill.usedAt = t;
    const length = skill.useCooldownMs > 0
      ? skill.useCooldownMs
      : this.cooldownHint?.(skillId, skill.warmupMs) ?? skill.cooldownMs;
    skill.cooldownMs = length;
    skill.remainingMs = length;
  }

  private advance(unit: PlaybackUnit, t: number): void {
    const target = Math.min(t, this.endT);
    const dt = target - unit.t0;
    if (!(dt > 0)) return;
    unit.t0 = target;
    if (unit.hp <= 0) return;
    const stunned = Math.min(dt, unit.stunMs);
    unit.stunMs -= stunned;
    for (const status of unit.statuses) {
      if (status.remainingMs !== undefined) status.remainingMs = Math.max(0, status.remainingMs - dt);
    }
    const active = dt - stunned;
    if (active <= 0) return;
    unit.actionMs = Math.max(0, unit.actionMs - active);
    if (unit.cast) unit.cast.remainingMs = Math.max(0, unit.cast.remainingMs - active);
    if (unit.skills) {
      for (const skill of unit.skills) skill.remainingMs = Math.max(0, skill.remainingMs - active);
    }
  }
}

function createUnit(u: ClientCombatUnit): PlaybackUnit {
  return {
    key: unitKey(u.side, u.pos),
    side: u.side,
    pos: u.pos,
    hp: u.hp,
    maxHp: u.maxHp ?? u.hp,
    shield: 0,
    stunMs: 0,
    stunTotalMs: 0,
    actionMs: u.actionMs,
    actionTotalMs: u.actionTotalMs,
    intervalMs: u.actionIntervalMs && u.actionIntervalMs > 0 ? u.actionIntervalMs : BASE_ACTION_INTERVAL_MS,
    intervalKnown: !!u.actionIntervalMs && u.actionIntervalMs > 0,
    cast: null,
    statuses: [],
    skills: null,
    t0: -Infinity,
    castEndedAt: -Infinity,
    attacks: 0,
    waitIsCast: false,
  };
}

function writeSnapshotUnit(unit: PlaybackUnit, u: ClientCombatUnit, t: number): void {
  unit.hp = u.hp;
  unit.maxHp = Math.max(1, u.maxHp ?? unit.maxHp);
  unit.shield = u.shield ?? 0;
  unit.stunMs = u.stunMs ?? 0;
  unit.stunTotalMs = u.stunTotalMs ?? unit.stunMs;
  const lag = u.actionMs - unit.actionMs;
  const keepLead = u.hp > 0 && u.actionTotalMs === unit.actionTotalMs && lag > 0 && lag <= RING_LEAD_TOLERANCE_MS;
  if (!keepLead) unit.actionMs = u.actionMs;
  unit.actionTotalMs = u.actionTotalMs;
  if (u.actionIntervalMs && u.actionIntervalMs > 0) {
    unit.intervalMs = u.actionIntervalMs;
    unit.intervalKnown = true;
  } else if (!unit.intervalKnown && !u.cast && !unit.waitIsCast && unit.attacks > 0 && u.actionTotalMs > 0) {
    unit.intervalMs = u.actionTotalMs;
  }
  unit.cast = u.cast
    ? { skill: u.cast.skill, skillId: u.cast.skillId, totalMs: u.cast.totalMs, remainingMs: u.cast.remainingMs, target: u.cast.target }
    : null;
  unit.statuses = (u.statuses ?? []).map(s => ({ ...s }));
  const previous = new Map((unit.skills ?? []).map(s => [s.id, s]));
  unit.skills = u.skills
    ? u.skills.map(s => {
      const old = previous.get(s.id);
      const usedAt = old?.usedAt ?? -Infinity;
      const afterUse = Number.isFinite(usedAt) && usedAt <= t && s.cooldownMs > 0;
      const lag = old && old.cooldownMs === s.cooldownMs ? s.remainingMs - old.remainingMs : 0;
      return {
        id: s.id,
        remainingMs: old && lag > 0 && lag <= RING_LEAD_TOLERANCE_MS ? old.remainingMs : s.remainingMs,
        cooldownMs: s.cooldownMs,
        snapState: s.state,
        useCooldownMs: afterUse ? s.cooldownMs : old?.useCooldownMs ?? 0,
        warmupMs: old ? old.warmupMs : t < COMBAT_STEP_MS ? s.cooldownMs : undefined,
        usedAt,
      };
    })
    : null;
  unit.t0 = t;
}

function addStatus(unit: PlaybackUnit, name: string): void {
  const index = unit.statuses.findIndex(s => s.name === name);
  if (index < 0) {
    unit.statuses = [...unit.statuses, { kind: guessStatusKind(name), name }];
    return;
  }
  if (!STACKING_STATUSES.has(name)) return;
  const existing = unit.statuses[index];
  unit.statuses = unit.statuses.map((s, i) => (i === index ? { ...existing, stacks: (existing.stacks ?? 1) + 1 } : s));
}

function latestEventTime(events: CombatEvent[]): number | undefined {
  let latest: number | undefined;
  for (const ev of events) if (latest === undefined || ev.t > latest) latest = ev.t;
  return latest;
}

function insertSorted<T>(list: T[], item: T, key: (item: T) => number): void {
  const k = key(item);
  let i = list.length;
  while (i > 0 && key(list[i - 1]) > k) i--;
  list.splice(i, 0, item);
}

/**
 * Cooldown to show when `def` is used before a snapshot reports one. Derived action and interrupt
 * warm-ups are the effective cooldown minus one second, so they reveal cooldown reduction.
 */
export function guessCooldownMs(def: SkillDefinition, warmupMs: number | undefined): number {
  const trigger = getSkillTrigger(def);
  const derivedWarmup = def.warmup === undefined && (trigger === undefined || trigger === 'enemy_cast');
  if (derivedWarmup && warmupMs !== undefined && warmupMs >= 0) return warmupMs + MIN_COOLDOWN_MS;
  const base = typeof def.cooldown === 'number' && Number.isFinite(def.cooldown) ? def.cooldown * 1000 : MIN_COOLDOWN_MS;
  return Math.max(MIN_COOLDOWN_MS, base);
}

/** Display state of a skill at the playback's current time. */
export function skillDisplayState(unit: PlaybackUnit, skill: PlaybackSkill, trigger: SkillTrigger | undefined): ClientCombatSkill['state'] {
  if (unit.cast?.skillId === skill.id) return 'casting';
  if (skill.remainingMs > 0) return 'cooldown';
  if (skill.snapState === 'cooldown' || skill.snapState === 'casting') return trigger ? 'armed' : 'ready';
  return skill.snapState;
}
