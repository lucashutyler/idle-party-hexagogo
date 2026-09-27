import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { CombatEvent, ServerCombatMessage, ServerStateMessage, SkillCardType } from '@idle-party-rpg/shared';
import {
  CLASS_ICONS,
  getSkillCardType,
  getSkillTrigger,
  RUN_AVAILABLE_MS,
  SKILL_CARD_TYPE_INFO,
  SKILL_TRIGGER_INFO,
} from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import { artworkUrl, placeholderUrl } from '../ui/assets';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';
import { CombatPlayback, guessCooldownMs, skillDisplayState, unitKey } from '../combat/CombatPlayback';
import type { PlaybackUnit } from '../combat/CombatPlayback';
import { CombatFx } from '../combat/CombatFx';
import type { FloaterVariant, FxPoint } from '../combat/CombatFx';
import { CombatLogFormatter } from '../combat/CombatLogFormatter';
import { CombatLogView } from '../combat/CombatLogView';
import { CombatSkillBar } from '../combat/CombatSkillBar';
import type { SkillBarLayout, SkillBarState } from '../combat/CombatSkillBar';
import { UnitCard } from '../combat/CombatUnitCard';
import type { CardIdentity } from '../combat/CombatUnitCard';
import { escapeHtml, formatAmount, formatClock, formatDuration, pipsKey, statusPips } from '../combat/CombatFormat';

type Axis = 'x' | 'y';

const TEXT_INTERVAL_MS = 100;
const RUN_HINT_MS = 3000;
const POP_IN_STAGGER_MS = 45;
const CAST_LABEL_EDGE_PX = 70;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function variantFor(dmgType: string | undefined): FloaterVariant {
  if (dmgType === 'magical') return 'magical';
  if (dmgType === 'holy') return 'holy';
  return 'physical';
}

export class CombatScreen implements Screen {
  private readonly container: HTMLElement;
  private readonly gameClient: GameClient;
  private readonly worldCache: WorldCache;
  private readonly playback: CombatPlayback;
  private readonly formatter = new CombatLogFormatter();
  private isActive = false;
  private lastState: ServerStateMessage | null = null;

  private stage!: HTMLElement;
  private stageGrid!: HTMLElement;
  private stageBg!: HTMLElement;
  private playerSide!: HTMLElement;
  private enemySide!: HTMLElement;
  private telegraphSvg!: SVGSVGElement;
  private header!: HTMLElement;
  private locationLabel!: HTMLElement;
  private floorBadge!: HTMLElement;
  private clockEl!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private runHint!: HTMLElement;
  private dungeonLeaveBtn!: HTMLButtonElement;
  private skillBarRoot!: HTMLElement;
  private logWrapper!: HTMLElement;
  private fx!: CombatFx;
  private skillBar!: CombatSkillBar;
  private logView!: CombatLogView;
  private popover: HTMLElement | null = null;
  private popoverSkillId = '';

  private cards = new Map<string, UnitCard>();
  private renderedBattleId: number | null = null;
  private renderedVersion = -1;
  private centres = new Map<string, FxPoint>();
  private centresDirty = true;
  private axis: Axis = 'y';
  private telegraphs = new Map<string, { line: SVGLineElement; ring: SVGCircleElement; targetKey: string; drawnKey: string }>();
  private targetedKeys = new Set<string>();
  private pendingCounters = new Set<string>();
  private monsterNames: { battleId: number; names: string[] }[] = [];
  private selfKey: string | null = null;
  private rafId = 0;
  private lastTextAt = -Infinity;
  private lastClockText = '';
  private lastRunKey = '';
  private runHintTimer?: ReturnType<typeof setTimeout>;
  private snapping = false;
  private syncingShown = false;
  private monsterPopup: { overlay: HTMLElement; key: string; battleId: number | null; lastKey: string } | null = null;

  private onUserClick?: (username: string, anchor: HTMLElement) => void;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.playback = new CombatPlayback({
      cooldownHint: (id, warmupMs) => {
        const skill = this.worldCache.getSkill(id);
        return skill ? guessCooldownMs(skill, warmupMs) : undefined;
      },
    });

    this.buildDOM();
    this.wireSubscriptions();

