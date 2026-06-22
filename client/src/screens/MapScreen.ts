import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { Screen } from './ScreenManager';
import { RoomView } from '../ui/RoomView';
import { ShopPopup } from '../ui/ShopPopup';
import { ThreeWorldMap } from '../ui/ThreeWorldMap';
import { NpcTalkPopup } from '../ui/NpcTalkPopup';
import { DungeonEntryPopup } from '../ui/DungeonEntryPopup';

export class MapScreen implements Screen {
  private container: HTMLElement;
  private gameContainer: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private map: ThreeWorldMap | null = null;
  private unsubscribeState?: () => void;
  private zoomControls?: HTMLElement;
  private roomView?: RoomView;
  private shopPopup?: ShopPopup;
  private npcTalkPopup?: NpcTalkPopup;
  private dungeonEntryPopup?: DungeonEntryPopup;
  private onUserClickCallback?: (username: string, anchor: HTMLElement, tileCol?: number, tileRow?: number) => void;
  private moveToastTimeout?: ReturnType<typeof setTimeout>;

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
      this.showMoveToast(`${msg.itemName} required! Missing: ${names}`);
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
  }

  private canMove(): boolean {
    const state = this.gameClient.lastState;
    if (!state?.social?.party) return true;
    const me = state.social.party.members.find(m => m.username === state.username);
    if (!me) return true;
    return me.role === 'owner' || me.role === 'leader';
  }

  /** Display name for a transition's destination — the target room, or its map. */
  private resolveTransitionName(link: { mapId: string; tileId: string }): string {
    const dest = this.worldCache.getTileByGuid(link.tileId);
    if (dest?.name) return dest.name;
    const map = this.worldCache.getMaps().find(m => m.id === link.mapId);
    return map?.name ?? 'the passage';
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
    const existing = this.container.querySelector('.map-toast');
    if (existing) existing.remove();
    if (this.moveToastTimeout) clearTimeout(this.moveToastTimeout);

    const toast = document.createElement('div');
    toast.className = 'map-toast';
    toast.textContent = message;
    this.container.appendChild(toast);

    this.moveToastTimeout = setTimeout(() => {
      toast.remove();
    }, 2000);
  }

  onActivate(): void {
    if (!this.map) {
      this.createMap();
    } else {
      this.map.resume();
      if (this.gameClient.lastState) {
        this.map.applyServerState(this.gameClient.lastState, true);
      }
    }

    this.subscribeToState();
  }

  onDeactivate(): void {
    if (this.map) this.map.pause();
    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
  }

  private async createMap(): Promise<void> {
    if (!this.worldCache.isLoaded) {
      await this.worldCache.loadWorld().catch(err => {
        console.warn('[MapScreen] Failed to load world data:', err);
      });
    }

    this.map = new ThreeWorldMap(this.gameContainer, this.worldCache);
    this.map.setSendMove((col, row) => this.tryMove(col, row));

    this.shopPopup = new ShopPopup(this.gameClient);
    this.npcTalkPopup = new NpcTalkPopup(this.gameClient);
    this.dungeonEntryPopup = new DungeonEntryPopup(this.gameClient);
    this.roomView = new RoomView(
      this.container,
      (col, row) => { this.tryMove(col, row); },
      (username, anchor, tileCol, tileRow) => { this.onUserClickCallback?.(username, anchor, tileCol, tileRow); },
      () => {
        const state = this.gameClient.lastState;
        if (state?.shopDefinition) this.shopPopup!.show(state);
      },
      (npc) => { this.npcTalkPopup!.show(npc); },
      (dungeon) => {
        const state = this.gameClient.lastState;
        if (!state) return;
        if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
        if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can enter'); return; }
        this.dungeonEntryPopup!.show(dungeon, state.party.col, state.party.row);
      },
      () => {
        const state = this.gameClient.lastState;
        if (!state) return;
        if (state.dungeon) { this.showMoveToast('Already in a dungeon'); return; }
        if (!this.canMove()) { this.showMoveToast('Only the party owner or a leader can travel'); return; }
        this.gameClient.sendEnterTransition();
      },
    );
    this.map.setOnTileClick((tileInfo) => {
      const state = this.gameClient.lastState;
      const playerOnTile = state && state.party.col === tileInfo.col && state.party.row === tileInfo.row;
      this.roomView!.hasShop = !!(playerOnTile && state?.shopDefinition);
      const tileDef = this.worldCache.getTile(tileInfo.col, tileInfo.row);
      this.roomView!.npc = (playerOnTile && tileDef?.npcId)
        ? (this.worldCache.getNpc(tileDef.npcId) ?? null)
        : null;
      // Only offer dungeon entry when standing on the entrance and not already inside one.
      this.roomView!.dungeon = (playerOnTile && !state?.dungeon && tileDef?.dungeonId)
        ? (this.worldCache.getDungeon(tileDef.dungeonId) ?? null)
        : null;
      // Offer map travel when standing on a room with a transition link.
      this.roomView!.transition = (playerOnTile && !state?.dungeon && tileDef?.transitionsTo)
        ? { name: this.resolveTransitionName(tileDef.transitionsTo) }
        : null;
      this.roomView!.show(tileInfo);
    });

    if (this.gameClient.lastState) {
      this.map.applyServerState(this.gameClient.lastState, true);
    }

    this.createZoomControls();
    this.subscribeToState();
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
    });
  }
}
