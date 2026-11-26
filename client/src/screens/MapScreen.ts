import type { MapTransitionLink, ServerRouteConfirmMessage, ServerStateMessage, WorldTileDefinition } from '@idle-party-rpg/shared';
import { cubeToPixel, offsetToCube, toShopSummary } from '@idle-party-rpg/shared';
import { OFFLINE_NOTICE } from '../network/GameClient';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { Screen } from './ScreenManager';
import type { ServerForecastMessage } from '@idle-party-rpg/shared';
import { DEFAULT_COMBAT_PREFS } from '@idle-party-rpg/shared';
import { RoomView } from '../ui/RoomView';
import { autoRunTitle } from '../ui/autoRunText';
import { AUTO_RUN_FILL_HTML, AutoRunFill } from '../ui/AutoRunFill';
import type { RoomForecastState } from '../ui/RoomView';
import { isForecastStale } from '../combat/ForecastFormat';
import { RoomStatusPanel } from '../ui/RoomStatusPanel';
import { actionLabel, getRoomActions, lockTravel, questMarks } from '../ui/RoomActions';
import type { RoomAction, RoomActionLookups, RoomContents } from '../ui/RoomActions';
import { previewRoomLock, previewTravelLock, roomLockLines, roomRequirements } from '../ui/RoomEntryCheck';
import { ShopPopup } from '../ui/ShopPopup';
import { RoomSheet } from '../ui/RoomSheet';
import type { RoomSheetModel } from '../ui/RoomSheet';
import type { ThreeWorldMap, TileClickInfo } from '../ui/ThreeWorldMap';
import { NpcTalkPopup } from '../ui/NpcTalkPopup';
import { DungeonEntryPopup } from '../ui/DungeonEntryPopup';
import type { MapList } from '../ui/MapList';
import { showMapToast } from '../ui/MapToast';
import { confirmDialog } from '../ui/ConfirmDialog';
import { escapeHtml } from '../ui/ItemIcon';
import { registerDismiss, release } from '../ui/ModalStack';
import { deferWhilePressed, setHtml } from '../ui/render';
import { previewRoute, routePreviewLines, routeUnknown } from '../ui/routePreview';
import type { RoutePreview } from '../ui/routePreview';
import { destinationName, isTravelling, routeCountText } from '../ui/routeSummary';
import { doorHiresText, routeConfirmBody } from '../ui/travelWarnings';
import { runStepsWhenIdle, saveDataRequested } from '../ui/idleSteps';

