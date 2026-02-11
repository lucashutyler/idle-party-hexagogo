import type { GameClient } from '../network/GameClient';
import type { Screen } from './ScreenManager';

export class MapScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private game: import('phaser').Game | null = null;
  private unsubscribeState?: () => void;
  private sceneReady = false;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
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

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      width: this.container.clientWidth,
      height: this.container.clientHeight,
      parent: 'game-container',
      backgroundColor: '#2d2d44',
      scene: [WorldMapScene],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });

    // Wait for scene to be ready before wiring up
    this.game.events.once('ready', () => {
      const scene = this.game!.scene.getScene('WorldMapScene') as InstanceType<typeof WorldMapScene>;
      scene.setSendMove((col, row) => this.gameClient.sendMove(col, row));
      this.sceneReady = true;

      // Apply last known state so the map doesn't start blank
      if (this.gameClient.lastState) {
        scene.applyServerState(this.gameClient.lastState, true);
      }

      this.subscribeToState();
    });
  }

  private subscribeToState(): void {
    // Avoid double-subscribe
    this.unsubscribeState?.();

    if (!this.sceneReady || !this.game) return;

    this.unsubscribeState = this.gameClient.subscribe((state) => {
      const scene = this.game?.scene.getScene('WorldMapScene');
      if (scene) {
        (scene as import('../scenes/WorldMapScene').WorldMapScene).applyServerState(state);
      }
    });
  }
}
