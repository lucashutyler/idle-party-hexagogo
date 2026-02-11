import Phaser from 'phaser';
import {
  HexGrid,
  TileType,
  generateWorldMap,
  HEX_SIZE,
  getHexCorners,
  pixelToCube,
  offsetToCube,
  cubeToPixel,
  cubeToOffset,
} from '@idle-party-rpg/shared';
import type { ServerStateMessage, OtherPlayerState } from '@idle-party-rpg/shared';
import { Party } from '../entities/Party';

const OTHER_PLAYER_COLOR = 0x4a90d9;
const OTHER_PLAYER_RADIUS = 10;
const OTHER_PLAYER_TWEEN_DURATION = 400;

interface OtherPartyMarker {
  circle: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  tween?: Phaser.Tweens.Tween;
}

export class WorldMapScene extends Phaser.Scene {
  private grid!: HexGrid;
  private party?: Party;

  /** Set of tile keys the server says are unlocked. */
  private unlockedKeys = new Set<string>();

  /** Other player markers on the map. */
  private otherParties = new Map<string, OtherPartyMarker>();

  // Graphics layers
  private tileGraphics!: Phaser.GameObjects.Graphics;
  private pathGraphics!: Phaser.GameObjects.Graphics;
  private highlightGraphics!: Phaser.GameObjects.Graphics;

  // Tile icons (stored for cleanup on re-render)
  private tileIcons: Phaser.GameObjects.Text[] = [];

  // Map offset (small padding from origin)
  private mapOffsetX = HEX_SIZE;
  private mapOffsetY = HEX_SIZE;

  // Drag panning state
  private isDragging = false;
  private wasDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;

  // External move handler (set by MapScreen)
  private sendMoveFn?: (col: number, row: number) => void;

  // Track initial state for snap vs tween
  private isFirstState = true;

  constructor() {
    super({ key: 'WorldMapScene' });
  }

  create(): void {
    // Generate the map from schema (used for rendering / tile lookup only)
    this.grid = generateWorldMap();

    // Create graphics layers
    this.tileGraphics = this.add.graphics();
    this.pathGraphics = this.add.graphics();
    this.highlightGraphics = this.add.graphics();

    // Render the hex grid (all locked initially — server will tell us what's unlocked)
    this.renderGrid();

    // Set up camera + input
    this.setupCamera();
    this.setupDragPanning();
    this.setupInput();
  }

  // ── External API ──────────────────────────────────────────

  /** Set the callback for sending move commands to the server. */
  setSendMove(fn: (col: number, row: number) => void): void {
    this.sendMoveFn = fn;
  }

  /** Apply a state update from the server. */
  applyServerState(state: ServerStateMessage, snap?: boolean): void {
    const shouldSnap = snap || this.isFirstState;

    // Update unlocked set & re-render if changed
    const newKeys = new Set(state.unlocked);
    if (newKeys.size !== this.unlockedKeys.size || !this.setsEqual(newKeys, this.unlockedKeys)) {
      this.unlockedKeys = newKeys;
      this.renderGrid();
    }

    // Create party lazily on first state
    if (!this.party) {
      this.party = new Party(
        this,
        state.party.col,
        state.party.row,
        this.mapOffsetX,
        this.mapOffsetY,
      );

      // Center camera on party
      const sprite = this.party.getSprite();
      this.cameras.main.centerOn(sprite.x, sprite.y);
    }

    // Apply position & visual
    this.party.applyServerState(state.party, state.battle.visual, shouldSnap);

    // Re-center camera on snap (initial load or browser tab resume)
    if (shouldSnap) {
      const sprite = this.party.getSprite();
      if (this.isFirstState) {
        // Very first state — instant center, nothing to animate from
        this.cameras.main.centerOn(sprite.x, sprite.y);
      } else {
        // Returning from background tab — smooth pan to current position
        this.cameras.main.pan(sprite.x, sprite.y, 500, 'Quad.easeInOut');
      }
    }

    // Update path display from server-provided path
    this.updatePathFromServer(state.party.path);

    // Sync other players on the map
    this.syncOtherPlayers(state.otherPlayers);

    this.isFirstState = false;
  }

  /** Center the camera on the party sprite. */
  centerOnParty(): void {
    if (this.party) {
      const sprite = this.party.getSprite();
      this.cameras.main.centerOn(sprite.x, sprite.y);
    }
  }

  private setsEqual(a: Set<string>, b: Set<string>): boolean {
    for (const key of a) {
      if (!b.has(key)) return false;
    }
    return true;
  }

  // ── Other Players ────────────────────────────────────────

