import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type {
  CombatEvent,
  ForecastResult,
  MasteryEntry,
  ServerCombatMessage,
  ServerForecastMessage,
  ServerStateMessage,
  SkillCardType,
  SkillDefinition,
} from '@idle-party-rpg/shared';
import {
  CLASS_ICONS,
  getSkillCardType,
  isTimedSkill,
  getSkillTrigger,
  henchmanDisplayNames,
  RUN_AVAILABLE_MS,
  COMBAT_PACE,
  paceSkillSeconds,
  SKILL_CARD_TYPE_INFO,
  SKILL_TRIGGER_INFO,
} from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import { artworkUrl, placeholderUrl } from '../ui/assets';
import { bringToFront, registerDismiss, release, wireFocusOnInteract } from '../ui/ModalStack';
import { deferWhilePressed, setHtml } from '../ui/render';
import { discoveredRoomName } from '../ui/routeSummary';
import { CombatPlayback, enrageDisplay, guessCooldownMs, skillDisplayState, timedSkillMs, unitKey } from '../combat/CombatPlayback';
import type { PlaybackUnit, UnitStatics } from '../combat/CombatPlayback';
import { battleStatus, battleStatusHtml, rewardLines } from '../combat/BattleStatus';
import type { CharacterProgress } from '../combat/BattleStatus';
import { CombatFx } from '../combat/CombatFx';
import type { BannerTone, FloaterVariant, FxPoint } from '../combat/CombatFx';
import { isJournalLine } from '../combat/CombatLogBuffer';
import { CombatLogFormatter } from '../combat/CombatLogFormatter';
import { CombatLogView } from '../combat/CombatLogView';
import { CombatSkillBar } from '../combat/CombatSkillBar';
import { classAttackSkill } from '../ui/SkillCardChip';
import type { SkillBarLayout, SkillBarState } from '../combat/CombatSkillBar';
import { UnitCard } from '../combat/CombatUnitCard';
import type { CardIdentity } from '../combat/CombatUnitCard';
import {
  bossOpening,
  enrageSlotText,
  escapeHtml,
  formatAmount,
  formatClock,
  formatDuration,
  formatMultiplier,
  hasToughTier,
  interruptStampText,
  isBossOrRaid,
  leaveDungeonWarning,
  masteryLine,
  monsterLevelBadge,
  pipsKey,
  retriesLeft,
  retriesText,
  statusPips,
  TIER_INFO,
} from '../combat/CombatFormat';
import { OPEN_OPTIONS_ATTR, renderForecastPopover, renderForecastRing } from '../ui/ForecastChip';

type Axis = 'x' | 'y';

const TEXT_INTERVAL_MS = 100;
const CHARGE_REDUCED_MIN_MS = 50;
const RUN_HINT_MS = 3000;
const POP_IN_STAGGER_MS = 45;
const CAST_LABEL_EDGE_PX = 70;
const SHORT_SCREEN_QUERY = '(max-height: 480px)';
const BOSS_HP_EPSILON = 0.005;
const ANNOUNCE_DELAY_MS = 60;
const LIVE_FORECASTS_KEPT = 4;
const ANNOUNCED_LOG_TYPES = new Set(['retreat', 'checkpoint']);
const BOSS_STARTS_KEPT = 3;
const BACKGROUND_PLACEHOLDER = { w: 640, h: 360 };
/** A side this small drops its empty tracks and scales its cards up. */
const ROOMY_SIDE_UNITS = 2;
/** Past this many cards on the board, per-hit motion plays only on the player's own card. */
const FULL_FX_MAX_CARDS = 6;
const GRID_LINES = [0, 1, 2];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

/** The grid tracks a side actually uses; a seat's row is `pos / 3` and its column `pos % 3`. */
export function usedGridTracks(positions: readonly number[]): { rows: boolean[]; cols: boolean[] } {
  return {
    rows: GRID_LINES.map(line => positions.some(pos => Math.floor(pos / 3) === line)),
    cols: GRID_LINES.map(line => positions.some(pos => pos % 3 === line)),
  };
}

function bossRunKey(dungeon: { dungeonId: string; floor: number }): string {
  return `${dungeon.dungeonId}:${dungeon.floor}`;
}

/** The header stands in for the log ticker only on short screens, where the ticker is hidden; the chat sheet hides the log too. */
export function headerOpensLog(shortScreen: boolean, chatOpen: boolean): boolean {
  return shortScreen && !chatOpen;
}

export interface LiveForecast {
  result: ForecastResult | null;
  pending: boolean;
}

/** A re-forecast keeps the last estimate on screen, marked as updating, until the new one lands. */
export function mergeLiveForecast(prev: LiveForecast | undefined, msg: ServerForecastMessage): LiveForecast {
  if (msg.status === 'ok' && msg.result) return { result: msg.result, pending: false };
  if (msg.status === 'pending') return { result: prev?.result ?? null, pending: true };
  return { result: null, pending: false };
}

function variantFor(dmgType: string | undefined): FloaterVariant {
  if (dmgType === 'magical') return 'magical';
  if (dmgType === 'holy') return 'holy';
  return 'physical';
}

interface MonsterPopupState {
  overlay: HTMLElement;
  key: string;
  battleId: number | null;
  lastKey: string;
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
  private statusEl!: HTMLElement;
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
  private runLabel!: HTMLElement;
  private forecastBtn!: HTMLButtonElement;
  private bossBar!: HTMLElement;
  private bossName!: HTMLElement;
  private bossTrack!: HTMLElement;
  private bossTicks!: HTMLElement;
  private bossPct!: HTMLElement;
  private bossRetries!: HTMLElement;
  private bossEnrage!: HTMLElement;
  private announcer!: HTMLElement;
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
  private syncedUnits = new Map<string, { unit: PlaybackUnit; st: UnitStatics }>();
  private centres = new Map<string, FxPoint>();
  private centresDirty = true;
  private axis: Axis = 'y';
  private telegraphs = new Map<string, { line: SVGLineElement; ring: SVGCircleElement; targetKey: string; drawnKey: string }>();
  private targetedKeys = new Set<string>();
  private monsterNames: { battleId: number; names: string[] }[] = [];
  private selfKey: string | null = null;
  private rafId = 0;
  private lastTextAt = -Infinity;
  private lastClockText = '';
  private lastRunKey = '';
  private runHintTimer?: ReturnType<typeof setTimeout>;
  private snapping = false;
  private syncingShown = false;
  private cameFromIdleBoard = false;
  private monsterPopup: MonsterPopupState | null = null;
  private leaveConfirm: HTMLElement | null = null;
  private bossStructureKey = '';
  private bossHpShown = -1;
  private bossTextKey = '';
  private toughFight = false;
  private liveForecasts = new Map<number, LiveForecast>();
  private forecastChipKey = '';
  private forecastPopover: HTMLElement | null = null;
  private announceQueue: string[] = [];
  private announceTimer?: ReturnType<typeof setTimeout>;
  private lastJournalSeq = 0;
  private bossStarts: { battleId: number; run: string; wipes: number }[] = [];
  private headerLatch: { battleId: number; state: ServerStateMessage } | null = null;
  private statusFinished = false;
  private statusBattleId: number | null = null;
  private rewardBaseline: CharacterProgress | null = null;
  private rewards: string[] = [];
  private rewardsCounted = false;