const SHEET_BOTTOM_HEIGHT = 112;
const SHEET_SIDE_WIDTH = 320;
const SIDE_SHEET_MIN_WIDTH = 720;
/** Map height left over the sheet that the four round controls need. Below it only the recentre button stays. */
const CONTROLS_FULL_MIN_HEIGHT = 218;
const CONTROLS_RECENTER_MIN_HEIGHT = 56;
/** Where the current room's chips spell out what they do; narrower, a chip shows one word. */
const SPELLED_OUT_CHIPS_QUERY = '(min-width: 768px)';
const BLOCKED_ROOM_TEXT = "You can't walk there";
const CHARTING_TEXT = 'Charting the map…';
const UNVISITED_MAP_TEXT = "You haven't visited that map yet.";
const OWN_TRAVEL_FOLLOW_MS = 5000;
const MAP_KEY_PAN_PX = 80;
const MAP_KEY_PAN: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
const MAPS_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round">'
  + '<path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20z"/><path d="M9 4v13.5M15 6.5V20"/></svg>';

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
  private viewBanner?: HTMLElement;
  private mapList?: MapList;
  private readonly autoRunFill = new AutoRunFill();
  private roomView?: RoomView;
  private roomSheet?: RoomSheet;
  private roomStatus?: RoomStatusPanel;
  private shopPopup?: ShopPopup;
  private npcTalkPopup?: NpcTalkPopup;
  private dungeonEntryPopup?: DungeonEntryPopup;
  private onUserClickCallback?: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void;
  private shownForecastKey: string | null = null;
  private sheetMapId: string | null = null;
  /** A map the player is looking at instead of the party's. See docs/architecture/client.md → Multi-map travel. */
  private viewedMapId: string | null = null;
  /** The party's map at the last push this screen saw; null right after it was hidden. */
  private partyMapId: string | null = null;
  /** Until then the next map change is the player's own trip through a door, which the camera follows. */
  private followCrossingUntil = 0;
  private confirmingRoute = false;

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
    this.gameClient.onRouteConfirm((msg) => { void this.confirmRoute(msg); });
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
    else if (e.key === 'Home') this.recenterOnPlayer();
    else return;
    e.preventDefault();
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void): void {
    this.onUserClickCallback = cb;
  }

  /** Back to the party's map if another is on screen, then centre on the party and follow it. */
  recenterOnPlayer(): void {
    this.endView();
    this.map?.recenterOnPlayer();
  }

  /** Pans to a room and selects it, opening its map when it is another one the player has visited. */
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
    const state = this.gameClient.lastState;
    if (def.mapId === (state?.currentMapId ?? this.map.drawnMapId)) {
      this.endView();
    } else if (state && this.isViewable(def.mapId, state)) {
      this.viewMap(def.mapId, def.id);
    } else {
      this.showMoveToast(UNVISITED_MAP_TEXT);
      return;
    }
    this.map.focusOn(def.col, def.row);
    const info = this.map.getTileInfo(def.col, def.row);
    if (info && !info.isCurrentTile) this.selectRoom(info, false);
  }

  /** Refresh the map from updated WorldCache data. A view of a map that no longer exists ends. */
  refreshWorld(): void {
    const state = this.gameClient.lastState;
    if (this.map) {
      const viewGone = !!this.viewedMapId && !this.mapExists(this.viewedMapId);
      if (viewGone) this.stopViewing();
      else this.map.rebuildFromCache();
      if (state) this.map.applyServerState(state, true);
      else if (viewGone) this.map.rebuildFromCache();
    }
    this.updateRoomStatus(state);
  }

  onActivate(): void {
    this.active = true;
    this.syncScreenLayout();
    if (!this.map) {
      void this.createMap();
    } else {
      this.map.resume();
      const state = this.gameClient.lastState;
      if (state) {
        this.partyMapId = null;
        this.syncView(state);
        this.map.applyServerState(state, true);
      }
      if (this.viewBanner && !this.viewBanner.hidden) registerDismiss(this.viewBanner, () => this.backFromView());
      this.updateRoomStatus(state);
      this.updateRouteChip(state);
      this.subscribeToState();
      this.applyPendingFocus();
    }
  }

  /** The view stays, so coming back costs no bake. */
  onDeactivate(): void {
    this.active = false;
    if (this.map) this.map.pause();
    this.dismissSheet();
    this.roomView?.hide();
    this.mapList?.close();
    if (this.viewBanner) release(this.viewBanner);
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

  /** Returns whether the order went out. Coordinates ride along only on the party's map, for older servers. */
  private tryMoveTo(info: TileClickInfo): boolean {
    const tileId = info.tileId;
    if (!tileId) {
      this.showMoveToast(BLOCKED_ROOM_TEXT);
      return false;
    }
    return this.sendOrder(() => this.gameClient.sendMoveTo(tileId, this.coordsOnPartyMap(info.mapId, info)));
  }

  private coordsOnPartyMap(mapId: string, room: { col: number; row: number }): { col: number; row: number } | undefined {
    return mapId === this.gameClient.lastState?.currentMapId ? { col: room.col, row: room.row } : undefined;
  }

  /** The server asks before a route that leaves hires behind or has no known way back; Go resends it accepted. */
  private async confirmRoute(msg: ServerRouteConfirmMessage): Promise<void> {
    if (this.confirmingRoute) return;
    this.confirmingRoute = true;
    try {
      const go = await confirmDialog({ title: 'Set off?', body: routeConfirmBody(msg.warnings), confirmLabel: 'Go' });
      if (!go) return;
      const def = this.worldCache.getTileByGuid(msg.tileId);
      const coords = def ? this.coordsOnPartyMap(def.mapId, def) : undefined;
      this.sendOrder(() => this.gameClient.sendMoveTo(msg.tileId, coords, msg.warnings.map(w => w.kind)));
    } finally {
      this.confirmingRoute = false;
    }
  }

  private stopTravel(): void {
    this.sendOrder(() => this.gameClient.sendStopTravel());
  }

  private sendOrder(send: () => boolean): boolean {
    if (this.gameClient.lastState?.dungeon) {
      this.showMoveToast('Leave the dungeon before traveling');
      return false;
    }
    if (!this.canMove()) {
      this.showMoveToast('Only the party owner or a leader can move');
      return false;
    }
    if (!send()) {
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
    runStepsWhenIdle([() => { void Promise.all([import('../ui/ThreeWorldMap'), import('../ui/MapList')]).catch(() => {}); }]);
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
    const state = this.gameClient.lastState;
    if (state) {
      this.viewPendingFocusMap(state);
      this.map.applyServerState(state, true);
      this.partyMapId = state.currentMapId;
    }
    this.updateRoomStatus(state);
    this.updateRouteChip(state);
    this.subscribeToState();
    this.applyPendingFocus();
  }

  /** A room to focus on another map: draw that map from the first state, so the map bakes once. */
  private viewPendingFocusMap(state: ServerStateMessage): void {
    const def = this.pendingFocusRoomId ? this.worldCache.getTileByGuid(this.pendingFocusRoomId) : undefined;
    if (!def || def.mapId === state.currentMapId || !this.isViewable(def.mapId, state)) return;
    this.viewedMapId = def.mapId;
    this.map?.setViewedMap(def.mapId);
  }

  private applyPendingFocus(): void {
    const roomId = this.pendingFocusRoomId;
    if (!roomId) return;
    this.pendingFocusRoomId = null;
    this.focusRoom(roomId);
  }

  private wireMap(map: ThreeWorldMap): void {
    map.setOnTileClick((info) => { this.onRoomTap(info); });
    map.setLockCheck({
      room: (tile, state) => previewRoomLock(tile.entryRequirements, state) !== null,
      travel: (link, state) => this.travelLocked(link, state),
    });
    map.setOnBackgroundClick((blocked) => {
      this.dismissSheet();
      if (blocked) this.showMoveToast(BLOCKED_ROOM_TEXT);
    });

    this.shopPopup = new ShopPopup(this.gameClient, this.worldCache);
    this.npcTalkPopup = new NpcTalkPopup(this.gameClient);
    this.dungeonEntryPopup = new DungeonEntryPopup(this.gameClient);
    this.roomView = new RoomView(
      this.container,
      (info) => { if (this.tryMoveTo(info)) this.dismissSheet(); },
      (username, anchor, tileCol, tileRow) => { this.onUserClickCallback?.(username, anchor, tileCol, tileRow); },
      (action) => { this.runAction(action); },
      (tileId) => this.roomForecastState(tileId),
    );
    this.roomView.onStop = () => this.stopTravel();
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
    } else if (this.roomSheet?.isShowing(info.mapId, info.col, info.row)) {
      this.goToRoom(info);
    } else {
      this.selectRoom(info, true);
    }
  }

  private selectRoom(info: TileClickInfo, reveal: boolean): void {
    this.shownForecastKey = this.gameClient.lastState?.social?.party?.forecastKey ?? null;
    this.roomSheet?.show(this.sheetModel(info));
    this.map?.setSelectedRoom({ col: info.col, row: info.row });
    this.sheetMapId = info.mapId;
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
    if (this.roomSheet?.isShowing(info.mapId, info.col, info.row) && this.roomSheet.isBlocked) {
      this.roomSheet.pulseLock();
      return;
    }
    if (this.tryMoveTo(info)) this.dismissSheet();
  }

  private dismissSheet(): void {
    this.roomSheet?.hide();
    this.map?.setSelectedRoom(null);
    this.syncScreenLayout();
  }

  private sheetModel(info: TileClickInfo): RoomSheetModel {
    const state = this.gameClient.lastState;
    const tileDef = this.worldCache.getTileOn(info.mapId, info.col, info.row);
    const route = this.routeTo(tileDef, state);
    return {
      info,
      actions: info.isUnlocked && tileDef ? this.remoteRoomActions(tileDef, state) : [],
      othersHere: this.map?.countOthersAt(info.col, info.row) ?? 0,
      roomId: tileDef?.id ?? null,
      typeId: tileDef?.type ?? null,
      forecastTileId: this.remoteForecastTileId(info, tileDef, state),
      inDungeon: !!state?.dungeon,
      paysNoXp: !!tileDef?.noXp,
      lock: this.roomLock(tileDef, state),
      route,
      routeLines: routePreviewLines(route, state),
      partyHasOthers: this.partyHasOthers(state),
    };
  }

  /** The server denies forecasts off the party's map, so none is asked for. */
  private remoteForecastTileId(info: TileClickInfo, tileDef: WorldTileDefinition | undefined, state: ServerStateMessage | null): string | null {
    if (!tileDef?.id || !info.isUnlocked || !info.isTraversable) return null;
    return info.mapId === state?.currentMapId ? tileDef.id : null;
  }

  private routeTo(tileDef: WorldTileDefinition | undefined, state: ServerStateMessage | null): RoutePreview | null {
    return tileDef && state ? previewRoute(state, this.worldCache, tileDef.id) : null;
  }

  private partyHasOthers(state: ServerStateMessage | null): boolean {
    return (state?.social?.party?.members ?? []).some(m => m.username !== state?.username);
  }

  private roomLock(tileDef: WorldTileDefinition | undefined, state: ServerStateMessage | null): string[] | null {
    const failures = tileDef ? previewRoomLock(roomRequirements(tileDef, this.worldCache), state) : null;
    return failures ? roomLockLines(failures, state) : null;
  }

  private remoteRoomActions(tileDef: WorldTileDefinition, state: ServerStateMessage | null): RoomAction[] {
    return this.withTravelLocks(getRoomActions(tileDef, this.worldCache, questMarks(state)), tileDef, state);
  }

  private withTravelLocks(actions: RoomAction[], room: RoomContents, state: ServerStateMessage | null): RoomAction[] {
    return lockTravel(actions, room, link => this.travelLocked(link, state));
  }

  private travelLocked(link: MapTransitionLink, state: ServerStateMessage | null): boolean {
    return previewTravelLock(link, this.worldCache.getTileByGuid(link.tileId), this.worldCache, state) !== null;
  }

  /** A sheet belongs to the map it was opened on, and closes once another is drawn. */
  private refreshSheet(): void {
    if (!this.roomSheet?.isOpen || !this.map) return;
    const col = this.roomSheet.selectedCol;
    const row = this.roomSheet.selectedRow;
    const info = col === null || row === null ? null : this.map.getTileInfo(col, row);
    if (!info || info.isCurrentTile || this.map.drawnMapId !== this.sheetMapId) {
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
    const tileDef = this.worldCache.getTileOn(info.mapId, info.col, info.row);
    this.roomView.roomId = tileDef?.id ?? null;
    this.roomView.isTraveling = !!state && isTravelling(state.party);
    if (info.isCurrentTile) {
      this.roomView.actions = state ? this.currentRoomActions(state) : [];
      this.roomView.blockedLines = [];
      this.roomView.forecastTileId = tileDef?.id && info.isTraversable && !state?.dungeon ? tileDef.id : null;
    } else {
      const route = this.routeTo(tileDef, state);
      const routeBlocks = routeUnknown(route) && !this.partyHasOthers(state);
      this.roomView.actions = info.isUnlocked && tileDef ? this.remoteRoomActions(tileDef, state) : [];
      this.roomView.blockedLines = [
        ...(this.roomLock(tileDef, state) ?? []),
        ...(routeBlocks ? routePreviewLines(route, state) : []),
      ];
      this.roomView.forecastTileId = this.remoteForecastTileId(info, tileDef, state);
    }
    this.shownForecastKey = state?.social?.party?.forecastKey ?? null;
    this.roomView.show(info);
  }

  private openCurrentRoom(): void {
    this.endView();
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
    return this.withTravelLocks(getRoomActions(room, lookups, questMarks(state)), room, state);
  }

  /** A round chip shows one word, so a tap that takes the party off this map says where first; a locked exit lets the server say why instead. */
  private runStatusChip(action: RoomAction): void {
    if (action.kind !== 'travel') {
      this.runAction(action);
      return;
    }
    const oneWord = !action.locked && !window.matchMedia?.(SPELLED_OUT_CHIPS_QUERY).matches;
    void this.travelThrough(action, oneWord);
  }

  private runAction(action: RoomAction): void {
    switch (action.kind) {
      case 'npc': this.talkTo(action.targetId); break;
      case 'shop': this.openShop(); break;
      case 'dungeon': this.enterDungeon(action.targetId); break;
      case 'travel': void this.travelThrough(action, false); break;
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

  /** Every way through a door asks first when the party's hires would stay behind on this map. */
  private async travelThrough(action: RoomAction, askFirst: boolean): Promise<void> {
    const state = this.gameClient.lastState;
    if (!state) return;
    if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
    if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can travel'); return; }
    const hires = doorHiresText(state, this.worldCache.getMaps(), this.exitMapId(state, action.targetId));
    if (hires || askFirst) {
      const go = await confirmDialog({
        title: `${actionLabel(action)}?`,
        body: hires ?? 'Your party will go there right away.',
        confirmLabel: hires ? 'Go' : 'Travel',
      });
      if (!go) return;
    }
    if (!this.gameClient.sendEnterTransition(action.targetId)) {
      this.showMoveToast(OFFLINE_NOTICE);
      return;
    }
    this.followCrossingUntil = performance.now() + OWN_TRAVEL_FOLLOW_MS;
  }

  /** The map an exit of the party's room leads to. */
  private exitMapId(state: ServerStateMessage, tileId: string): string | undefined {
    const here = this.worldCache.getTileOn(state.currentMapId, state.party.col, state.party.row);
    return here?.transitions?.find(link => link.tileId === tileId)?.mapId ?? this.worldCache.getTileByGuid(tileId)?.mapId;
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
      othersHere: this.viewedMapId ? 0 : this.map?.countOthersAt(state.party.col, state.party.row) ?? 0,
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
      const target = e.target as HTMLElement;
      const auto = target.closest<HTMLElement>('.map-route-auto');
      if (auto) {
        this.toggleAutoRun(auto);
        return;
      }
      if (target.closest('.map-route-stop')) this.stopTravel();
    });
    this.container.appendChild(this.routeChip);
  }

  private updateRouteChip(state: ServerStateMessage | null): void {
    const chip = this.routeChip;
    if (!chip) return;
    if (!state || !isTravelling(state.party) || state.dungeon) {
      chip.hidden = true;
      return;
    }
    const name = destinationName(state, this.worldCache);
    const nameHtml = name ? `<span class="map-route-name">${escapeHtml(name)}</span><span class="map-route-dot">·</span>` : '';
    const count = routeCountText(state.party);
    const on = state.social?.party?.autoRun === true;
    const locked = !this.canMove();
    const autoTitle = locked
      ? 'Only the party owner or a leader can change Autorun'
      : autoRunTitle(on);
    chip.hidden = false;
    const receivedAt = this.gameClient.lastStateAt;
    deferWhilePressed(chip, () => {
      setHtml(chip, `<span class="map-route-text"><span class="map-route-arrow">→</span>${nameHtml}<span class="map-route-count">${escapeHtml(count)}</span></span>`
        + `<button type="button" class="map-route-auto${on ? ' on' : ''}${locked ? ' locked' : ''}" aria-pressed="${on}" title="${autoTitle}">${AUTO_RUN_FILL_HTML}Autorun</button>`
        + '<button type="button" class="map-route-stop">Stop</button>');
      const auto = chip.querySelector('.map-route-auto');
      if (auto) this.autoRunFill.paint(auto, state.battle, receivedAt);
    });
  }

  private toggleAutoRun(button: HTMLElement): void {
    if (button.classList.contains('locked')) {
      this.showMoveToast('Only the party owner or a leader can change Autorun');
      return;
    }
    if (!this.gameClient.sendSetAutoRun(button.getAttribute('aria-pressed') !== 'true')) this.showMoveToast(OFFLINE_NOTICE);
  }

  private createZoomControls(): void {
    if (this.zoomControls) return;

    this.zoomControls = document.createElement('div');
    this.zoomControls.className = 'map-zoom-controls';
    this.zoomControls.innerHTML = `
      <button type="button" class="map-zoom-btn map-maps-btn" aria-label="Maps" title="Maps">${MAPS_ICON}</button>
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

    this.zoomControls.querySelector('.map-maps-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.openMapList();
    });

    this.recenterButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.recenterOnPlayer();
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

  private async openMapList(): Promise<void> {
    if (!this.mapList) {
      const loaded = await import('../ui/MapList').catch(() => null);
      if (!loaded) {
        this.showMoveToast(OFFLINE_NOTICE);
        return;
      }
      this.mapList ??= new loaded.MapList(this.gameClient, this.worldCache, () => this.viewedMapId, (mapId) => this.viewMap(mapId));
    }
    if (this.active) this.mapList.open();
  }

  private isViewable(mapId: string, state: ServerStateMessage): boolean {
    return this.worldCache.viewableMapIds(state.unlocked ?? []).has(mapId);
  }

  private mapExists(mapId: string): boolean {
    return this.worldCache.getMaps().some(m => m.id === mapId);
  }

  private mapName(mapId: string): string {
    return this.worldCache.getMaps().find(m => m.id === mapId)?.name || mapId;
  }

  /** Look at another map: no token, route or other players on it, and Back or Escape returns to the party. */
  private viewMap(mapId: string, focusTileId?: string): void {
    const state = this.gameClient.lastState;
    if (!this.map || !state) return;
    if (mapId === state.currentMapId) {
      this.endView();
      return;
    }
    this.dismissSheet();
    this.viewedMapId = mapId;
    this.map.setViewedMap(mapId);
    this.map.applyServerState(state, true);
    const spot = this.viewFocus(mapId, focusTileId, state);
    if (spot) this.map.focusOn(spot.col, spot.row);
    this.showViewBanner(mapId);
  }

  /** The focus room, else the found room nearest the middle of the map's found rooms, else the map's start. */
  private viewFocus(mapId: string, focusTileId: string | undefined, state: ServerStateMessage): { col: number; row: number } | null {
    const focus = focusTileId ? this.worldCache.getTileByGuid(focusTileId) : undefined;
    if (focus?.mapId === mapId) return focus;
    const found: WorldTileDefinition[] = [];
    for (const id of state.unlocked ?? []) {
      const tile = this.worldCache.getTileByGuid(id);
      if (tile?.mapId === mapId) found.push(tile);
    }
    if (found.length === 0) return this.worldCache.getMaps().find(m => m.id === mapId)?.startTile ?? null;
    const points = found.map(tile => cubeToPixel(offsetToCube(tile)));
    const midX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const midY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.hypot(points[i].x - midX, points[i].y - midY) < Math.hypot(points[best].x - midX, points[best].y - midY)) best = i;
    }
    return found[best];
  }

  /** Back to the party's map, centred on the party. Nothing happens while no other map is on screen. */
  private endView(): void {
    if (!this.viewedMapId) return;
    this.stopViewing();
    this.dismissSheet();
    const state = this.gameClient.lastState;
    if (state) this.map?.applyServerState(state, true);
  }

  /** Back and Escape close the viewed map's sheet before the view itself. */
  private backFromView(): void {
    if (this.roomSheet?.isOpen) this.dismissSheet();
    else this.endView();
  }

  /** Forget the view without drawing anything: the next applyServerState draws the party's map. */
  private stopViewing(): void {
    this.viewedMapId = null;
    this.map?.setViewedMap(null);
    delete this.container.dataset.viewing;
    if (!this.viewBanner) return;
    this.viewBanner.hidden = true;
    release(this.viewBanner);
  }

  private showViewBanner(mapId: string): void {
    if (!this.viewBanner) {
      const banner = document.createElement('div');
      banner.className = 'map-view-banner';
      const stop = (e: Event) => { e.stopPropagation(); };
      for (const ev of ['pointerdown', 'mousedown', 'click', 'touchstart'] as const) banner.addEventListener(ev, stop);
      banner.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.map-view-back')) this.recenterOnPlayer();
        else if (target.closest('.map-view-name')) void this.openMapList();
      });
      this.container.appendChild(banner);
      this.viewBanner = banner;
    }
    const name = this.mapName(mapId);
    this.viewBanner.hidden = false;
    this.container.dataset.viewing = '1';
    setHtml(this.viewBanner, '<button type="button" class="map-view-back">◀ Your party</button>'
      + `<button type="button" class="map-view-name" aria-label="Maps: viewing ${escapeHtml(name)}">${escapeHtml(name)}</button>`);
    if (this.active) registerDismiss(this.viewBanner, () => this.backFromView());
  }

  /**
   * Before a push is drawn: the party reaching the viewed map ends the view quietly, a viewed map that is gone
   * ends it, and a party that crosses to another map while the player looks elsewhere leaves the old map as a view.
   */
  private syncView(state: ServerStateMessage): void {
    const previousPartyMapId = this.partyMapId;
    this.partyMapId = state.currentMapId;
    if (this.viewedMapId) {
      if (state.currentMapId === this.viewedMapId) {
        this.stopViewing();
      } else if (!this.mapExists(this.viewedMapId)) {
        this.stopViewing();
        this.dismissSheet();
      }
      return;
    }
    if (!this.map || !previousPartyMapId || previousPartyMapId === state.currentMapId) return;
    const ownTravel = performance.now() < this.followCrossingUntil;
    this.followCrossingUntil = 0;
    if (ownTravel || (!this.roomSheet?.isOpen && this.map.isFollowing)) return;
    this.viewedMapId = previousPartyMapId;
    this.map.setViewedMap(previousPartyMapId);
    this.showViewBanner(previousPartyMapId);
    this.showMoveToast(`Your party traveled to ${this.mapName(state.currentMapId)}.`);
  }

  private subscribeToState(): void {
    this.unsubscribeState?.();
    if (!this.map) return;

    this.unsubscribeState = this.gameClient.subscribe((state) => {
      if (this.map) {
        this.syncView(state);
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
