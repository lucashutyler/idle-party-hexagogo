import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { toShopSummary } from '@idle-party-rpg/shared';
import { OFFLINE_NOTICE } from '../network/GameClient';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { Screen } from './ScreenManager';
import type { ServerForecastMessage } from '@idle-party-rpg/shared';
import { DEFAULT_COMBAT_PREFS } from '@idle-party-rpg/shared';
import { RoomView } from '../ui/RoomView';
import type { RoomForecastState } from '../ui/RoomView';
import { isForecastStale } from '../combat/ForecastFormat';
import { RoomStatusPanel } from '../ui/RoomStatusPanel';
import { actionLabel, getRoomActions, questMarks } from '../ui/RoomActions';
import type { RoomAction, RoomActionLookups } from '../ui/RoomActions';
import { ShopPopup } from '../ui/ShopPopup';
import { RoomSheet } from '../ui/RoomSheet';
import type { RoomSheetModel } from '../ui/RoomSheet';
import type { ThreeWorldMap, TileClickInfo } from '../ui/ThreeWorldMap';
import { NpcTalkPopup } from '../ui/NpcTalkPopup';
import { DungeonEntryPopup } from '../ui/DungeonEntryPopup';
import { showMapToast } from '../ui/MapToast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { escapeHtml } from '../ui/ItemIcon';
import { deferWhilePressed, setHtml } from '../ui/render';
import { discoveredRoomName } from '../ui/routeSummary';
import { runStepsWhenIdle, saveDataRequested } from '../ui/idleSteps';

const SHEET_BOTTOM_HEIGHT = 112;
const SHEET_SIDE_WIDTH = 320;
const SIDE_SHEET_MIN_WIDTH = 720;
/** Map height left over the sheet that the three round controls need. Below it only the recentre button stays. */
const CONTROLS_FULL_MIN_HEIGHT = 168;
const CONTROLS_RECENTER_MIN_HEIGHT = 56;
/** Where the current room's chips spell out what they do; narrower, a chip shows one word. */
const SPELLED_OUT_CHIPS_QUERY = '(min-width: 768px)';
const BLOCKED_ROOM_TEXT = "You can't walk there";
const CHARTING_TEXT = 'Charting the map…';
const MAP_KEY_PAN_PX = 80;
const MAP_KEY_PAN: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

export class MapScreen implements Screen {
  private container: HTMLElement;
  private gameContainer: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private map: ThreeWorldMap | null = null;
  private creatingMap = false;
  private active = false;
  private pendingFocusRoomId: string | null = null;
  private statusCard?: HTMLElement;
  private unsubscribeState?: () => void;
  private unsubscribeForecast?: () => void;
  private zoomControls?: HTMLElement;
  private recenterButton?: HTMLButtonElement;
  private routeChip?: HTMLElement;
  private roomView?: RoomView;
  private roomSheet?: RoomSheet;
  private roomStatus?: RoomStatusPanel;
  private shopPopup?: ShopPopup;
  private npcTalkPopup?: NpcTalkPopup;
  private dungeonEntryPopup?: DungeonEntryPopup;
  private onUserClickCallback?: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void;
  private shownForecastKey: string | null = null;
  private sheetMapId: string | null = null;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;

    // The existing #game-container div hosts the canvas.
    const gc = document.getElementById('game-container');
    if (!gc) throw new Error('#game-container not found in DOM');
    this.gameContainer = gc;
    gc.tabIndex = 0;
    gc.setAttribute('aria-label', 'World map. Arrow keys pan, plus and minus zoom, Home returns to your party.');
    gc.addEventListener('keydown', (e) => this.onMapKey(e));