  private onUserClick?: (username: string, anchor: HTMLElement) => void;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.playback = new CombatPlayback({
      cooldownHint: id => {
        const skill = this.worldCache.getSkill(id);
        return skill ? guessCooldownMs(skill, this.skillOwnerClass(skill)) : undefined;
      },
    });

    this.buildDOM();
    this.wireSubscriptions();

    const state = gameClient.lastState;
    if (state) {
      this.lastState = state;
      this.playback.ingestState(state.battle.combat);
      this.trackRewards(state);
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
    this.gameClient.sendCombatView(true);
    this.logView.setActive(true);
    this.lastJournalSeq = this.newestJournalSeq();
    this.updateRoster();
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
    this.logView.setOpen(false);
    this.stopLoop();
    this.closePopover();
    this.closeForecastPopover();
    this.closeLeaveConfirm();
    this.fx.clearAll();
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="combat-header">
        <span class="combat-run-location"></span>
        <span class="combat-dungeon-floor" style="display:none"></span>
        <button class="combat-forecast" type="button" style="display:none"></button>
        <span class="combat-clock">–:––</span>
        <button class="combat-run-btn combat-run-locked" type="button"><span class="combat-run-label">Run</span><span class="combat-auto-retreat" aria-hidden="true" hidden>🏳</span></button>
        <button class="combat-dungeon-leave" type="button" style="display:none">Leave<span class="combat-auto-retreat" aria-hidden="true" hidden>🏳</span></button>
        <span class="combat-run-hint" style="display:none"></span>
      </div>
      <div class="combat-stage">
        <div class="combat-stage-bg"></div>
        <div class="combat-stage-scrim"></div>
        <div class="combat-boss-bar" style="display:none" data-enrage="off">
          <span class="combat-boss-name"></span>
          <div class="combat-boss-track" role="progressbar" aria-valuemin="0" aria-valuemax="100">
            <div class="combat-boss-skipped"></div>
            <div class="combat-boss-fill"></div>
            <div class="combat-boss-ticks"></div>
            <span class="combat-boss-pct"></span>
          </div>
          <span class="combat-boss-retries"></span>
          <span class="combat-boss-enrage" style="display:none"></span>
        </div>
        <svg class="combat-telegraph" aria-hidden="true"></svg>
        <div class="combat-stage-grid">
          <div class="combat-block combat-block-enemy">
            <div class="combat-side combat-enemy-side"></div>
          </div>
          <div class="combat-stage-divider"><div class="combat-status"></div></div>
          <div class="combat-block combat-block-party">
            <div class="combat-side combat-player-side"></div>
          </div>
        </div>
        <div class="combat-fx-layer" aria-hidden="true"></div>
        <div class="combat-banner"></div>
      </div>
      <div class="combat-skillbar"></div>
      <div class="combat-log-wrapper"></div>
      <div class="combat-announcer" role="status" aria-live="polite"></div>
    `;

    this.header = this.container.querySelector('.combat-header')!;
    this.locationLabel = this.container.querySelector('.combat-run-location')!;
    this.floorBadge = this.container.querySelector('.combat-dungeon-floor')!;
    this.clockEl = this.container.querySelector('.combat-clock')!;
    this.runBtn = this.container.querySelector('.combat-run-btn')!;
    this.runHint = this.container.querySelector('.combat-run-hint')!;
    this.dungeonLeaveBtn = this.container.querySelector('.combat-dungeon-leave')!;
    this.runLabel = this.container.querySelector('.combat-run-label')!;
    this.forecastBtn = this.container.querySelector('.combat-forecast')!;
    this.bossBar = this.container.querySelector('.combat-boss-bar')!;
    this.bossName = this.container.querySelector('.combat-boss-name')!;
    this.bossTrack = this.container.querySelector('.combat-boss-track')!;
    this.bossTicks = this.container.querySelector('.combat-boss-ticks')!;
    this.bossPct = this.container.querySelector('.combat-boss-pct')!;
    this.bossRetries = this.container.querySelector('.combat-boss-retries')!;
    this.bossEnrage = this.container.querySelector('.combat-boss-enrage')!;
    this.announcer = this.container.querySelector('.combat-announcer')!;
    this.stage = this.container.querySelector('.combat-stage')!;
    this.stageBg = this.container.querySelector('.combat-stage-bg')!;
    this.stageGrid = this.container.querySelector('.combat-stage-grid')!;
    this.statusEl = this.container.querySelector('.combat-status')!;
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
    this.logView.setOnOpenChange(() => {
      this.closePopover();
      this.closeForecastPopover();
    });

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
      const warning = leaveDungeonWarning(this.lastState?.dungeon, this.fightUnderWay());
      if (warning) this.confirmLeaveDungeon(warning);
      else this.gameClient.sendLeaveDungeon();
    });
    this.forecastBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleForecastPopover();
    });
    this.header.addEventListener('click', () => {
      const chatOpen = document.body.dataset.chatOpen === '1' && document.body.dataset.chatLayout !== 'column';
      if (headerOpensLog(window.matchMedia?.(SHORT_SCREEN_QUERY).matches ?? false, chatOpen)) {
        this.logView.setOpen(true);
      }
    });
    this.stageGrid.addEventListener('click', (e) => this.onStageClick(e));
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (this.popover && !target.closest('.combat-skill-popover, [data-skill-id]')) this.closePopover();
      if (this.forecastPopover && (!target.closest('.combat-forecast-popover') || target.closest(`[${OPEN_OPTIONS_ATTR}]`))) {
        this.closeForecastPopover();
      }
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
    this.gameClient.onForecast((msg) => this.handleForecast(msg));
    this.gameClient.combatLog.subscribe(() => this.announceJournal());
    document.addEventListener('visibilitychange', () => {
      if (!this.isActive) return;
      const visible = document.visibilityState !== 'hidden';
      this.playback.setActive(visible);
      if (visible) this.startLoop();
      else this.stopLoop();
    });
  }

  private handleState(state: ServerStateMessage): void {
    this.lastState = state;
    this.playback.ingestState(state.battle.combat, performance.now());
    this.trackRewards(state);
    if (!this.isActive) return;
    this.updateRoster();
    deferWhilePressed(this.container, () => {
      if (this.isActive && this.lastState) this.applyState(this.lastState);
    });
    this.wakeLoop();
  }

  private handleCombat(msg: ServerCombatMessage, receivedAt: number): void {
    this.playback.ingestMessage(msg, receivedAt);
    this.wakeLoop();
  }

  private applyState(state: ServerStateMessage): void {
    this.stage.classList.remove('fighting', 'victory', 'defeat', 'retreat');
    if (state.battle.visual !== 'none') this.stage.classList.add(state.battle.visual);
    this.updateBackground(state);
    this.updateHeader(state);
    this.syncIdleBoard(state);
    this.paintStatus();
    this.refreshIdentities();
    this.refreshSkillLayout();
    this.refreshBossBar();
    this.renderForecastChip();
  }

  private startLoop(): void {
    if (this.rafId || typeof requestAnimationFrame !== 'function') return;
    this.rafId = requestAnimationFrame(() => this.frame());
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private wakeLoop(): void {
    if (this.isActive && document.visibilityState !== 'hidden') this.startLoop();
  }

  private frame(): void {
    this.rafId = 0;
    try {
      this.renderFrame(performance.now());
    } catch (err) {
      console.error('[CombatScreen] frame error:', err);
    }
    if (!this.nothingToDraw()) this.startLoop();
  }

  /** Effects run on their own timelines; the loop only drives playback, so it sleeps once that has played out. */
  private nothingToDraw(): boolean {
    return this.playback.settled
      && !this.snapping
      && !this.gameClient.combatLog.hasPending
      && this.playback.battleId === this.renderedBattleId
      && this.playback.version === this.renderedVersion;
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
    if (this.playback.battleId !== this.renderedBattleId || this.playback.version !== this.renderedVersion) {
      this.rememberMonsterNames();
      this.updateRoster();
      deferWhilePressed(this.stage, () => {
        if (this.isActive) this.syncCards();
      });
    }
    if (this.centresDirty) this.measureCentres();
    for (const ev of tick.events) this.playEvent(ev, now);
    if (this.playback.finished !== this.statusFinished || this.playback.battleId !== this.statusBattleId) this.paintStatus();
    if (this.playback.battleId === this.renderedBattleId) {
      for (const unit of this.playback.units) this.cards.get(unit.key)?.update(unit, now);
    }
    this.updateTelegraphs();
    this.updateBossHp();

    const writeText = now - this.lastTextAt >= TEXT_INTERVAL_MS;
    if (writeText) this.lastTextAt = now;
    this.updateSkillBar(writeText);
    if (writeText) {
      this.updateClock();
      this.updateBossText();
      const header = this.headerLatch?.state ?? this.lastState;
      if (header) this.updateRunButton(header);
      this.refreshMonsterPopup();
    }
    this.gameClient.combatLog.release(this.playback.battleId, this.playback.renderTime);
  }

  private syncCards(): void {
    const battleChanged = this.playback.battleId !== this.renderedBattleId;
    if (battleChanged) {
      this.fx.clearAll(true);
      this.clearTelegraphs();
      this.stage.classList.remove('big-result');
    }
    this.renderedBattleId = this.playback.battleId;
    this.renderedVersion = this.playback.version;
    if (this.playback.units.length > 0) {
      this.syncFightCards(battleChanged);
    } else if (this.lastState) {
      this.syncIdleBoard(this.lastState);
    }
    this.layoutBlocks();
    this.centresDirty = true;
    this.refreshIdentities();
    this.refreshSkillLayout();
    this.refreshBossBar();
    if (battleChanged) {
      this.closeForecastPopover();
      this.adoptCachedForecast();
      if (this.lastState) this.updateHeader(this.lastState);
    }
    this.renderForecastChip();
  }

  private syncFightCards(battleChanged: boolean): void {
    this.stage.classList.remove('no-combat');
    const units = this.playback.units;
    if (battleChanged) this.dropCardsFromLastFight();
    const live = new Set<string>();
    let order = 0;
    for (const unit of units) {
      live.add(unit.key);
      if (this.cards.has(unit.key)) continue;
      const card = this.addCard(unit.key, unit.side, unit.pos);
      if (battleChanged || this.cameFromIdleBoard) this.fx.popIn(card.el, (order++) * POP_IN_STAGGER_MS);
    }
    this.cameFromIdleBoard = false;
    for (const [key, card] of this.cards) {
      if (live.has(key)) continue;
      card.el.remove();
      this.cards.delete(key);
    }
    this.syncedUnits.clear();
    for (const unit of units) {
      const st = this.playback.statics(unit.key);
      if (st) this.syncedUnits.set(unit.key, { unit, st });
    }
  }

  /** A taken party seat keeps its card between fights (its identity is refreshed in place); monsters go. */
  private dropCardsFromLastFight(): void {
    for (const [key, card] of this.cards) {
      if (this.playback.unitByKey(key)?.side === 'player') continue;
      card.el.remove();
      this.cards.delete(key);
    }
  }

  private addCard(key: string, side: 'player' | 'monster', pos: number): UnitCard {
    const card = new UnitCard(key, side, pos);
    (side === 'player' ? this.playerSide : this.enemySide).appendChild(card.el);
    this.cards.set(key, card);
    return card;
  }

  /** With no fight to draw, the last board stays dimmed; on a first load the party comes from the roster. */
  private syncIdleBoard(state: ServerStateMessage): void {
    if (this.playback.units.length > 0) return;
    this.stage.classList.toggle('no-combat', this.playback.battleId === null);
    this.cameFromIdleBoard = true;
    const party = state.social?.party;
    if (!party) return;
    const hired = party.henchmen ?? [];
    const henchmanNames = henchmanDisplayNames(hired.map(h => h.name ?? ''), party.members.map(m => m.username));
    const seats = new Map<string, CardIdentity>();
    for (const member of party.members) {
      const isSelf = member.username === state.username;
      const className = member.className ?? (isSelf ? state.character?.className : undefined) ?? '';
      seats.set(unitKey('player', member.gridPosition), {
        name: member.username, isSelf, henchman: false, passive: false,
        art: className ? artworkUrl('class', className) : undefined,
        icon: CLASS_ICONS[className],
      });
    }
    hired.forEach((henchman, i) => {
      seats.set(unitKey('player', henchman.gridPosition), {
        name: henchmanNames[i] ?? henchman.name ?? 'Ally', isSelf: false, henchman: true, passive: false,
        art: henchman.artworkUrl, emoji: henchman.emoji || undefined,
      });
    });
    for (const [key, card] of this.cards) {
      if (card.el.dataset.side !== 'player' || seats.has(key)) continue;
      card.el.remove();
      this.cards.delete(key);
    }
    for (const [key, identity] of seats) {
      if (!this.cards.has(key)) this.centresDirty = true;
      const card = this.cards.get(key) ?? this.addCard(key, 'player', Number(key.split(':')[1]));
      card.setIdentity(identity);
    }
    this.layoutBlocks();
  }

  private layoutBlocks(): void {
    for (const side of [this.playerSide, this.enemySide]) this.layoutBlock(side);
  }

  /** Dead units keep their cards, so a side only changes shape when its roster does. */
  private layoutBlock(side: HTMLElement): void {
    const positions = [...side.children].map(el => Number((el as HTMLElement).dataset.grid)).sort((a, b) => a - b);
    const key = positions.join(',');
    if (side.dataset.layoutKey === key) return;
    side.dataset.layoutKey = key;
    this.centresDirty = true;
    const block = side.parentElement!;
    if (positions.length > 0 && positions.length <= ROOMY_SIDE_UNITS) block.dataset.roomy = String(positions.length);
    else delete block.dataset.roomy;
    const { rows, cols } = usedGridTracks(positions);
    GRID_LINES.forEach((line) => {
      side.style.setProperty(`--track-row${line}`, rows[line] ? 'minmax(0, 1fr)' : '0');
      side.style.setProperty(`--track-col${line}`, cols[line] ? 'minmax(0, 1fr)' : '0');
    });
  }

  private progressOf(state: ServerStateMessage): CharacterProgress | null {
    const c = state.character;
    return c ? { level: c.level, xp: c.xp, xpForNextLevel: c.xpForNextLevel, gold: c.gold } : null;
  }

  /** The state push that flips the visual to victory is the one carrying the rewards. */
  private trackRewards(state: ServerStateMessage): void {
    const visual = state.battle.visual;
    if (visual === 'victory') {
      if (this.rewardsCounted) return;
      this.rewardsCounted = true;
      this.rewards = rewardLines(this.rewardBaseline, this.progressOf(state));
      return;
    }
    this.rewardBaseline = this.progressOf(state);
    this.rewardsCounted = false;
    if (visual === 'fighting') this.rewards = [];
  }

  private paintStatus(): void {
    this.statusFinished = this.playback.finished;
    this.statusBattleId = this.playback.battleId;
    const state = this.lastState;
    if (!state) return;
    const walking = state.battle.visual === 'none' && state.battle.state === 'result';
    const nextRoom = state.party?.path?.[0];
    const target = walking ? state.party : nextRoom;
    const status = battleStatus({
      visual: state.battle.visual,
      hasFight: this.playback.battleId !== null,
      result: this.playback.result,
      inDungeon: !!state.dungeon,
      walking,
      hasDestination: !!nextRoom,
      roomName: target ? discoveredRoomName(state, this.worldCache, target.col, target.row) : null,
      rewards: this.rewards,
    });
    this.statusEl.classList.toggle('show', !!status);
    this.stage.classList.toggle('status-shown', !!status);
    if (!status) return;
    this.statusEl.dataset.tone = status.tone;
    setHtml(this.statusEl, battleStatusHtml(status));
  }

  private refreshIdentities(): void {
    const state = this.lastState;
    const username = state?.username ?? '';
    const henchmen = state?.social?.party?.henchmen ?? [];
    const henchmanNames = henchmanDisplayNames(
      henchmen.map(h => h.name ?? ''),
      (state?.social?.party?.members ?? []).map(m => m.username),
    );
    const viewerLevel = state?.character?.level;
    let tough = false;
    this.selfKey = null;
    for (const unit of this.playback.units) {
      const card = this.cards.get(unit.key);
      const st = this.playback.statics(unit.key);
      if (!card) continue;
      const name = st?.name || (unit.side === 'monster' ? 'Enemy' : 'Ally');
      let identity: CardIdentity;
      if (unit.side === 'player') {
        if (st?.henchman) {
          const hired = henchmen[henchmanNames.indexOf(name)] ?? henchmen.find(h => h.gridPosition === unit.pos);
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
        if (hasToughTier(st?.tier)) tough = true;
        identity = {
          name, isSelf: false, henchman: false, passive: !!st?.passive,
          art: artworkUrl('monster', artKey),
          artFallback: placeholderUrl(name, { w: 160, h: 160 }),
          level: monsterLevelBadge(st, viewerLevel),
          tier: st?.tier,
        };
      }
      card.setIdentity(identity);
    }
    this.toughFight = tough;
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
      const anchor = card.el.closest('.combat-block[data-roomy]') ? card.portraitEl : card.body;
      const r = anchor.getBoundingClientRect();
      const x = r.left + r.width / 2 - stageRect.left;
      this.centres.set(key, {
        x,
        y: r.top + r.height / 2 - stageRect.top,
        w: anchor.offsetWidth || r.width,
        h: anchor.offsetHeight || r.height,
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
    const clicked = this.clickedUnit(key);
    if (!clicked) return;
    const { unit, st } = clicked;
    e.stopPropagation();
    if (unit.side === 'player') {
      if (!st.henchman && st.name) this.onUserClick?.(st.name, cardEl);
      return;
    }
    this.showMonsterPopup(unit, st);
  }

  /** A card held through a press can outlive its battle, so it answers for the battle it was drawn from. */
  private clickedUnit(key: string): { unit: PlaybackUnit; st: UnitStatics } | undefined {
    if (this.playback.battleId !== this.renderedBattleId) return this.syncedUnits.get(key);
    const unit = this.playback.unitByKey(key);
    const st = this.playback.statics(key);
    return unit && st ? { unit, st } : undefined;
  }

  private playEvent(ev: CombatEvent, now: number): void {
    const srcKey = ev.src ? unitKey(ev.src.side, ev.src.pos) : undefined;
    const dstKey = ev.dst ? unitKey(ev.dst.side, ev.dst.pos) : undefined;
    const srcAt = srcKey ? this.centres.get(srcKey) : undefined;
    const dstAt = dstKey ? this.centres.get(dstKey) : undefined;
    const srcCard = srcKey ? this.cards.get(srcKey) : undefined;
    const dstCard = dstKey ? this.cards.get(dstKey) : undefined;
    const fromSelf = !!srcKey && srcKey === this.selfKey;
    const fullFx = this.cards.size <= FULL_FX_MAX_CARDS;

    switch (ev.kind) {
      case 'battle_start':
        this.showStartBanner();
        break;
      case 'battle_end':
        this.stage.classList.toggle('big-result', this.bigFight());
        if (ev.result === 'victory') {
          this.showBanner('VICTORY!', 'victory', 1400);
          if (this.bigFight()) this.fx.sparkles(this.stageCentre());
        } else if (ev.result === 'retreat') {
          this.showBanner('RETREAT', 'retreat', 1400);
        } else {
          this.showBanner('DEFEAT', 'defeat', 1400);
        }
        break;
      case 'phase': {
        const total = this.playback.bossPhases?.thresholds.length ?? 0;
        const n = ev.amount ?? 0;
        this.showBanner('CHECKPOINT!', 'checkpoint', 1300, total > 0 ? `Checkpoint ${n} of ${total}` : `Checkpoint ${n}`);
        this.fx.sparkles(this.bossBarCentre(), 10);
        break;
      }
      case 'enrage': {
        if ((ev.amount ?? 0) !== 1) break;
        const unit = srcKey ? this.playback.unitByKey(srcKey) : undefined;
        const mult = unit?.enrage ? 1 + unit.enrage.stepPercent : undefined;
        this.showBanner('ENRAGED!', 'enrage', 1200, mult ? `Enemy damage ${formatMultiplier(mult)} and rising` : undefined);
        break;
      }
      case 'attack':
        if (srcCard && ev.src && (fullFx || fromSelf)) {
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
          const motion = fullFx || dstKey === this.selfKey;
          if (motion) this.fx.flash(dstCard.flashEl, ev.overTime ? 0.45 : 0.85);
          this.fx.number(dstKey!, dstAt, ev.amount ?? 0, variantFor(ev.dmgType), { crit: ev.crit, overTime: ev.overTime, now });
          if (motion && !ev.overTime) {
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
        if (dstCard && dstAt) {
          dstCard.breakCast(now);
          this.fx.stamp(dstAt, interruptStampText(ev));
        }
        break;
      case 'reaction':
        if (srcAt && ev.src) this.fx.reactionCard(srcAt, ev.skill ?? '', this.towardEnemy(ev.src.side).dy || -1);
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

  private bossBarCentre(): FxPoint {
    const stageRect = this.stage.getBoundingClientRect();
    const r = this.bossTrack.getBoundingClientRect();
    if (r.width === 0) return this.stageCentre();
    return { x: r.left + r.width / 2 - stageRect.left, y: r.top + r.height / 2 - stageRect.top, w: r.width, h: r.height };
  }

  private showStartBanner(): void {
    const boss = this.playback.bossPhases;
    if (!boss) {
      this.showBanner('FIGHT!', 'fight', 950);
      return;
    }
    const resumed = boss.resumedFromPhase ?? 0;
    const d = this.lastState?.dungeon;
    const battleId = this.playback.battleId;
    const run = d ? bossRunKey(d) : '';
    const wipes = d?.wipes ?? 0;
    const previous = [...this.bossStarts].reverse().find(s => s.battleId !== battleId && s.run === run);
    if (d && battleId !== null) this.rememberBossStart(battleId, run, wipes);
    const left = retriesLeft(d?.wipes, d?.maxWipes);
    const retries = left !== null ? ` · ${retriesText(left)}` : '';
    switch (bossOpening(resumed, wipes, previous?.wipes ?? null)) {
      case 'regroup':
        this.showBanner('REGROUP', 'regroup', 1400, `${resumed > 0 ? `Checkpoint ${resumed}` : 'Another attempt'}${retries}`);
        break;
      case 'resume':
        this.showBanner('BOSS FIGHT!', 'boss', 1300, `From checkpoint ${resumed}${retries}`);
        break;
      default:
        this.showBanner('BOSS FIGHT!', 'boss', 1300);
    }
  }

  private rememberBossStart(battleId: number, run: string, wipes: number): void {
    this.bossStarts = this.bossStarts.filter(s => s.battleId !== battleId);
    this.bossStarts.push({ battleId, run, wipes });
    if (this.bossStarts.length > BOSS_STARTS_KEPT) this.bossStarts.shift();
  }

  /** Routine fights loop every few seconds, so only these get the loud banners; the status chip covers the rest. */
  private bigFight(): boolean {
    return this.toughFight || !!this.playback.bossPhases;
  }

  private showBanner(text: string, tone: BannerTone, holdMs: number, sub?: string): void {
    if (this.bigFight()) this.fx.banner(text, tone, holdMs, sub);
    this.announce(sub ? `${text} ${sub}` : text);
  }

  private announce(text: string): void {
    if (!this.isActive) return;
    this.announceQueue.push(text);
    if (this.announceTimer) return;
    this.announcer.textContent = '';
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined;
      this.announcer.textContent = this.announceQueue.join('. ');
      this.announceQueue = [];
    }, ANNOUNCE_DELAY_MS);
  }

  private newestJournalSeq(): number {
    const entries = this.gameClient.combatLog.entries;
    return entries.length > 0 ? entries[entries.length - 1].seq : 0;
  }

  private announceJournal(): void {
    const entries = this.gameClient.combatLog.entries;
    if (this.isActive) {
      const fresh: string[] = [];
      for (let i = entries.length - 1; i >= 0 && entries[i].seq > this.lastJournalSeq; i--) {
        if (ANNOUNCED_LOG_TYPES.has(entries[i].type) && isJournalLine(entries[i])) fresh.push(entries[i].text);
      }
      for (const text of fresh.reverse()) this.announce(text);
    }
    this.lastJournalSeq = this.newestJournalSeq();
  }

  private refreshBossBar(): void {
    const boss = this.playback.bossPhases;
    const bossUnits = boss ? boss.bossPos.map(pos => this.playback.statics(unitKey('monster', pos))).filter((s): s is UnitStatics => !!s) : [];
    const name = bossUnits[0]?.name ?? '';
    const key = boss
      ? `${this.playback.battleId}|${boss.thresholds.join(',')}|${boss.resumedFromPhase ?? 0}|${name}|${bossUnits.length}`
      : '';
    this.stage.classList.toggle('boss-fight', !!boss);
    if (key === this.bossStructureKey) return;
    this.bossStructureKey = key;
    this.bossHpShown = -1;
    this.bossTextKey = '';
    if (!boss) {
      this.bossBar.style.display = 'none';
      this.centresDirty = true;
      return;
    }
    this.bossBar.style.display = '';
    const d = this.lastState?.dungeon;
    const battleId = this.playback.battleId;
    if (d && battleId !== null && !this.bossStarts.some(s => s.battleId === battleId)) {
      this.rememberBossStart(battleId, bossRunKey(d), d.wipes ?? 0);
    }
    const tier = bossUnits.find(s => isBossOrRaid(s.tier))?.tier;
    if (tier) this.bossBar.dataset.tier = tier;
    else delete this.bossBar.dataset.tier;
    const label = bossUnits.length > 1 ? `${name} +${bossUnits.length - 1}` : name;
    this.bossName.textContent = label;
    this.bossName.title = label;
    const resumedAt = (boss.resumedFromPhase ?? 0) > 0 ? boss.thresholds[(boss.resumedFromPhase ?? 0) - 1] : undefined;
    this.bossTrack.style.setProperty('--skipped', resumedAt !== undefined ? String(1 - resumedAt) : '0');
    setHtml(this.bossTicks, boss.thresholds
      .map((t, i) => `<i class="combat-boss-tick" style="--at:${t.toFixed(4)}" data-checkpoint="${i + 1}" title="Checkpoint ${i + 1}"><b aria-hidden="true">🚩</b></i>`)
      .join(''));
    this.centresDirty = true;
  }

  private updateBossHp(): void {
    if (!this.bossStructureKey) return;
    const frac = this.playback.bossHpFraction();
    if (frac === null) return;
    if (Math.abs(frac - this.bossHpShown) < BOSS_HP_EPSILON && (frac === 0) === (this.bossHpShown === 0)) return;
    this.bossHpShown = frac;
    this.bossTrack.style.setProperty('--boss-hp', frac.toFixed(4));
  }

  private updateBossText(): void {
    const boss = this.playback.bossPhases;
    if (!boss || !this.bossStructureKey) return;
    const frac = Math.max(0, this.bossHpShown);
    const pct = frac > 0 ? Math.max(1, Math.ceil(frac * 100)) : 0;
    const d = this.lastState?.dungeon;
    const left = d?.checkpoints?.length ? retriesLeft(d.wipes, d.maxWipes) : null;
    const enrage = enrageDisplay(this.playback.enrageSource()?.enrage, this.playback.elapsedMs);
    const enrageText = enrage ? enrageSlotText(enrage) : '';
    const key = `${pct}|${boss.phase}|${left}|${d?.maxWipes}|${enrageText}|${enrage?.state}`;
    if (key === this.bossTextKey) return;
    this.bossTextKey = key;

    this.bossPct.textContent = `${pct}%`;
    this.bossTrack.setAttribute('aria-valuenow', String(pct));
    this.bossTrack.setAttribute('aria-label', `Boss health ${pct}%, checkpoint ${boss.phase} of ${boss.thresholds.length}`);
    this.bossTicks.querySelectorAll<HTMLElement>('.combat-boss-tick').forEach((tick) => {
      tick.classList.toggle('reached', Number(tick.dataset.checkpoint) <= boss.phase);
    });

    if (left === null || !d?.maxWipes) {
      this.bossRetries.style.display = 'none';
    } else {
      this.bossRetries.style.display = '';
      setHtml(this.bossRetries, Array.from({ length: d.maxWipes }, (_, i) => `<i class="${i < left ? 'left' : 'used'}"></i>`).join(''));
      this.bossRetries.title = retriesText(left);
      this.bossRetries.setAttribute('aria-label', retriesText(left));
    }

    this.bossBar.dataset.enrage = enrage?.state === 'on' ? 'on' : enrage?.state === 'soon' ? 'soon' : 'off';
    if (!enrage) {
      this.bossEnrage.style.display = 'none';
      return;
    }
    this.bossEnrage.style.display = '';
    this.bossEnrage.dataset.state = enrage.state;
    this.bossEnrage.textContent = enrageText;
    this.bossEnrage.title = enrage.state === 'on'
      ? `Enraged: enemy damage ${formatMultiplier(enrage.multiplier)}`
      : `Enrages in ${formatClock(enrage.remainingMs)}: enemy damage rises from then on`;
  }

  private handleForecast(msg: ServerForecastMessage): void {
    if (msg.target?.kind !== 'battle') return;
    const battleId = msg.target.battleId;
    const merged = mergeLiveForecast(this.liveForecasts.get(battleId), msg);
    this.liveForecasts.delete(battleId);
    this.liveForecasts.set(battleId, merged);
    while (this.liveForecasts.size > LIVE_FORECASTS_KEPT) {
      const oldest = this.liveForecasts.keys().next().value;
      if (oldest === undefined) break;
      this.liveForecasts.delete(oldest);
    }
    if (battleId !== this.playback.battleId) return;
    this.renderForecastChip();
    if (this.forecastPopover) deferWhilePressed(this.forecastPopover, () => this.renderForecastPopoverContent());
  }

  private adoptCachedForecast(): void {
    const battleId = this.playback.battleId;
    if (battleId === null || this.liveForecasts.has(battleId)) return;
    const cached = this.gameClient.peekForecast({ kind: 'battle', battleId });
    if (cached) this.liveForecasts.set(battleId, mergeLiveForecast(undefined, cached));
  }

  /** The live forecast to show: a result (stale while a newer one is computed), 'loading', or null to hide the chip. */
  private liveForecast(): { view: ForecastResult | 'loading'; stale: boolean } | null {
    const battleId = this.playback.battleId;
    if (!this.toughFight || battleId === null) return null;
    const entry = this.liveForecasts.get(battleId);
    if (!entry) return null;
    if (entry.result) return { view: entry.result, stale: entry.pending };
    return entry.pending ? { view: 'loading', stale: false } : null;
  }

  private renderForecastChip(): void {
    deferWhilePressed(this.forecastBtn, () => this.paintForecastChip());
  }

  private paintForecastChip(): void {
    const live = this.liveForecast();
    const forecast = live?.view ?? null;
    const stale = !!live?.stale;
    const key = forecast === null ? '' : forecast === 'loading' ? 'loading' : `${forecast.key}|${forecast.winPct}|${forecast.ci.join(',')}|${forecast.sims}|${stale}`;
    if (key === this.forecastChipKey) return;
    this.forecastChipKey = key;
    if (forecast === null) {
      this.forecastBtn.style.display = 'none';
      setHtml(this.forecastBtn, '');
      this.closeForecastPopover();
      return;
    }
    this.forecastBtn.style.display = '';
    setHtml(this.forecastBtn, renderForecastRing(forecast, { kind: 'battle', compact: true, stale }));
    this.forecastBtn.dataset.state = forecast === 'loading' ? 'loading' : stale ? 'stale' : 'ready';
    this.forecastBtn.setAttribute('aria-label', forecast === 'loading'
      ? 'Estimating your chances'
      : `${this.forecastBtn.querySelector('.forecast-chip')?.getAttribute('aria-label') ?? 'Win chance'}. Show details`);
    this.forecastBtn.setAttribute('aria-expanded', String(!!this.forecastPopover));
  }

  private toggleForecastPopover(): void {
    if (this.forecastPopover) {
      this.closeForecastPopover();
      return;
    }
    const forecast = this.liveForecast()?.view;
    if (!forecast || forecast === 'loading') return;
    this.closePopover();
    const pop = document.createElement('div');
    pop.className = 'combat-forecast-popover';
    this.container.appendChild(pop);
    registerDismiss(pop, () => this.closeForecastPopover());
    this.forecastPopover = pop;
    this.renderForecastPopoverContent();
    this.forecastBtn.setAttribute('aria-expanded', 'true');
  }

  private renderForecastPopoverContent(): void {
    const pop = this.forecastPopover;
    const forecast = this.liveForecast()?.view;
    if (!pop) return;
    if (!forecast || forecast === 'loading') {
      this.closeForecastPopover();
      return;
    }
    const state = this.lastState;
    setHtml(pop, renderForecastPopover(forecast, {
      kind: 'battle',
      autoRetreat: state?.dungeon ? undefined : state?.social?.party?.autoRetreat ?? null,
      elapsedMs: this.playback.elapsedMs,
      viewerLevel: state?.character?.level,
    }));
    const host = this.container.getBoundingClientRect();
    const header = this.header.getBoundingClientRect();
    const chip = this.forecastBtn.getBoundingClientRect();
    const width = pop.offsetWidth || 280;
    const left = Math.max(8, Math.min(host.width - width - 8, chip.left - host.left + chip.width / 2 - width / 2));
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(0, header.bottom - host.top) + 6}px`;
    pop.style.setProperty('--arrow-x', `${Math.max(14, Math.min(width - 14, chip.left - host.left + chip.width / 2 - left))}px`);
  }