    const state = gameClient.lastState;
    if (state) {
      this.lastState = state;
      this.playback.ingestState(state.battle.combat);
    }
    if (gameClient.lastCombat) this.playback.ingestMessage(gameClient.lastCombat);
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement) => void): void {
    this.onUserClick = cb;
  }

  onActivate(): void {
    this.isActive = true;
    const visible = document.visibilityState !== 'hidden';
    this.playback.setActive(visible);
    this.gameClient.combatLog.setHoldLive(true);
    this.gameClient.sendCombatView(visible);
    this.logView.setActive(true);
    if (this.lastState) this.applyState(this.lastState);
    this.centresDirty = true;
    if (visible) this.startLoop();
  }

  onDeactivate(): void {
    this.isActive = false;
    this.playback.setActive(false);
    this.gameClient.combatLog.setHoldLive(false);
    this.gameClient.sendCombatView(false);
    this.logView.setActive(false);
    this.stopLoop();
    this.closePopover();
    this.fx.clearAll();
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="combat-header">
        <span class="combat-run-location"></span>
        <span class="combat-dungeon-floor" style="display:none"></span>
        <span class="combat-clock">0:00</span>
        <button class="combat-run-btn combat-run-locked" type="button">Run</button>
        <button class="combat-dungeon-leave" type="button" style="display:none">Leave</button>
        <span class="combat-run-hint" style="display:none"></span>
      </div>
      <div class="combat-stage">
        <div class="combat-stage-bg"></div>
        <div class="combat-stage-scrim"></div>
        <svg class="combat-telegraph" aria-hidden="true"></svg>
        <div class="combat-stage-grid">
          <div class="combat-block combat-block-enemy">
            <div class="combat-side combat-enemy-side"></div>
          </div>
          <div class="combat-stage-divider"><span>VS</span></div>
          <div class="combat-block combat-block-party">
            <div class="combat-side combat-player-side"></div>
          </div>
        </div>
        <div class="combat-fx-layer" aria-hidden="true"></div>
        <div class="combat-banner"></div>
      </div>
      <div class="combat-skillbar"></div>
      <div class="combat-log-wrapper"></div>
    `;

    this.header = this.container.querySelector('.combat-header')!;
    this.locationLabel = this.container.querySelector('.combat-run-location')!;
    this.floorBadge = this.container.querySelector('.combat-dungeon-floor')!;
    this.clockEl = this.container.querySelector('.combat-clock')!;
    this.runBtn = this.container.querySelector('.combat-run-btn')!;
    this.runHint = this.container.querySelector('.combat-run-hint')!;
    this.dungeonLeaveBtn = this.container.querySelector('.combat-dungeon-leave')!;
    this.stage = this.container.querySelector('.combat-stage')!;
    this.stageBg = this.container.querySelector('.combat-stage-bg')!;
    this.stageGrid = this.container.querySelector('.combat-stage-grid')!;
    this.playerSide = this.container.querySelector('.combat-player-side')!;
    this.enemySide = this.container.querySelector('.combat-enemy-side')!;
    this.telegraphSvg = this.container.querySelector('.combat-telegraph')!;
    this.skillBarRoot = this.container.querySelector('.combat-skillbar')!;
    this.logWrapper = this.container.querySelector('.combat-log-wrapper')!;

    this.fx = new CombatFx(
      this.container.querySelector('.combat-fx-layer')!,
      this.stageGrid,
      this.container.querySelector('.combat-banner')!,
    );
    this.skillBar = new CombatSkillBar(this.skillBarRoot, (id, anchor) => this.toggleSkillPopover(id, anchor));
    this.logView = new CombatLogView(this.logWrapper, this.gameClient.combatLog, this.formatter);
    this.logView.setOnOpenChange(() => this.closePopover());
    this.fillEmptySlots(this.playerSide);
    this.fillEmptySlots(this.enemySide);

    // Never set `disabled`: disabled buttons swallow taps on mobile, which kills the locked-state hint.
    this.runBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.runBtn.classList.contains('combat-run-locked')) this.showRunHint();
      else this.gameClient.sendRun();
    });
    this.dungeonLeaveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.dungeonLeaveBtn.classList.contains('combat-dungeon-leave-locked')) {
        this.showRunHint();
        return;
      }
      this.gameClient.sendLeaveDungeon();
    });
    this.header.addEventListener('click', () => {
      if (getComputedStyle(this.logWrapper).display === 'none') this.logView.setOpen(true);
    });
    this.stageGrid.addEventListener('click', (e) => this.onStageClick(e));
    this.container.addEventListener('click', (e) => {
      if (this.popover && !(e.target as HTMLElement).closest('.combat-skill-popover, [data-skill-id]')) this.closePopover();
    });

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        this.readAxis();
        this.centresDirty = true;
      }).observe(this.stage);
    }
  }

  private wireSubscriptions(): void {
    this.gameClient.subscribe((state) => this.handleState(state));
    this.gameClient.onCombat((msg, receivedAt) => this.handleCombat(msg, receivedAt));
    document.addEventListener('visibilitychange', () => {
      if (!this.isActive) return;
      const visible = document.visibilityState !== 'hidden';
      this.gameClient.sendCombatView(visible);
      this.playback.setActive(visible);
      if (visible) this.startLoop();
      else this.stopLoop();
    });
  }

  private handleState(state: ServerStateMessage): void {
    this.lastState = state;
    this.playback.ingestState(state.battle.combat, performance.now());
    if (!this.isActive) return;
    this.applyState(state);
  }

  private handleCombat(msg: ServerCombatMessage, receivedAt: number): void {
    this.playback.ingestMessage(msg, receivedAt);
  }

  private applyState(state: ServerStateMessage): void {
    this.stage.classList.remove('fighting', 'victory', 'defeat');
    if (state.battle.visual !== 'none') this.stage.classList.add(state.battle.visual);
    this.updateBackground(state);
    this.updateHeader(state);
    this.refreshIdentities();
    this.refreshSkillLayout();
    this.updateRoster();
  }

  private startLoop(): void {
    if (this.rafId || typeof requestAnimationFrame !== 'function') return;
    this.rafId = requestAnimationFrame(() => this.frame());
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private frame(): void {
    this.rafId = requestAnimationFrame(() => this.frame());
    try {
      this.renderFrame(performance.now());
    } catch (err) {
      console.error('[CombatScreen] frame error:', err);
    }
  }

  private renderFrame(now: number): void {
    const tick = this.playback.tick(now);
    if (tick.jumped !== this.snapping) {
      this.snapping = tick.jumped;
      this.stage.classList.toggle('combat-snap', tick.jumped);
    }
    if (this.playback.syncing !== this.syncingShown) {
      this.syncingShown = this.playback.syncing;
      this.stage.classList.toggle('syncing', this.syncingShown);
    }
    if (this.playback.battleId !== this.renderedBattleId || this.playback.version !== this.renderedVersion) this.syncCards();
    if (this.centresDirty) this.measureCentres();
    for (const ev of tick.events) this.playEvent(ev, now);
    for (const unit of this.playback.units) this.cards.get(unit.key)?.update(unit, now);
    this.updateTelegraphs();

    const writeText = now - this.lastTextAt >= TEXT_INTERVAL_MS;
    if (writeText) this.lastTextAt = now;
    this.updateSkillBar(writeText);
    if (writeText) {
      this.updateClock();
      if (this.lastState) this.updateRunButton(this.lastState);
      this.refreshMonsterPopup();
    }
    this.gameClient.combatLog.release(this.playback.battleId, this.playback.renderTime);
  }

  private syncCards(): void {
    const battleChanged = this.playback.battleId !== this.renderedBattleId;
    if (battleChanged) {
      for (const card of this.cards.values()) card.el.remove();
      this.cards.clear();
      this.fx.clearAll();
      this.clearTelegraphs();
      this.pendingCounters.clear();
    }
    const live = new Set<string>();
    let order = 0;
    for (const unit of this.playback.units) {
      live.add(unit.key);
      if (this.cards.has(unit.key)) continue;
      const card = new UnitCard(unit.key, unit.side, unit.pos);
      const side = unit.side === 'player' ? this.playerSide : this.enemySide;
      side.querySelector(`.combat-grid-empty[data-grid="${unit.pos}"]`)?.remove();
      side.appendChild(card.el);
      this.cards.set(unit.key, card);
      if (battleChanged) this.fx.popIn(card.el, (order++) * POP_IN_STAGGER_MS);
    }
    for (const [key, card] of this.cards) {
      if (live.has(key)) continue;
      card.el.remove();
      this.cards.delete(key);
    }
    this.fillEmptySlots(this.playerSide);
    this.fillEmptySlots(this.enemySide);
    this.renderedBattleId = this.playback.battleId;
    this.renderedVersion = this.playback.version;
    this.centresDirty = true;
    this.stage.classList.toggle('no-combat', this.playback.battleId === null);
    this.rememberMonsterNames();
    this.refreshIdentities();
    this.refreshSkillLayout();
    this.updateRoster();
  }

  private fillEmptySlots(side: HTMLElement): void {
    const taken = new Set<string>();
    for (const child of side.children) taken.add((child as HTMLElement).dataset.grid ?? '');
    for (let pos = 0; pos < 9; pos++) {
      if (taken.has(String(pos))) continue;
      const empty = document.createElement('div');
      empty.className = 'combat-grid-empty';
      empty.dataset.grid = String(pos);
      side.appendChild(empty);
    }
  }

  private refreshIdentities(): void {
    const state = this.lastState;
    const username = state?.username ?? '';
    const henchmen = state?.social?.party?.henchmen ?? [];
    this.selfKey = null;
    for (const unit of this.playback.units) {
      const card = this.cards.get(unit.key);
      const st = this.playback.statics(unit.key);
      if (!card) continue;
      const name = st?.name || (unit.side === 'monster' ? 'Enemy' : 'Ally');
      let identity: CardIdentity;
      if (unit.side === 'player') {
        if (st?.henchman) {
          const hired = henchmen.find(h => h.gridPosition === unit.pos);
          identity = { name, isSelf: false, henchman: true, passive: false, art: hired?.artworkUrl, emoji: hired?.emoji || undefined };
        } else {
          const isSelf = !!username && name === username;
          if (isSelf) this.selfKey = unit.key;
          const className = st?.className ?? '';
          identity = {
            name, isSelf, henchman: false, passive: false,
            art: className ? artworkUrl('class', className) : undefined,
            icon: CLASS_ICONS[className],
          };
        }
      } else {
        const artKey = st?.id || slugify(name);
        identity = {
          name, isSelf: false, henchman: false, passive: !!st?.passive,
          art: artworkUrl('monster', artKey),
          artFallback: placeholderUrl(name, { w: 160, h: 160 }),
        };
      }
      card.setIdentity(identity);
    }
  }

  private rememberMonsterNames(): void {
    const battleId = this.playback.battleId;
    if (battleId === null) return;
    const names = this.playback.units
      .filter(u => u.side === 'monster')
      .map(u => this.playback.statics(u.key)?.name ?? '')
      .filter(Boolean);
    const existing = this.monsterNames.find(m => m.battleId === battleId);
    if (existing) existing.names = [...new Set([...existing.names, ...names])];
    else this.monsterNames.push({ battleId, names });
    while (this.monsterNames.length > 2) this.monsterNames.shift();
  }

  private updateRoster(): void {
    const state = this.lastState;
    const self = state?.username ?? '';
    const party = new Set<string>((state?.social?.party?.members ?? []).map(m => m.username));
    for (const unit of this.playback.units) {
      if (unit.side !== 'player') continue;
      const name = this.playback.statics(unit.key)?.name;
      if (name) party.add(name);
    }
    party.delete(self);
    const enemies = this.monsterNames.flatMap(m => m.names);
    if (this.formatter.setRoster(self, party, enemies)) this.logView.refresh();
  }

  private measureCentres(): void {
    this.centresDirty = false;
    this.centres.clear();
    const stageRect = this.stage.getBoundingClientRect();
    if (stageRect.width === 0 && stageRect.height === 0) return;
    for (const [key, card] of this.cards) {
      const r = card.body.getBoundingClientRect();
      const x = r.left + r.width / 2 - stageRect.left;
      this.centres.set(key, {
        x,
        y: r.top + r.height / 2 - stageRect.top,
        w: card.body.offsetWidth || r.width,
        h: card.body.offsetHeight || r.height,
      });
      card.setEdge(x < CAST_LABEL_EDGE_PX ? 'left' : x > stageRect.width - CAST_LABEL_EDGE_PX ? 'right' : '');
    }
    for (const t of this.telegraphs.values()) t.drawnKey = '';
  }

  private readAxis(): void {
    const declared = getComputedStyle(this.stageGrid).getPropertyValue('--combat-axis').trim();
    if (declared === 'x' || declared === 'y') {
      this.axis = declared;
      return;
    }
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    this.axis = h > 0 && w / h >= 1.1 ? 'x' : 'y';
  }

  /** Unit vector from a side toward the enemy on the current axis. */
  private towardEnemy(side: 'player' | 'monster'): { dx: number; dy: number } {
    const sign = side === 'player' ? 1 : -1;
    return this.axis === 'x' ? { dx: sign, dy: 0 } : { dx: 0, dy: -sign };
  }

  private onStageClick(e: MouseEvent): void {
    const cardEl = (e.target as HTMLElement).closest<HTMLElement>('.combat-card');
    if (!cardEl) return;
    const key = unitKey(cardEl.dataset.side === 'player' ? 'player' : 'monster', Number(cardEl.dataset.grid));
    const unit = this.playback.unitByKey(key);
    const st = this.playback.statics(key);
    if (!unit || !st) return;
    e.stopPropagation();
    if (unit.side === 'player') {
      if (!st.henchman && st.name) this.onUserClick?.(st.name, cardEl);
      return;
    }
    this.showMonsterPopup(unit, st.name, st.id, st.description);
  }

  private playEvent(ev: CombatEvent, now: number): void {
    const srcKey = ev.src ? unitKey(ev.src.side, ev.src.pos) : undefined;
    const dstKey = ev.dst ? unitKey(ev.dst.side, ev.dst.pos) : undefined;
    const srcAt = srcKey ? this.centres.get(srcKey) : undefined;
    const dstAt = dstKey ? this.centres.get(dstKey) : undefined;
    const srcCard = srcKey ? this.cards.get(srcKey) : undefined;
    const dstCard = dstKey ? this.cards.get(dstKey) : undefined;
    const fromSelf = !!srcKey && srcKey === this.selfKey;

    switch (ev.kind) {
      case 'battle_start':
        this.fx.banner('FIGHT!', 'fight', 950);
        break;
      case 'battle_end': {
        const victory = ev.result === 'victory';
        this.fx.banner(victory ? 'VICTORY!' : 'DEFEAT', victory ? 'victory' : 'defeat', 1400);
        if (victory) this.fx.sparkles(this.stageCentre());
        break;
      }
      case 'attack':
        if (srcCard && ev.src) {
          const dir = this.towardEnemy(ev.src.side);
          this.fx.lunge(srcCard.body, dir.dx, dir.dy, !!ev.skill);
        }
        if (fromSelf && ev.skillId) this.skillBar.flash(ev.skillId);
        break;
      case 'damage':
        if (dstCard && dstAt && ev.dst) {
          if (!ev.amount && !ev.overTime) {
            this.fx.text(dstKey!, dstAt, 'BLOCK', 'text-info', now);
            break;
          }
          this.fx.flash(dstCard.flashEl, ev.overTime ? 0.45 : 0.85);
          this.fx.number(dstKey!, dstAt, ev.amount ?? 0, variantFor(ev.dmgType), { crit: ev.crit, overTime: ev.overTime, now });
          if (!ev.overTime) {
            const away = this.towardEnemy(ev.dst.side);
            this.fx.recoil(dstCard.body, -away.dx, -away.dy);
          }
          if (ev.crit) this.fx.shake();
        }
        break;
      case 'heal':
        if (dstCard && dstAt) {
          this.fx.flash(dstCard.glowEl, 0.9, 520);
          this.fx.number(dstKey!, dstAt, ev.amount ?? 0, 'heal', { overTime: ev.overTime, now });
        }
        break;
      case 'shield':
        if (dstCard && dstAt) {
          this.fx.flash(dstCard.glowEl, 0.7, 480);
          this.fx.number(dstKey!, dstAt, ev.amount ?? 0, 'shield', { now });
        }
        break;
      case 'absorb':
        if (dstAt) this.fx.text(dstKey!, dstAt, 'ABSORB', 'text-info', now);
        break;
      case 'dodge':
        if (dstAt) this.fx.text(dstKey!, dstAt, 'DODGE', 'text-info', now);
        break;
      case 'stun':
        if (dstAt) this.fx.text(dstKey!, dstAt, 'STUNNED', 'text-bad', now);
        break;
      case 'resist':
        if (dstAt) this.fx.text(dstKey!, dstAt, 'RESIST', 'text-good', now);
        break;
      case 'fizzle':
        if (srcAt) this.fx.text(srcKey!, srcAt, 'FIZZLE', 'text-info', now);
        break;
      case 'revive':
        if (dstCard && dstAt) {
          this.fx.flash(dstCard.glowEl, 1, 700);
          this.fx.text(dstKey!, dstAt, 'REVIVED', 'text-good', now);
        }
        break;
      case 'cleanse':
        if (dstCard && dstAt && ev.dst?.side === 'player') {
          this.fx.flash(dstCard.glowEl, 0.8, 480);
          this.fx.text(dstKey!, dstAt, 'CLEANSED', 'text-good', now);
        }
        break;
      case 'interrupt':
        if (dstCard && dstAt && dstKey) {
          dstCard.breakCast(now);
          this.fx.stamp(dstAt, this.pendingCounters.has(dstKey) ? 'COUNTERED!' : 'INTERRUPTED!');
          this.pendingCounters.delete(dstKey);
        }
        break;
      case 'reaction':
        if (srcAt && ev.src) {
          const kind = ev.cardType === 'interrupt' ? 'interrupt' : 'instant';
          const icon = SKILL_CARD_TYPE_INFO[ev.cardType ?? 'instant']?.icon ?? '⚡';
          this.fx.reactionCard(srcAt, ev.skill ?? '', kind, icon, this.towardEnemy(ev.src.side).dy || -1);
          if (kind === 'interrupt' && dstKey) this.pendingCounters.add(dstKey);
        }
        if (fromSelf && ev.skillId) this.skillBar.flash(ev.skillId);
        break;
      case 'redirect':
        if (srcAt && dstAt) this.fx.arc(srcAt, dstAt);
        break;
      case 'cast_start':
        if (fromSelf && ev.skillId) this.skillBar.flash(ev.skillId);
        break;
      default:
        break;
    }
  }

  private stageCentre(): FxPoint {
    return { x: this.stage.clientWidth / 2, y: this.stage.clientHeight / 2, w: 0, h: 0 };
  }

  private updateTelegraphs(): void {
    const seen = new Set<string>();
    const targeted = new Set<string>();
    for (const unit of this.playback.units) {
      if (unit.side !== 'monster' || unit.cast?.target?.side !== 'player' || unit.hp <= 0) continue;
      const targetKey = unitKey(unit.cast.target.side, unit.cast.target.pos);
      seen.add(unit.key);
      targeted.add(targetKey);
      let t = this.telegraphs.get(unit.key);
      if (!t) {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('class', 'combat-telegraph-line');
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('class', 'combat-telegraph-ring');
        this.telegraphSvg.append(line, ring);
        t = { line, ring, targetKey, drawnKey: '' };
        this.telegraphs.set(unit.key, t);
      }
      t.targetKey = targetKey;
      const from = this.centres.get(unit.key);
      const to = this.centres.get(targetKey);
      if (!from || !to) continue;
      const key = `${from.x},${from.y},${to.x},${to.y}`;
      if (key === t.drawnKey) continue;
      t.drawnKey = key;
      t.line.setAttribute('x1', String(from.x));
      t.line.setAttribute('y1', String(from.y));
      t.line.setAttribute('x2', String(to.x));
      t.line.setAttribute('y2', String(to.y));
      t.ring.setAttribute('cx', String(to.x));
      t.ring.setAttribute('cy', String(to.y));
      t.ring.setAttribute('r', String(Math.max(10, Math.min(to.w, to.h) * 0.42)));
    }
    for (const [key, t] of this.telegraphs) {
      if (seen.has(key)) continue;
      t.line.remove();
      t.ring.remove();
      this.telegraphs.delete(key);
    }
    for (const key of this.targetedKeys) if (!targeted.has(key)) this.cards.get(key)?.setTargeted(false);
    for (const key of targeted) this.cards.get(key)?.setTargeted(true);
    this.targetedKeys = targeted;
  }

  private clearTelegraphs(): void {
    for (const t of this.telegraphs.values()) {
      t.line.remove();
      t.ring.remove();
    }
    this.telegraphs.clear();
    this.targetedKeys.clear();
  }

  private selfUnit(): PlaybackUnit | undefined {
    return this.selfKey ? this.playback.unitByKey(this.selfKey) : undefined;
  }

  private skillCardType(skillId: string, fromSnapshot?: SkillCardType): SkillCardType {
    if (fromSnapshot) return fromSnapshot;
    const def = this.worldCache.getSkill(skillId);
    return def ? getSkillCardType(def) : 'attack';
  }

  private refreshSkillLayout(): void {
    const unit = this.selfUnit();
    const state = this.lastState;
    const layout: SkillBarLayout = { cards: [], passives: [] };
    if (unit?.skills && this.selfKey) {
      const key = this.selfKey;
      layout.cards = unit.skills.map(s => {
        const st = this.playback.skillStatics(key, s.id);
        return { id: s.id, name: st?.name ?? this.worldCache.getSkill(s.id)?.name ?? s.id, cardType: this.skillCardType(s.id, st?.cardType) };
      });
      for (const id of this.playback.statics(key)?.passives ?? []) {
        const def = this.worldCache.getSkill(id);
        if (def) layout.passives.push({ id, name: def.name, cardType: getSkillCardType(def) });
      }
    } else {
      for (const id of state?.character?.skillLoadout.equippedSkills ?? []) {
        if (!id) continue;
        const def = this.worldCache.getSkill(id);
        if (!def) continue;
        if (def.type === 'active') layout.cards.push({ id, name: def.name, cardType: getSkillCardType(def) });
        else layout.passives.push({ id, name: def.name, cardType: getSkillCardType(def) });
      }
      if (this.playback.battleId !== null && this.playback.units.length > 0 && state?.character) layout.note = 'Joining next battle';
    }
    if (layout.cards.length === 0 && state?.character) {
      const slot = this.worldCache.getSlotSchedule(state.character.className).find(s => s.type === 'active');
      if (slot && state.character.level < slot.unlocksAtLevel) layout.note = `Active skill unlocks at level ${slot.unlocksAtLevel}`;
      else if (!layout.note) layout.note = 'No active skill equipped';
    }
    this.skillBar.setLayout(layout);
  }

  private updateSkillBar(writeText: boolean): void {
    const unit = this.selfUnit();
    const states: SkillBarState[] = [];
    if (unit?.skills && this.selfKey) {
      for (const s of unit.skills) {
        const trigger = this.playback.skillStatics(this.selfKey, s.id)?.trigger;
        const state = skillDisplayState(unit, s, trigger);
        const castProgress = state === 'casting' && unit.cast && unit.cast.totalMs > 0
          ? 1 - unit.cast.remainingMs / unit.cast.totalMs
          : undefined;
        states.push({ id: s.id, state, remainingMs: s.remainingMs, cooldownMs: s.cooldownMs, castProgress });
      }
    }
    this.skillBar.update(states, writeText);
  }

  private toggleSkillPopover(skillId: string, anchor: HTMLElement): void {
    if (this.popover && this.popoverSkillId === skillId) {
      this.closePopover();
      return;
    }
    this.closePopover();
    const def = this.worldCache.getSkill(skillId);
    const snapStatics = this.selfKey ? this.playback.skillStatics(this.selfKey, skillId) : undefined;
    const cardType = this.skillCardType(skillId, snapStatics?.cardType);
    const info = SKILL_CARD_TYPE_INFO[cardType];
    const trigger = snapStatics?.trigger ?? (def ? getSkillTrigger(def) : undefined);
    const live = this.selfUnit()?.skills?.find(s => s.id === skillId);
    const stats: string[] = [];
    if (def?.type !== 'passive') {
      const baseMs = def ? guessCooldownMs(def, undefined) : live?.cooldownMs ?? 0;
      const effectiveMs = live?.useCooldownMs || (def ? guessCooldownMs(def, live?.warmupMs) : baseMs);
      const reduced = effectiveMs > 0 && effectiveMs !== baseMs ? ` (base ${formatDuration(baseMs)})` : '';
      if (effectiveMs > 0) stats.push(`Cooldown ${formatDuration(effectiveMs)}${reduced}`);
    }
    const castMs = snapStatics?.castTimeMs ?? (def?.castTime ? def.castTime * 1000 : 0);
    if (castMs > 0) stats.push(`Cast ${formatDuration(castMs)}`);
    const triggerInfo = trigger ? SKILL_TRIGGER_INFO[trigger] : undefined;

    const pop = document.createElement('div');
    pop.className = 'combat-skill-popover';
    pop.dataset.cardType = cardType;
    pop.innerHTML = `
      <div class="combat-skill-popover-head">
        <span class="combat-skill-popover-icon">${info.icon}</span>
        <span class="combat-skill-popover-name">${escapeHtml(def?.name ?? snapStatics?.name ?? skillId)}</span>
        <span class="combat-skill-popover-type">${escapeHtml(info.label)}</span>
      </div>
      <div class="combat-skill-popover-blurb">${escapeHtml(info.blurb)}</div>
      ${def?.description ? `<div class="combat-skill-popover-desc">${escapeHtml(def.description)}</div>` : ''}
      ${stats.length > 0 ? `<div class="combat-skill-popover-stats">${stats.map(s => `<span>${escapeHtml(s)}</span>`).join('')}</div>` : ''}
      ${triggerInfo ? `<div class="combat-skill-popover-trigger"><b>⚡ ${escapeHtml(triggerInfo.label)}</b> — ${escapeHtml(triggerInfo.description)}</div>` : ''}
    `;
    this.container.appendChild(pop);
    this.popover = pop;
    this.popoverSkillId = skillId;
    this.positionPopover(pop, anchor);
  }

  private positionPopover(pop: HTMLElement, anchor: HTMLElement): void {
    const host = this.container.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const width = pop.offsetWidth || 260;
    const left = Math.max(8, Math.min(host.width - width - 8, a.left - host.left + a.width / 2 - width / 2));
    pop.style.left = `${left}px`;
    pop.style.bottom = `${Math.max(8, host.bottom - a.top + 8)}px`;
  }

  private closePopover(): void {
    this.popover?.remove();
    this.popover = null;
    this.popoverSkillId = '';
  }

  private updateHeader(state: ServerStateMessage): void {
    const d = state.dungeon;
    if (d) {
      this.locationLabel.textContent = d.name;
      this.floorBadge.style.display = '';
      this.floorBadge.textContent = d.isBossFloor ? `BOSS ${d.floor}/${d.totalFloors}` : `F${d.floor}/${d.totalFloors}`;
      this.floorBadge.classList.toggle('boss', d.isBossFloor);
      this.runBtn.style.display = 'none';
      this.dungeonLeaveBtn.style.display = '';
      const role = state.social?.party?.members.find(m => m.username === state.username)?.role;
      const canLeave = role === 'owner' || role === 'leader';
      this.dungeonLeaveBtn.classList.toggle('combat-dungeon-leave-locked', !canLeave);
      this.dungeonLeaveBtn.title = canLeave ? 'Leave Dungeon' : 'Only the party owner or a leader can leave';
      this.runHint.textContent = canLeave ? '' : 'Only the party owner or a leader can leave';
    } else {
      const zone = state.zoneName ?? '';
      const tile = state.party ? this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row) : null;
      const room = tile?.name ?? '';
      this.locationLabel.textContent = zone && room ? `${zone} · ${room}` : (zone || room);
      this.floorBadge.style.display = 'none';
      this.runBtn.style.display = '';
      this.dungeonLeaveBtn.style.display = 'none';
    }
    this.locationLabel.title = this.locationLabel.textContent ?? '';
    this.lastRunKey = '';
    this.updateRunButton(state);
  }

  private updateRunButton(state: ServerStateMessage): void {
    if (state.dungeon) return;
    const role = state.social?.party?.members.find(m => m.username === state.username)?.role;
    const canRun = role === 'owner' || role === 'leader';
    const fighting = state.battle.visual === 'fighting' && this.playback.battleId !== null && !this.playback.finished;
    const elapsed = this.playback.elapsedMs;
    const available = fighting && canRun && elapsed >= RUN_AVAILABLE_MS;
    const progress = fighting && canRun ? Math.min(1, elapsed / RUN_AVAILABLE_MS) : 0;
    const hint = !canRun
      ? 'Only the party owner or a leader can run'
      : fighting ? `Run becomes available ${RUN_AVAILABLE_MS / 1000} seconds into a fight` : '';
    const key = `${available}|${progress.toFixed(2)}|${hint}`;
    if (key === this.lastRunKey) return;
    this.lastRunKey = key;
    this.runBtn.classList.toggle('combat-run-locked', !available);
    this.runBtn.classList.toggle('ready', available);
    this.runBtn.style.setProperty('--run', progress.toFixed(2));
    this.runBtn.textContent = available ? 'Run' : '🔒 Run';
    this.runHint.textContent = hint;
  }

  private showRunHint(): void {
    if (!this.runHint.textContent) return;
    if (this.runHintTimer) clearTimeout(this.runHintTimer);
    this.runHint.style.display = '';
    this.runHintTimer = setTimeout(() => {
      this.runHint.style.display = 'none';
      this.runHintTimer = undefined;
    }, RUN_HINT_MS);
  }

  private updateClock(): void {
    const text = this.playback.battleId === null ? '–:––' : formatClock(this.playback.elapsedMs);
    if (text === this.lastClockText) return;
    this.lastClockText = text;
    this.clockEl.textContent = text;
  }

  private updateBackground(state: ServerStateMessage): void {
    const tile = state.party ? this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row) : null;
    const zoneId = tile?.zone ?? '';
    const enc = encodeURIComponent;
    const layers: string[] = [];
    if (tile) layers.push(`/combat-bg-artwork/${enc(tile.id)}.png`);
    if (state.party && zoneId) layers.push(`/combat-bg-artwork/${enc(zoneId)}-${state.party.col}-${state.party.row}.png`);
    if (zoneId) layers.push(`/combat-bg-artwork/${enc(zoneId)}.png`);
    if (zoneId) layers.push(`/zone-artwork/${enc(zoneId)}.png`);
    const layered = layers.map(u => `url('${u}')`).join(', ');
    if (this.stageBg.dataset.bgKey !== layered) {
      this.stageBg.style.backgroundImage = layered || 'none';
      this.stageBg.dataset.bgKey = layered;
    }
  }

  private showMonsterPopup(unit: PlaybackUnit, name: string, id: string | undefined, description: string | undefined): void {
    const existing = document.querySelector('.monster-popup-overlay') as HTMLElement | null;
    if (existing) { release(existing); existing.remove(); }
    const overlay = document.createElement('div');
    overlay.className = 'monster-popup-overlay';
    const real = artworkUrl('monster', id || slugify(name));
    const fallback = placeholderUrl(name, { w: 160, h: 160 });
    const desc = description?.trim();
    overlay.innerHTML = `
      <div class="monster-popup">
        <button class="monster-popup-close" aria-label="Close">×</button>
        <div class="monster-popup-art">
          <img src="${real}" alt="${escapeHtml(name)}"
               onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${fallback}';}else{this.style.display='none';}" />
        </div>
        <div class="monster-popup-name">${escapeHtml(name)}</div>
        <div class="monster-popup-hp"><div class="monster-popup-hp-fill"></div><span></span></div>
        <div class="monster-popup-status"></div>
        <div class="monster-popup-cast"></div>
        ${desc ? `<div class="monster-popup-description">${escapeHtml(desc)}</div>` : ''}
      </div>
    `;
    document.body.appendChild(overlay);
    const close = (): void => {
      release(overlay);
      overlay.remove();
      if (this.monsterPopup?.overlay === overlay) this.monsterPopup = null;
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || (e.target as HTMLElement).closest('.monster-popup-close')) close();
    });
    bringToFront(overlay);
    wireFocusOnInteract(overlay);
    this.monsterPopup = { overlay, key: unit.key, battleId: this.playback.battleId, lastKey: '' };
    this.refreshMonsterPopup();
  }

  private refreshMonsterPopup(): void {
    const pop = this.monsterPopup;
    if (!pop) return;
    if (!pop.overlay.isConnected) {
      this.monsterPopup = null;
      return;
    }
    if (pop.battleId !== this.playback.battleId) return;
    const unit = this.playback.unitByKey(pop.key);
    if (!unit) return;
    const pips = statusPips(unit);
    const dead = unit.hp <= 0;
    const key = `${Math.round(unit.hp)}|${unit.maxHp}|${pipsKey(pips)}|${unit.cast?.skill ?? ''}`;
    if (key === pop.lastKey) return;
    pop.lastKey = key;
    const root = pop.overlay;
    const hpPct = unit.maxHp > 0 ? Math.max(0, Math.min(100, (unit.hp / unit.maxHp) * 100)) : 0;
    root.querySelector<HTMLElement>('.monster-popup')!.classList.toggle('defeated', dead);
    root.querySelector<HTMLElement>('.monster-popup-hp-fill')!.style.width = `${hpPct.toFixed(1)}%`;
    root.querySelector<HTMLElement>('.monster-popup-hp span')!.textContent = dead ? 'Defeated' : `${formatAmount(unit.hp)} / ${formatAmount(unit.maxHp)}`;
    const status = root.querySelector<HTMLElement>('.monster-popup-status')!;
    status.innerHTML = pips.map(p => `<span class="combat-pip ${p.tone}">${p.icon}${p.count ? `<b>${p.count}</b>` : ''} ${escapeHtml(p.title)}</span>`).join('');
    status.style.display = pips.length > 0 ? '' : 'none';
    const cast = root.querySelector<HTMLElement>('.monster-popup-cast')!;
    cast.innerHTML = unit.cast ? `Casting <b>${escapeHtml(unit.cast.skill)}</b>` : '';
    cast.style.display = unit.cast ? '' : 'none';
  }
}

