import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { Screen } from './ScreenManager';
import { TileInfoModal } from '../ui/TileInfoModal';

export class MapScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private game: import('phaser').Game | null = null;
  private unsubscribeState?: () => void;
  private sceneReady = false;
  private zoomControls?: HTMLElement;
  private tileModal?: TileInfoModal;
  private onUserClickCallback?: (username: string, anchor: HTMLElement) => void;
  private moveToastTimeout?: ReturnType<typeof setTimeout>;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement) => void): void {
    this.onUserClickCallback = cb;
  }

  /** Refresh the map from updated WorldCache data. */
  refreshWorld(): void {
    const scene = this.getScene();
    if (scene) {
      scene.rebuildFromCache();
      // Re-apply current state (party position, other players, etc.)
      if (this.gameClient.lastState) {
        scene.applyServerState(this.gameClient.lastState, true);
      }
    }
    // If scene doesn't exist yet, next createPhaserGame() will build from current cache
  }

  /** Check if the current player can move (must be owner or leader). */
  private canMove(): boolean {
    const state = this.gameClient.lastState;
    if (!state?.social?.party) return true; // solo or no data yet — allow
    const me = state.social.party.members.find(m => m.username === state.username);
    if (!me) return true; // not found — allow
    return me.role === 'owner' || me.role === 'leader';
  }

  /** Try to send a move; show toast if not allowed. */
  private tryMove(col: number, row: number): void {
    if (this.canMove()) {
      this.gameClient.sendMove(col, row);
    } else {
      this.showMoveToast('Only the party owner or a leader can move');
    }
  }

  private showMoveToast(message: string): void {
    // Remove existing toast
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
    if (!this.game) {
      this.createPhaserGame();
    } else {
      // Wake the game loop and resume the scene
      this.game.loop.wake();
      this.game.scene.resume('WorldMapScene');

      // Resize canvas after container is visible (needs a frame for layout)
      requestAnimationFrame(() => {
        if (this.game) {
          this.game.scale.resize(this.container.clientWidth, this.container.clientHeight);
        }
      });

      // Snap to current state (no tweens — player expects to see "where I am now")
      if (this.gameClient.lastState) {
        const scene = this.game.scene.getScene('WorldMapScene') as import('../scenes/WorldMapScene').WorldMapScene;
        scene.applyServerState(this.gameClient.lastState, true);
      }
    }

    this.subscribeToState();
  }

  onDeactivate(): void {
    if (this.game) {
      this.game.scene.pause('WorldMapScene');
      this.game.loop.sleep();
    }

    this.unsubscribeState?.();
    this.unsubscribeState = undefined;
  }

  private async createPhaserGame(): Promise<void> {
    const Phaser = await import('phaser');
    const { WorldMapScene } = await import('../scenes/WorldMapScene');

    // Create a scene instance with the world cache injected
    const sceneInstance = new WorldMapScene(this.worldCache);

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      width: this.container.clientWidth,
      height: this.container.clientHeight,
      parent: 'game-container',
      backgroundColor: '#2d2d44',
      scene: [sceneInstance],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });

    // Wait for scene to be ready before wiring up
    this.game.events.once('ready', () => {
      const scene = this.game!.scene.getScene('WorldMapScene') as InstanceType<typeof WorldMapScene>;
      scene.setSendMove((col, row) => this.tryMove(col, row));

      // Wire tile click handler for modal
      this.tileModal = new TileInfoModal(
        this.container,
        (col, row) => { this.tryMove(col, row); },
        (username) => { this.gameClient.sendInviteParty(username); },
        (username, anchor) => { this.onUserClickCallback?.(username, anchor); },
      );
      scene.setOnTileClick((tileInfo) => {
        this.tileModal!.show(tileInfo);
      });

      this.sceneReady = true;

      // Apply last known state so the map doesn't start blank
      if (this.gameClient.lastState) {
        scene.applyServerState(this.gameClient.lastState, true);
      }

      this.createZoomControls();
      this.subscribeToState();
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
      this.getScene()?.adjustZoom(0.2);
    });

    this.zoomControls.querySelector('.map-zoom-out')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.getScene()?.adjustZoom(-0.2);
    });
  }

  private getScene(): import('../scenes/WorldMapScene').WorldMapScene | null {
    if (!this.game) return null;
    return this.game.scene.getScene('WorldMapScene') as import('../scenes/WorldMapScene').WorldMapScene;
  }

  private subscribeToState(): void {
    // Avoid double-subscribe
    this.unsubscribeState?.();

    if (!this.sceneReady || !this.game) return;

    this.unsubscribeState = this.gameClient.subscribe((state) => {
      const scene = this.game?.scene.getScene('WorldMapScene');
      if (scene) {
        const snap = this.gameClient.isInitialState;
        (scene as import('../scenes/WorldMapScene').WorldMapScene).applyServerState(state, snap);
      }
    });
  }
}