  private closeForecastPopover(): void {
    if (!this.forecastPopover) return;
    release(this.forecastPopover);
    this.forecastPopover.remove();
    this.forecastPopover = null;
    this.forecastBtn.setAttribute('aria-expanded', 'false');
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
    for (const key of this.targetedKeys) this.cards.get(key)?.setTargeted(false);
    this.targetedKeys.clear();
  }

  private selfUnit(): PlaybackUnit | undefined {
    return this.selfKey ? this.playback.unitByKey(this.selfKey) : undefined;
  }

  private skillCardType(skillId: string, fromSnapshot?: SkillCardType): SkillCardType {
    if (fromSnapshot) return fromSnapshot;
    const def = this.worldCache.getSkill(skillId);
    return def ? getSkillCardType(def) : 'action';
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
      const className = state?.character?.className;
      const attack = className ? classAttackSkill(className, this.worldCache.getSkillContent().skills) : undefined;
      if (attack) layout.cards.push({ id: attack.id, name: attack.name, cardType: getSkillCardType(attack) });
      if (this.playback.battleId !== null && this.playback.units.length > 0 && state?.character) layout.note = 'Joining next battle';
    }
    if (layout.cards.every(card => card.cardType === 'basic') && state?.character) {
      const slot = this.worldCache.getSlotSchedule(state.character.className).find(s => s.type === 'active');
      if (slot && state.character.level < slot.unlocksAtLevel) layout.note = `Active skill unlocks at level ${slot.unlocksAtLevel}`;
      else if (!layout.note) layout.note = 'No active skill equipped';
      layout.noteLinksToSkills = layout.note !== 'Joining next battle';
    }
    deferWhilePressed(this.skillBarRoot, () => this.skillBar.setLayout(layout));
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
        states.push({ id: s.id, state, remainingMs: s.remainingMs, cooldownMs: s.cooldownMs, castProgress, locked: unit.recoveryMs > 0 && !trigger });
      }
    }
    this.skillBar.update(states, writeText);
  }

  private skillOwnerClass(skill: SkillDefinition): string {
    return this.gameClient.lastState?.character?.className ?? skill.className;
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
    const castMs = snapStatics?.castTimeMs ?? (def?.castTime ? paceSkillSeconds(COMBAT_PACE, def, this.skillOwnerClass(def), def.castTime) * 1000 : 0);
    const timed = snapStatics?.chargeMs !== undefined
      ? { chargeMs: snapStatics.chargeMs, recoveryMs: snapStatics.recoveryMs ?? 0 }
      : def && isTimedSkill(def) ? timedSkillMs(def) : null;
    if (timed) {
      const cycleMs = live?.useCooldownMs || snapStatics?.useCooldownMs;
      const chargeMs = cycleMs ? Math.max(0, cycleMs - castMs - timed.recoveryMs) : timed.chargeMs;
      const reduced = Math.abs(chargeMs - timed.chargeMs) >= CHARGE_REDUCED_MIN_MS ? ` (base ${formatDuration(timed.chargeMs)})` : '';
      stats.push(`Charge ${formatDuration(chargeMs)}${reduced}`);
      if (!trigger) stats.push(`Recovery ${formatDuration(timed.recoveryMs)}`);
    } else if (def?.type !== 'passive') {
      const baseMs = snapStatics?.baseCooldownMs ?? (def ? guessCooldownMs(def, this.skillOwnerClass(def)) : live?.cooldownMs ?? 0);
      const effectiveMs = live?.useCooldownMs || snapStatics?.useCooldownMs || baseMs;
      const reduced = effectiveMs > 0 && effectiveMs !== baseMs ? ` (base ${formatDuration(baseMs)})` : '';
      if (effectiveMs > 0) stats.push(`Cooldown ${formatDuration(effectiveMs)}${reduced}`);
    }
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
    registerDismiss(pop, () => this.closePopover());
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
    if (this.popover) release(this.popover);
    this.popover?.remove();
    this.popover = null;
    this.popoverSkillId = '';
  }

  /** The server moves on to the next floor or room while the fight's result is still on screen; the header waits for the stage. */
  private headerSource(state: ServerStateMessage): ServerStateMessage {
    const battleId = this.playback.battleId;
    if (battleId === null || state.battle.visual === 'fighting' || this.headerLatch?.battleId !== battleId) {
      this.headerLatch = battleId === null ? null : { battleId, state };
      return state;
    }
    return this.headerLatch.state;
  }

  private updateHeader(latest: ServerStateMessage): void {
    const state = this.headerSource(latest);
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
    this.updateAutoRetreatFlag(state);
    this.lastRunKey = '';
    this.updateRunButton(state);
  }

  /** Auto-retreat only acts in the overworld, so the flag rides on Run and never on Leave. */
  private updateAutoRetreatFlag(state: ServerStateMessage): void {
    const below = state.dungeon ? 0 : state.social?.party?.autoRetreat?.belowPct ?? 0;
    for (const btn of [this.runBtn, this.dungeonLeaveBtn]) {
      const flag = btn.querySelector<HTMLElement>('.combat-auto-retreat');
      const on = btn === this.runBtn && below > 0;
      if (flag) flag.hidden = !on;
      if (on) btn.dataset.autoRetreat = String(below);
      else delete btn.dataset.autoRetreat;
    }
    this.runBtn.title = below > 0 ? `Auto-retreat is on (below ${below} %)` : '';
  }

  private updateRunButton(state: ServerStateMessage): void {
    if (state.dungeon) return;
    const role = state.social?.party?.members.find(m => m.username === state.username)?.role;
    const canRun = role === 'owner' || role === 'leader';
    const fighting = state.battle.visual === 'fighting' && this.playback.battleId !== null && !this.playback.finished;
    const elapsed = this.playback.elapsedMs;
    const available = fighting && canRun && elapsed >= RUN_AVAILABLE_MS;
    const progress = fighting && canRun ? Math.min(1, elapsed / RUN_AVAILABLE_MS) : 0;
    const below = state.social?.party?.autoRetreat?.belowPct ?? 0;
    const retreatNote = below > 0 ? `Auto-retreat is on (below ${below} %)` : '';
    const lockedHint = !canRun
      ? 'Only the party owner or a leader can run'
      : fighting ? `Run becomes available ${RUN_AVAILABLE_MS / 1000} seconds into a fight` : 'The next fight is about to start';
    const hint = [lockedHint, retreatNote].filter(Boolean).join('. ');
    const key = `${available}|${progress.toFixed(2)}|${hint}`;
    if (key === this.lastRunKey) return;
    this.lastRunKey = key;
    this.runBtn.classList.toggle('combat-run-locked', !available);
    this.runBtn.classList.toggle('ready', available);
    this.runBtn.style.setProperty('--run', progress.toFixed(2));
    this.runLabel.textContent = available ? 'Run' : '🔒 Run';
    this.runHint.textContent = hint;
  }

  /** The server's mid-attempt rule: an undecided fight that has started. */
  private fightUnderWay(): boolean {
    return this.lastState?.battle.visual === 'fighting'
      && this.playback.battleId !== null
      && !this.playback.finished
      && this.playback.elapsedMs > 0;
  }

  private confirmLeaveDungeon(message: string): void {
    this.closeLeaveConfirm();
    const overlay = document.createElement('div');
    overlay.className = 'item-popup-overlay combat-leave-confirm';
    overlay.innerHTML = `
      <div class="item-popup" role="alertdialog" aria-modal="true" aria-labelledby="combat-leave-confirm-title">
        <div class="item-popup-name" id="combat-leave-confirm-title">Leave the dungeon?</div>
        <div class="item-popup-stats">${escapeHtml(message)}</div>
        <div class="item-popup-actions">
          <button type="button" class="item-popup-btn item-popup-btn-danger combat-leave-confirm-yes">Leave</button>
          <button type="button" class="item-popup-btn item-popup-btn-secondary combat-leave-confirm-no">Stay</button>
        </div>
      </div>
    `;
    overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.combat-leave-confirm-yes')) {
        this.closeLeaveConfirm();
        this.gameClient.sendLeaveDungeon();
      } else if (target === overlay || target.closest('.combat-leave-confirm-no')) {
        this.closeLeaveConfirm();
      }
    });
    document.body.appendChild(overlay);
    bringToFront(overlay, () => this.closeLeaveConfirm());
    wireFocusOnInteract(overlay);
    this.leaveConfirm = overlay;
  }

  private closeLeaveConfirm(): void {
    if (!this.leaveConfirm) return;
    release(this.leaveConfirm);
    this.leaveConfirm.remove();
    this.leaveConfirm = null;
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
    if (state.zoneName) layers.push(placeholderUrl(state.zoneName, BACKGROUND_PLACEHOLDER));
    const layered = layers.map(u => `url('${u}')`).join(', ');
    if (this.stageBg.dataset.bgKey !== layered) {
      this.stageBg.style.backgroundImage = layered || 'none';
      this.stageBg.dataset.bgKey = layered;
    }
  }

  private showMonsterPopup(unit: PlaybackUnit, st: UnitStatics): void {
    const existing = document.querySelector('.monster-popup-overlay') as HTMLElement | null;
    if (existing) { release(existing); existing.remove(); }
    const overlay = document.createElement('div');
    overlay.className = 'monster-popup-overlay';
    const name = st.name;
    const real = artworkUrl('monster', st.id || slugify(name));
    const fallback = placeholderUrl(name, { w: 160, h: 160 });
    const desc = st.description?.trim();
    const tier = st.tier && st.tier !== 'trash' ? st.tier : undefined;
    overlay.innerHTML = `
      <div class="monster-popup"${tier ? ` data-tier="${tier}"` : ''}>
        <button class="monster-popup-close" aria-label="Close">×</button>
        <div class="monster-popup-art">
          <img src="${real}" alt="${escapeHtml(name)}"
               onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${fallback}';}else{this.style.display='none';}" />
        </div>
        <div class="monster-popup-name">${escapeHtml(name)}</div>
        ${this.monsterMetaHtml(st)}
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
    bringToFront(overlay, close);
    wireFocusOnInteract(overlay);
    this.monsterPopup = { overlay, key: unit.key, battleId: this.renderedBattleId, lastKey: '' };
    this.paintMonsterPopup(this.monsterPopup, unit);
  }

  private monsterMetaHtml(st: UnitStatics): string {
    const badge = monsterLevelBadge(st, this.lastState?.character?.level);
    const tier = st.tier && st.tier !== 'trash' ? st.tier : undefined;
    const parts: string[] = [];
    if (badge) {
      parts.push(`<span class="monster-popup-level lvl-badge" data-con="${badge.con}" aria-label="Level ${badge.level}, ${badge.label}">`
        + `<i aria-hidden="true">${escapeHtml(badge.glyph)}</i> L${badge.level}</span>`
        + `<span class="monster-popup-con" data-con="${badge.con}" aria-hidden="true">${escapeHtml(badge.label)}</span>`);
    } else {
      parts.push('<span class="monster-popup-nolevel">No level set</span>');
    }
    if (tier) parts.push(`<span class="monster-popup-tier" data-tier="${tier}">${escapeHtml(`${TIER_INFO[tier].glyph} ${TIER_INFO[tier].label}`)}</span>`);
    let html = `<div class="monster-popup-meta">${parts.join('')}</div>`;
    if (isBossOrRaid(tier)) html += '<div class="monster-popup-group">Built for a group of 3 or more</div>';
    const mastery = this.masteryEntry(st.id);
    if (mastery) html += `<div class="monster-popup-mastery"><b>Mastery</b> ${escapeHtml(masteryLine(mastery))}</div>`;
    return html;
  }

  private masteryEntry(monsterId: string | undefined): MasteryEntry | undefined {
    if (!monsterId) return undefined;
    return this.gameClient.lastBestiary?.entries.find(e => e.monsterId === monsterId)
      ?? this.lastState?.character?.mastery?.recent.find(e => e.monsterId === monsterId);
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
    if (unit) this.paintMonsterPopup(pop, unit);
  }

  private paintMonsterPopup(pop: MonsterPopupState, unit: PlaybackUnit): void {
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
    setHtml(status, pips.map(p => `<span class="combat-pip ${p.tone}">${p.icon}${p.count ? `<b>${p.count}</b>` : ''} ${escapeHtml(p.title)}</span>`).join(''));
    status.style.display = pips.length > 0 ? '' : 'none';
    const cast = root.querySelector<HTMLElement>('.monster-popup-cast')!;
    setHtml(cast, unit.cast ? `Casting <b>${escapeHtml(unit.cast.skill)}</b>` : '');
    cast.style.display = unit.cast ? '' : 'none';
  }
}