  private syncOtherPlayers(others: OtherPlayerState[]): void {
    const seen = new Set<string>();

    for (const other of others) {
      seen.add(other.username);
      const pixel = cubeToPixel(offsetToCube({ col: other.col, row: other.row }));
      const x = pixel.x + this.mapOffsetX;
      const y = pixel.y + this.mapOffsetY;

      let marker = this.otherParties.get(other.username);
      if (marker) {
        // Tween to new position if it changed
        if (marker.circle.x !== x || marker.circle.y !== y) {
          const m = marker;
          m.tween?.stop();
          m.tween = this.tweens.add({
            targets: m.circle,
            x, y,
            duration: OTHER_PLAYER_TWEEN_DURATION,
            ease: 'Quad.easeInOut',
            onUpdate: () => {
              m.label.setPosition(m.circle.x, m.circle.y + OTHER_PLAYER_RADIUS + 8);
            },
            onComplete: () => { m.tween = undefined; },
          });
        }
      } else {
        // Create new marker
        const circle = this.add.circle(x, y, OTHER_PLAYER_RADIUS, OTHER_PLAYER_COLOR);
        circle.setStrokeStyle(2, 0xffffff);
        circle.setDepth(90);

        const label = this.add.text(x, y + OTHER_PLAYER_RADIUS + 8, other.username, {
          fontSize: '8px',
          fontFamily: "'Press Start 2P', monospace",
          color: '#ffffff',
        });
        label.setOrigin(0.5, 0);
        label.setDepth(90);

        marker = { circle, label };
        this.otherParties.set(other.username, marker);
      }
    }

    // Remove markers for players no longer present
    for (const [username, marker] of this.otherParties) {
      if (!seen.has(username)) {
        marker.tween?.stop();
        marker.circle.destroy();
        marker.label.destroy();
        this.otherParties.delete(username);
      }
    }
  }

  // ── Rendering ────────────────────────────────────────────

  private renderGrid(): void {
    this.tileGraphics.clear();

    // Destroy old tile icons
    for (const icon of this.tileIcons) {
      icon.destroy();
    }
    this.tileIcons = [];

    const corners = getHexCorners(HEX_SIZE);

    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === TileType.Void) continue;

      const pos = tile.pixelPosition;
      const x = pos.x + this.mapOffsetX;
      const y = pos.y + this.mapOffsetY;

      const isUnlocked = this.unlockedKeys.has(tile.key);
      const alpha = isUnlocked ? 1 : 0.4;
      const color = isUnlocked ? tile.color : this.darkenColor(tile.color, 0.5);

      // Fill
      this.tileGraphics.fillStyle(color, alpha);
      this.tileGraphics.beginPath();
      this.tileGraphics.moveTo(x + corners[0].x, y + corners[0].y);
      for (let i = 1; i < 6; i++) {
        this.tileGraphics.lineTo(x + corners[i].x, y + corners[i].y);
      }
      this.tileGraphics.closePath();
      this.tileGraphics.fillPath();

      // Outline
      const outlineColor = isUnlocked ? 0x1a1a2e : 0x0a0a1e;
      const outlineAlpha = isUnlocked ? 0.5 : 0.3;
      this.tileGraphics.lineStyle(2, outlineColor, outlineAlpha);
      this.tileGraphics.beginPath();
      this.tileGraphics.moveTo(x + corners[0].x, y + corners[0].y);
      for (let i = 1; i < 6; i++) {
        this.tileGraphics.lineTo(x + corners[i].x, y + corners[i].y);
      }
      this.tileGraphics.closePath();
      this.tileGraphics.strokePath();