    this.gameClient.onMoveBlocked((msg) => {
      const names = msg.missingPlayers.join(', ');
      this.showMoveToast(names ? `${msg.reason} Missing: ${names}` : msg.reason);
    });
    // While the entry popup is open it shows the refusal itself.
    this.gameClient.onServerError((message, code) => {
      if (code === 'dungeon_entry_refused' && !this.dungeonEntryPopup?.isOpen) this.showMoveToast(message);
      if (code === 'travel_refused') this.showMoveToast(message);
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.onScreenResize()).observe(this.container);
    }
    this.preloadMapCode();
  }

  private onMapKey(e: KeyboardEvent): void {
    if (!this.map || e.target !== this.gameContainer) return;
    const pan = MAP_KEY_PAN[e.key];
    if (pan) this.map.panBy(pan[0] * MAP_KEY_PAN_PX, pan[1] * MAP_KEY_PAN_PX);
    else if (e.key === '+' || e.key === '=') this.map.adjustZoom(1);
    else if (e.key === '-') this.map.adjustZoom(-1);
    else if (e.key === 'Home') this.map.recenterOnPlayer();
    else return;
    e.preventDefault();
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void): void {
    this.onUserClickCallback = cb;
  }

  /** Recenter the camera on the player's party, and resume following it. */
  recenterOnPlayer(): void {
    this.map?.recenterOnPlayer();
  }

  /** Pans to a room on the party's map and selects it. */
  focusRoom(roomId: string): void {
    if (!this.map) {
      this.pendingFocusRoomId = roomId;
      return;
    }
    const def = this.worldCache.getTileByGuid(roomId);
    if (!def) {
      this.recenterOnPlayer();
      return;
    }
    if (def.mapId !== this.worldCache.getCurrentMapId()) {
      this.showMoveToast('That room is on another map');
      return;
    }
    this.map.focusOn(def.col, def.row);
    const info = this.map.getTileInfo(def.col, def.row);
    if (info && !info.isCurrentTile) this.selectRoom(info, false);
  }

  /** Refresh the map from updated WorldCache data. */
  refreshWorld(): void {
    if (this.map) {
      this.map.rebuildFromCache();
      if (this.gameClient.lastState) {
        this.map.applyServerState(this.gameClient.lastState, true);
      }
    }
    this.updateRoomStatus(this.gameClient.lastState);
  }

  onActivate(): void {
    this.active = true;
    this.syncScreenLayout();
    if (!this.map) {
      void this.createMap();
    } else {
      this.map.resume();
      if (this.gameClient.lastState) {
        this.map.applyServerState(this.gameClient.lastState, true);
      }
      this.updateRoomStatus(this.gameClient.lastState);
      this.updateRouteChip(this.gameClient.lastState);
      this.subscribeToState();
    }
  }

  onDeactivate(): void {
    this.active = false;
    if (this.map) this.map.pause();
    this.dismissSheet();
    this.roomView?.hide();
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
  }

  private roomForecastState(tileId: string): RoomForecastState {
    const target = { kind: 'room' as const, tileId };
    const fresh = this.gameClient.requestForecast(target);
    if (fresh) return this.toRoomForecastState(fresh, false);
    const previous = this.gameClient.peekForecast(target);
    return previous?.result ? this.toRoomForecastState(previous, true) : 'loading';
  }

  /** Re-asks for the open room's forecast once the party's forecast inputs change (gear, formation, members). */
  private refreshOpenRoomForecast(): void {
    const forecastKey = this.gameClient.lastState?.social?.party?.forecastKey ?? null;
    if (forecastKey === this.shownForecastKey) return;
    this.shownForecastKey = forecastKey;
    const tileId = this.roomView?.visibleForecastTileId;
    if (tileId) this.roomView!.updateForecast(tileId, this.roomForecastState(tileId));
    const sheetTileId = this.roomSheet?.visibleForecastTileId;
    if (sheetTileId) this.roomSheet!.updateForecast(sheetTileId, this.roomForecastState(sheetTileId));
  }

  private toRoomForecastState(msg: ServerForecastMessage, forceStale: boolean): RoomForecastState {
    if (msg.status === 'pending') return 'loading';
    if (msg.status === 'unavailable') {
      const previous = this.gameClient.peekForecast(msg.target);
      return previous ? this.toRoomForecastState(previous, true) : null;
    }
    if (msg.status !== 'ok' || !msg.result) return null;
    const state = this.gameClient.lastState;
    const party = state?.social?.party;
    return {
      result: msg.result,
      stale: forceStale || isForecastStale(msg.result, party?.forecastKey),
      autoRetreat: party?.autoRetreat
        ?? state?.character?.combatPrefs?.autoRetreatBelowPct
        ?? DEFAULT_COMBAT_PREFS.autoRetreatBelowPct,
      viewerLevel: state?.character?.level,
    };
  }

  private canMove(): boolean {
    const state = this.gameClient.lastState;
    if (!state?.social?.party) return true;
    const me = state.social.party.members.find(m => m.username === state.username);
    if (!me) return true;
    return me.role === 'owner' || me.role === 'leader';
  }

  /** Returns whether the order went out. */
  private tryMove(col: number, row: number): boolean {
    if (this.gameClient.lastState?.dungeon) {
      this.showMoveToast('Leave the dungeon before traveling');
      return false;
    }
    if (!this.canMove()) {
      this.showMoveToast('Only the party owner or a leader can move');
      return false;
    }
    if (!this.gameClient.sendMove(col, row)) {
      this.showMoveToast(OFFLINE_NOTICE);
      return false;
    }
    return true;
  }

  private showMoveToast(message: string): void {
    showMapToast(this.container, message);
  }

  /** The first tap on Map shouldn't also pay for fetching and parsing three.js. */
  private preloadMapCode(): void {
    if (saveDataRequested() || typeof window.requestIdleCallback !== 'function') return;
    runStepsWhenIdle([() => { void import('../ui/ThreeWorldMap').catch(() => {}); }]);
  }

  private async createMap(): Promise<void> {
    if (this.creatingMap || this.map) return;
    this.creatingMap = true;
    this.showStatusCard(CHARTING_TEXT);
    try {
      if (!this.worldCache.isLoaded) {
        await this.worldCache.loadWorld().catch(err => {
          console.warn('[MapScreen] Failed to load world data:', err);
        });
      }
      const { ThreeWorldMap } = await import('../ui/ThreeWorldMap');
      this.map = new ThreeWorldMap(this.gameContainer, this.worldCache);
    } catch (err) {
      console.warn('[MapScreen] Could not start the map:', err);
      this.gameContainer.replaceChildren();
      this.showStatusCard("The map couldn't start on this device.", () => { void this.createMap(); });
      return;
    } finally {
      this.creatingMap = false;
    }
    this.hideStatusCard();
    this.wireMap(this.map);

    if (!this.active) {
      this.map.pause();
      return;
    }
    this.map.resume();
    if (this.gameClient.lastState) this.map.applyServerState(this.gameClient.lastState, true);
    this.updateRoomStatus(this.gameClient.lastState);
    this.updateRouteChip(this.gameClient.lastState);
    this.subscribeToState();
    if (this.pendingFocusRoomId) {
      const roomId = this.pendingFocusRoomId;
      this.pendingFocusRoomId = null;
      this.focusRoom(roomId);
    }
  }

  private wireMap(map: ThreeWorldMap): void {
    map.setSendMove((col, row) => { this.tryMove(col, row); });
    map.setOnTileClick((info) => { this.onRoomTap(info); });
    map.setOnBackgroundClick((blocked) => {
      this.dismissSheet();
      if (blocked) this.showMoveToast(BLOCKED_ROOM_TEXT);
    });

    this.shopPopup = new ShopPopup(this.gameClient, this.worldCache);
    this.npcTalkPopup = new NpcTalkPopup(this.gameClient);
    this.dungeonEntryPopup = new DungeonEntryPopup(this.gameClient);
    this.roomView = new RoomView(
      this.container,
      (col, row) => { if (this.tryMove(col, row)) this.dismissSheet(); },
      (username, anchor, tileCol, tileRow) => { this.onUserClickCallback?.(username, anchor, tileCol, tileRow); },
      (action) => { this.runAction(action); },
      (tileId) => this.roomForecastState(tileId),
    );
    this.roomSheet = new RoomSheet(
      this.container,
      {
        onGo: (info) => { this.goToRoom(info); },
        onDetails: (info) => { this.showRoom(info); },
        onUserClick: (username, anchor, col, row) => { this.onUserClickCallback?.(username, anchor, col, row); },
        onDismiss: () => { this.dismissSheet(); },
      },
      (tileId) => this.roomForecastState(tileId),
    );
    this.unsubscribeForecast?.();
    this.unsubscribeForecast = this.gameClient.onForecast((msg) => {
      if (msg.target.kind !== 'room' || msg.status === 'pending') return;
      const state = this.toRoomForecastState(msg, false);
      this.roomView?.updateForecast(msg.target.tileId, state);
      this.roomSheet?.updateForecast(msg.target.tileId, state);
    });
    this.roomStatus = new RoomStatusPanel(
      this.container,
      (action) => { this.runStatusChip(action); },
      () => { this.openCurrentRoom(); },
    );
    this.createRouteChip();
    this.createZoomControls();
    map.setOnFollowChange((following) => {
      if (this.recenterButton) this.recenterButton.dataset.lit = following ? '0' : '1';
    });
  }

  private onRoomTap(info: TileClickInfo): void {
    if (info.isCurrentTile) {
      this.dismissSheet();
      this.showRoom(info);
    } else if (this.roomSheet?.isShowing(info.col, info.row)) {
      this.goToRoom(info);
    } else {
      this.selectRoom(info, true);
    }
  }

  private selectRoom(info: TileClickInfo, reveal: boolean): void {
    this.shownForecastKey = this.gameClient.lastState?.social?.party?.forecastKey ?? null;
    this.roomSheet?.show(this.sheetModel(info));
    this.map?.setSelectedRoom({ col: info.col, row: info.row });
    this.sheetMapId = this.gameClient.lastState?.currentMapId ?? null;
    this.syncScreenLayout();
    if (reveal) this.map?.revealRoom(info.col, info.row, this.sheetInsets());
  }

  /** Follows the map's own width rather than the viewport's, because the chat column can take half of it. */
  private sheetLayout(): 'side' | 'bottom' {
    return this.container.clientWidth >= SIDE_SHEET_MIN_WIDTH ? 'side' : 'bottom';
  }

  /** The sheet's layout and what fits around it depend on the map's size, which chat and rotation change without a state push. */
  private syncScreenLayout(): void {
    const open = !!this.roomSheet?.isOpen;
    const layout = this.sheetLayout();
    if (open) this.container.dataset.sheet = layout;
    else delete this.container.dataset.sheet;
    const free = this.container.clientHeight - (open && layout === 'bottom' ? SHEET_BOTTOM_HEIGHT : 0);
    this.container.dataset.controls = free >= CONTROLS_FULL_MIN_HEIGHT ? 'full' : free >= CONTROLS_RECENTER_MIN_HEIGHT ? 'some' : 'none';
  }

  private onScreenResize(): void {
    if (this.container.clientWidth <= 0 || this.container.clientHeight <= 0) return;
    this.syncScreenLayout();
    const col = this.roomSheet?.selectedCol ?? null;
    const row = this.roomSheet?.selectedRow ?? null;
    if (col !== null && row !== null) this.map?.revealRoom(col, row, this.sheetInsets());
  }

  private sheetInsets(): { right: number; bottom: number } {
    return this.sheetLayout() === 'side'
      ? { right: SHEET_SIDE_WIDTH, bottom: 0 }
      : { right: 0, bottom: SHEET_BOTTOM_HEIGHT };
  }

  private goToRoom(info: TileClickInfo): void {
    if (this.tryMove(info.col, info.row)) this.dismissSheet();
  }

  private dismissSheet(): void {
    this.roomSheet?.hide();
    this.map?.setSelectedRoom(null);
    this.syncScreenLayout();
  }

  private sheetModel(info: TileClickInfo): RoomSheetModel {
    const state = this.gameClient.lastState;
    const tileDef = this.worldCache.getTile(info.col, info.row);
    return {
      info,
      actions: info.isUnlocked && tileDef ? getRoomActions(tileDef, this.worldCache, questMarks(state)) : [],
      othersHere: this.map?.countOthersAt(info.col, info.row) ?? 0,
      roomId: tileDef?.id ?? null,
      typeId: tileDef?.type ?? null,
      forecastTileId: tileDef?.id && info.isUnlocked && info.isTraversable ? tileDef.id : null,
      inDungeon: !!state?.dungeon,
      paysNoXp: !!tileDef?.noXp,
    };
  }

  private refreshSheet(): void {
    if (!this.roomSheet?.isOpen || !this.map) return;
    const col = this.roomSheet.selectedCol;
    const row = this.roomSheet.selectedRow;
    const info = col === null || row === null ? null : this.map.getTileInfo(col, row);
    const mapChanged = this.gameClient.lastState?.currentMapId !== this.sheetMapId;
    if (!info || info.isCurrentTile || mapChanged) {
      this.dismissSheet();
      return;
    }
    this.roomSheet.update(this.sheetModel(info));
  }

  private showStatusCard(message: string, onRetry?: () => void): void {
    if (!this.statusCard) {
      this.statusCard = document.createElement('div');
      this.statusCard.className = 'map-status-card';
      this.container.appendChild(this.statusCard);
    }
    this.statusCard.hidden = false;
    this.statusCard.dataset.kind = onRetry ? 'error' : 'loading';
    this.statusCard.innerHTML = `<div class="map-status-text">${escapeHtml(message)}</div>`
      + (onRetry ? '<button type="button" class="map-status-retry">Try again</button>' : '');
    this.statusCard.querySelector('.map-status-retry')?.addEventListener('click', onRetry ?? (() => {}));
  }

  private hideStatusCard(): void {
    if (this.statusCard) this.statusCard.hidden = true;
  }

  private showRoom(info: TileClickInfo): void {
    if (!this.roomView) return;
    const state = this.gameClient.lastState;
    const tileDef = this.worldCache.getTile(info.col, info.row);
    this.roomView.roomId = tileDef?.id ?? null;
    this.roomView.isTraveling = (state?.party.path?.length ?? 0) > 0;
    if (info.isCurrentTile) {
      this.roomView.actions = state ? this.currentRoomActions(state) : [];
    } else {
      this.roomView.actions = info.isUnlocked && tileDef
        ? getRoomActions(tileDef, this.worldCache, questMarks(state))
        : [];
    }
    const explored = info.isCurrentTile || info.isUnlocked;
    this.roomView.forecastTileId = (tileDef?.id && explored && info.isTraversable && !(info.isCurrentTile && state?.dungeon))
      ? tileDef.id
      : null;
    this.shownForecastKey = state?.social?.party?.forecastKey ?? null;
    this.roomView.show(info);
  }

  private openCurrentRoom(): void {
    const state = this.gameClient.lastState;
    const info = state ? this.map?.getTileInfo(state.party.col, state.party.row) : null;
    if (info) this.showRoom(info);
  }

  /** Actions the party can take where it stands: the shop needs its live stock, and a dungeon run locks travel. */
  private currentRoomActions(state: ServerStateMessage): RoomAction[] {
    const tile = this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row);
    if (!tile) return [];
    const shop = state.shopDefinition ? toShopSummary(state.shopDefinition) : undefined;
    const lookups: RoomActionLookups = {
      getNpc: id => this.worldCache.getNpc(id),
      getShop: () => shop,
      getDungeon: id => this.worldCache.getDungeon(id),
      getTileByGuid: id => this.worldCache.getTileByGuid(id),
      getMaps: () => this.worldCache.getMaps(),
    };
    const room = state.dungeon ? { npcId: tile.npcId, shopId: shop?.id } : { ...tile, shopId: shop?.id };
    return getRoomActions(room, lookups, questMarks(state));
  }

  /** A round chip shows one word, so a tap that takes the party off this map says where first. */
  private runStatusChip(action: RoomAction): void {
    if (action.kind === 'travel' && !window.matchMedia?.(SPELLED_OUT_CHIPS_QUERY).matches) {
      void this.confirmTravel(action);
    } else {
      this.runAction(action);
    }
  }

  private async confirmTravel(action: RoomAction): Promise<void> {
    const go = await confirmDialog({
      title: `${actionLabel(action)}?`,
      body: 'Your party will go there right away.',
      confirmLabel: 'Travel',
    });
    if (go) this.runAction(action);
  }

  private runAction(action: RoomAction): void {
    switch (action.kind) {
      case 'npc': this.talkTo(action.targetId); break;
      case 'shop': this.openShop(); break;
      case 'dungeon': this.enterDungeon(action.targetId); break;
      case 'travel': this.enterTransition(action.targetId); break;
    }
  }

  private talkTo(npcId: string): void {
    const npc = this.worldCache.getNpc(npcId);
    if (npc) this.npcTalkPopup?.show(npc);
  }

  private openShop(): void {
    const state = this.gameClient.lastState;
    if (state?.shopDefinition) this.shopPopup?.show(state);
  }

  private enterDungeon(dungeonId: string): void {
    const state = this.gameClient.lastState;
    const dungeon = this.worldCache.getDungeon(dungeonId);
    if (!state || !dungeon) return;
    if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
    this.dungeonEntryPopup?.show(dungeon, state.party.col, state.party.row, { canEnter: this.canMove() });
  }

  private enterTransition(tileId: string): void {
    const state = this.gameClient.lastState;
    if (!state) return;
    if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
    if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can travel'); return; }
    if (!this.gameClient.sendEnterTransition(tileId)) this.showMoveToast(OFFLINE_NOTICE);
  }

  private updateRoomStatus(state: ServerStateMessage | null): void {
    if (!this.roomStatus) return;
    const tile = state?.character
      ? this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row)
      : undefined;
    if (!state || !tile) {
      this.roomStatus.update(null);
      return;
    }
    const run = state.dungeon;
    this.roomStatus.update({
      zoneName: tile.zoneName ?? state.zoneName,
      roomName: tile.name || 'Unnamed Room',
      actions: this.currentRoomActions(state),
      othersHere: this.map?.countOthersAt(state.party.col, state.party.row) ?? 0,
      dungeonRun: run && { name: run.name, floor: run.floor, totalFloors: run.totalFloors },
    });
  }

  private createRouteChip(): void {
    if (this.routeChip) return;
    this.routeChip = document.createElement('div');
    this.routeChip.className = 'map-route-chip';
    this.routeChip.hidden = true;
    const stop = (e: Event) => { e.stopPropagation(); };
    for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart'] as const) {
      this.routeChip.addEventListener(ev, stop);
    }
    this.routeChip.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.map-route-stop')) return;
      const party = this.gameClient.lastState?.party;
      if (party) this.tryMove(party.col, party.row);
    });
    this.container.appendChild(this.routeChip);
  }

  private updateRouteChip(state: ServerStateMessage | null): void {
    const chip = this.routeChip;
    if (!chip) return;
    const path = state?.party.path ?? [];
    if (!state || path.length === 0 || state.dungeon) {
      chip.hidden = true;
      return;
    }
    const last = path[path.length - 1];
    const name = discoveredRoomName(state, this.worldCache, last.col, last.row);
    const nameHtml = name ? `<span class="map-route-name">${escapeHtml(name)}</span><span class="map-route-dot">·</span>` : '';
    const count = `${path.length} ${path.length === 1 ? 'room' : 'rooms'}`;
    chip.hidden = false;
    deferWhilePressed(chip, () => {
      setHtml(chip, `<span class="map-route-text"><span class="map-route-arrow">→</span>${nameHtml}<span class="map-route-count">${count}</span></span>`
        + '<button type="button" class="map-route-stop">Stop</button>');
    });
  }

  private createZoomControls(): void {
    if (this.zoomControls) return;

    this.zoomControls = document.createElement('div');
    this.zoomControls.className = 'map-zoom-controls';
    this.zoomControls.innerHTML = `
      <button type="button" class="map-zoom-btn map-recenter" aria-label="Recenter on your party" title="Recenter on your party" data-lit="0">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>
          <path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2"/>
        </svg>
      </button>
      <button type="button" class="map-zoom-btn map-zoom-in" aria-label="Zoom in">+</button>
      <button type="button" class="map-zoom-btn map-zoom-out" aria-label="Zoom out">&minus;</button>
    `;
    this.container.appendChild(this.zoomControls);
    this.recenterButton = this.zoomControls.querySelector<HTMLButtonElement>('.map-recenter')!;

    this.recenterButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.map?.recenterOnPlayer();
    });

    this.zoomControls.querySelector('.map-zoom-in')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.map?.adjustZoom(0.2);
    });

    this.zoomControls.querySelector('.map-zoom-out')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.map?.adjustZoom(-0.2);
    });
  }

  private subscribeToState(): void {
    this.unsubscribeState?.();
    if (!this.map) return;

    this.unsubscribeState = this.gameClient.subscribe((state) => {
      if (this.map) {
        const snap = this.gameClient.isInitialState;
        this.map.applyServerState(state, snap);
      }
      this.refreshOpenRoomForecast();
      this.updateRoomStatus(state);
      this.updateRouteChip(state);
      this.refreshSheet();
    });
    this.refreshOpenRoomForecast();
  }
}
