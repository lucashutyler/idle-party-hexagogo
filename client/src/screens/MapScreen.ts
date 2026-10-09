import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { toShopSummary } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { Screen } from './ScreenManager';
import { RoomView } from '../ui/RoomView';
import { RoomStatusPanel } from '../ui/RoomStatusPanel';
import { getRoomActions, questMarks } from '../ui/RoomActions';
import type { RoomAction, RoomActionLookups } from '../ui/RoomActions';
import { ShopPopup } from '../ui/ShopPopup';
import { ThreeWorldMap } from '../ui/ThreeWorldMap';
import type { TileClickInfo } from '../ui/ThreeWorldMap';
import { NpcTalkPopup } from '../ui/NpcTalkPopup';
import { DungeonEntryPopup } from '../ui/DungeonEntryPopup';
import { showMapToast } from '../ui/MapToast';

export class MapScreen implements Screen {
  private container: HTMLElement;
  private gameContainer: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private map: ThreeWorldMap | null = null;
  private unsubscribeState?: () => void;
  private zoomControls?: HTMLElement;
  private roomView?: RoomView;
  private roomStatus?: RoomStatusPanel;
  private shopPopup?: ShopPopup;
  private npcTalkPopup?: NpcTalkPopup;
  private dungeonEntryPopup?: DungeonEntryPopup;
  private onUserClickCallback?: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void;

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

    this.gameClient.onMoveBlocked((msg) => {
      const names = msg.missingPlayers.join(', ');
      this.showMoveToast(names ? `${msg.reason} Missing: ${names}` : msg.reason);
    });
    // While the entry popup is open it shows the refusal itself.
    this.gameClient.onServerError((message, code) => {
      if (code === 'dungeon_entry_refused' && !this.dungeonEntryPopup?.isOpen) this.showMoveToast(message);
    });
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void): void {
    this.onUserClickCallback = cb;
  }

  /** Recenter the camera on the player's party. Used when the user
   *  re-clicks the Map tab while already on the Map screen. */
  recenterOnPlayer(): void {
    this.map?.recenterOnPlayer();
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
    if (!this.map) {
      this.createMap();
    } else {
      this.map.resume();
      if (this.gameClient.lastState) {
        this.map.applyServerState(this.gameClient.lastState, true);
      }
      this.updateRoomStatus(this.gameClient.lastState);
    }

    this.subscribeToState();
  }

  onDeactivate(): void {
    if (this.map) this.map.pause();
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
  }

  private canMove(): boolean {
    const state = this.gameClient.lastState;
    if (!state?.social?.party) return true;
    const me = state.social.party.members.find(m => m.username === state.username);
    if (!me) return true;
    return me.role === 'owner' || me.role === 'leader';
  }

  private tryMove(col: number, row: number): void {
    // Parties are locked inside a dungeon instance — bail out first to travel.
    if (this.gameClient.lastState?.dungeon) {
      this.showMoveToast('Leave the dungeon before traveling');
      return;
    }
    if (this.canMove()) {
      this.gameClient.sendMove(col, row);
    } else {
      this.showMoveToast('Only the party owner or a leader can move');
    }
  }

  private showMoveToast(message: string): void {
    showMapToast(this.container, message);
  }

  private async createMap(): Promise<void> {
    if (!this.worldCache.isLoaded) {
      await this.worldCache.loadWorld().catch(err => {
        console.warn('[MapScreen] Failed to load world data:', err);
      });
    }

    this.map = new ThreeWorldMap(this.gameContainer, this.worldCache);
    this.map.setSendMove((col, row) => this.tryMove(col, row));

    this.shopPopup = new ShopPopup(this.gameClient, this.worldCache);
    this.npcTalkPopup = new NpcTalkPopup(this.gameClient);
    this.dungeonEntryPopup = new DungeonEntryPopup(this.gameClient);
    this.roomView = new RoomView(
      this.container,
      (col, row) => { this.tryMove(col, row); },
      (username, anchor, tileCol, tileRow) => { this.onUserClickCallback?.(username, anchor, tileCol, tileRow); },
      (action) => { this.runAction(action); },
    );
    this.map.setOnTileClick((tileInfo) => { this.showRoom(tileInfo); });
    this.roomStatus = new RoomStatusPanel(
      this.container,
      (action) => { this.runAction(action); },
      () => { this.openCurrentRoom(); },
    );

    if (this.gameClient.lastState) {
      this.map.applyServerState(this.gameClient.lastState, true);
    }
    this.updateRoomStatus(this.gameClient.lastState);

    this.createZoomControls();
    this.subscribeToState();
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
    if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can enter'); return; }
    this.dungeonEntryPopup?.show(dungeon, state.party.col, state.party.row);
  }

  private enterTransition(tileId: string): void {
    const state = this.gameClient.lastState;
    if (!state) return;
    if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
    if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can travel'); return; }
    this.gameClient.sendEnterTransition(tileId);
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

  private createZoomControls(): void {
    if (this.zoomControls) return;

    this.zoomControls = document.createElement('div');
    this.zoomControls.className = 'map-zoom-controls';
    this.zoomControls.innerHTML = `
      <button class="map-zoom-btn map-zoom-in">+</button>
      <button class="map-zoom-btn map-zoom-out">&minus;</button>
    `;
    this.container.appendChild(this.zoomControls);

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
      this.updateRoomStatus(state);
    });
  }
}