      // Icons
      this.drawTileIcon(tile.type, x, y, isUnlocked);
    }
  }

  private darkenColor(color: number, factor: number): number {
    const r = Math.floor(((color >> 16) & 0xff) * factor);
    const g = Math.floor(((color >> 8) & 0xff) * factor);
    const b = Math.floor((color & 0xff) * factor);
    return (r << 16) | (g << 8) | b;
  }

  private drawTileIcon(type: TileType, x: number, y: number, isUnlocked: boolean): void {
    let icon = '';

    switch (type) {
      case TileType.Town:
        icon = '🏠';
        break;
      case TileType.Dungeon:
        icon = '🕳️';
        break;
      case TileType.Mountain:
        icon = '⛰️';
        break;
      case TileType.Forest:
        icon = '🌲';
        break;
      case TileType.Water:
        icon = '🌊';
        break;
    }

    if (icon) {
      const text = this.add.text(x, y, icon, { fontSize: '20px' });
      text.setOrigin(0.5);
      text.setDepth(10);
      text.setAlpha(isUnlocked ? 1 : 0.3);
      this.tileIcons.push(text);
    }
  }

  private updatePathFromServer(path: { col: number; row: number }[]): void {
    this.pathGraphics.clear();
    if (path.length === 0) return;

    const corners = getHexCorners(HEX_SIZE * 0.3);

    for (const step of path) {
      const pixel = cubeToPixel(offsetToCube({ col: step.col, row: step.row }));
      const x = pixel.x + this.mapOffsetX;
      const y = pixel.y + this.mapOffsetY;

      this.pathGraphics.fillStyle(0xffff00, 0.4);
      this.pathGraphics.beginPath();
      this.pathGraphics.moveTo(x + corners[0].x, y + corners[0].y);
      for (let i = 1; i < 6; i++) {
        this.pathGraphics.lineTo(x + corners[i].x, y + corners[i].y);
      }
      this.pathGraphics.closePath();
      this.pathGraphics.fillPath();
    }

    // Destination marker
    const dest = path[path.length - 1];
    const destPixel = cubeToPixel(offsetToCube({ col: dest.col, row: dest.row }));
    this.pathGraphics.fillStyle(0x00ff00, 0.6);
    this.pathGraphics.fillCircle(
      destPixel.x + this.mapOffsetX,
      destPixel.y + this.mapOffsetY,
      8,
    );
  }

  // ── Camera & Input ───────────────────────────────────────

  private setupCamera(): void {
    this.input.on('wheel', (
      _pointer: Phaser.Input.Pointer,
      _gameObjects: Phaser.GameObjects.GameObject[],
      _deltaX: number,
      deltaY: number,
    ) => {
      const camera = this.cameras.main;
      const zoomDelta = deltaY > 0 ? -0.1 : 0.1;
      camera.zoom = Phaser.Math.Clamp(camera.zoom + zoomDelta, 0.5, 2);
    });

    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      const camera = this.cameras.main;
      const panSpeed = 10;

      switch (event.key) {
        case 'ArrowUp':
          camera.scrollY -= panSpeed;
          break;
        case 'ArrowDown':
          camera.scrollY += panSpeed;
          break;
        case 'ArrowLeft':
          camera.scrollX -= panSpeed;
          break;
        case 'ArrowRight':
          camera.scrollX += panSpeed;
          break;
      }
    });
  }

  private setupDragPanning(): void {
    let dragDistance = 0;
    const DRAG_THRESHOLD = 5;

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonDown()) {
        this.isDragging = true;
        this.dragStartX = pointer.x;
        this.dragStartY = pointer.y;
        dragDistance = 0;
      }
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (this.isDragging && pointer.isDown) {
        const camera = this.cameras.main;
        const dx = (this.dragStartX - pointer.x) / camera.zoom;
        const dy = (this.dragStartY - pointer.y) / camera.zoom;

        dragDistance += Math.abs(dx) + Math.abs(dy);

        camera.scrollX += dx;
        camera.scrollY += dy;

        this.dragStartX = pointer.x;
        this.dragStartY = pointer.y;
      }
    });

    this.input.on('pointerup', () => {
      this.wasDragging = dragDistance > DRAG_THRESHOLD;
      this.isDragging = false;
      dragDistance = 0;
    });

    this.input.on('pointerupoutside', () => {
      this.isDragging = false;
      dragDistance = 0;
    });
  }

  private setupInput(): void {
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (!this.wasDragging) {
        this.handleClick(pointer);
      }
    });

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.isDragging) {
        this.handleHover(pointer);
      }
    });
  }

  private handleClick(pointer: Phaser.Input.Pointer): void {
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const adjustedX = worldPoint.x - this.mapOffsetX;
    const adjustedY = worldPoint.y - this.mapOffsetY;

    const cubeCoord = pixelToCube({ x: adjustedX, y: adjustedY });
    const tile = this.grid.getTile(cubeCoord);

    if (!tile) return;

    if (!tile.isTraversable) {
      this.flashTile(tile.pixelPosition, 0xff0000);
      return;
    }

    // Send move command via external handler
    const offset = cubeToOffset(cubeCoord);
    this.sendMoveFn?.(offset.col, offset.row);
  }

  private handleHover(pointer: Phaser.Input.Pointer): void {
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const adjustedX = worldPoint.x - this.mapOffsetX;
    const adjustedY = worldPoint.y - this.mapOffsetY;

    const cubeCoord = pixelToCube({ x: adjustedX, y: adjustedY });
    const tile = this.grid.getTile(cubeCoord);

    this.highlightGraphics.clear();

    if (!tile) return;

    const corners = getHexCorners(HEX_SIZE);
    const pos = tile.pixelPosition;
    const x = pos.x + this.mapOffsetX;
    const y = pos.y + this.mapOffsetY;

    const highlightColor = tile.isTraversable ? 0xffffff : 0xff6666;
    this.highlightGraphics.lineStyle(3, highlightColor, 0.8);
    this.highlightGraphics.beginPath();
    this.highlightGraphics.moveTo(x + corners[0].x, y + corners[0].y);
    for (let i = 1; i < 6; i++) {
      this.highlightGraphics.lineTo(x + corners[i].x, y + corners[i].y);
    }
    this.highlightGraphics.closePath();
    this.highlightGraphics.strokePath();
  }

  private flashTile(pos: { x: number; y: number }, color: number): void {
    const corners = getHexCorners(HEX_SIZE);
    const x = pos.x + this.mapOffsetX;
    const y = pos.y + this.mapOffsetY;

    const flash = this.add.graphics();
    flash.fillStyle(color, 0.5);
    flash.beginPath();
    flash.moveTo(x + corners[0].x, y + corners[0].y);
    for (let i = 1; i < 6; i++) {
      flash.lineTo(x + corners[i].x, y + corners[i].y);
    }
    flash.closePath();
    flash.fillPath();

    this.tweens.add({
      targets: flash,
      alpha: 0,
      duration: 300,
      onComplete: () => flash.destroy(),
    });
  }

  update(): void {
    // No-op — all updates are driven by server state callbacks
  }
}
