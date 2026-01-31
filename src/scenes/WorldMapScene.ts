import Phaser from 'phaser';
import { HexGrid } from '../map/HexGrid';
import { HexTile, TileType } from '../map/HexTile';
import { generateWorldMap, getStartingPosition } from '../map/MapData';
import { Party } from '../entities/Party';
import { BattleTimer } from '../systems/BattleTimer';
import { UnlockSystem } from '../systems/UnlockSystem';
import {
  HEX_SIZE,
  getHexCorners,
  pixelToCube,
  offsetToCube,
} from '../utils/HexUtils';

export class WorldMapScene extends Phaser.Scene {
  private grid!: HexGrid;
  private party!: Party;
  private battleTimer!: BattleTimer;
  private unlockSystem!: UnlockSystem;

  // Graphics layers
  private tileGraphics!: Phaser.GameObjects.Graphics;
  private pathGraphics!: Phaser.GameObjects.Graphics;
  private highlightGraphics!: Phaser.GameObjects.Graphics;

  // Tile icons (stored for cleanup on re-render)
  private tileIcons: Phaser.GameObjects.Text[] = [];

  // Map offset (to center the map)
  private mapOffsetX = 0;
  private mapOffsetY = 0;

  // Drag panning state
  private isDragging = false;
  private wasDragging = false;
  private dragStartX = 0;
  private dragStartY = 0;

  // UI
  private statusText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'WorldMapScene' });
  }

  create(): void {
    // Generate the map from schema
    this.grid = generateWorldMap();

    // Calculate map offset to center it
    this.calculateMapOffset();

    // Create graphics layers
    this.tileGraphics = this.add.graphics();
    this.pathGraphics = this.add.graphics();
    this.highlightGraphics = this.add.graphics();

    // Create the party
    const startPos = getStartingPosition();
    const startCoord = offsetToCube(startPos);
    const startTile = this.grid.getTile(startCoord);

    if (!startTile) {
      console.error('Invalid starting position');
      return;
    }

    // Create unlock system BEFORE rendering (so tiles show correct unlock state)
    this.unlockSystem = new UnlockSystem(this.grid, startTile);
    this.unlockSystem.onTilesUnlocked = (tiles) => {
      // Re-render grid to show newly unlocked tiles
      this.renderGrid();
      console.log(`Unlocked ${tiles.length} new tiles!`);
    };

    // Render the hex grid (after unlock system is created)
    this.renderGrid();

    this.party = new Party(this, this.grid, startTile, this.mapOffsetX, this.mapOffsetY);

    // Create battle timer - set up callbacks BEFORE creating timer
    // (timer triggers first battle immediately in constructor)
    this.battleTimer = new BattleTimer(this, this.party, {
      onStateChange: () => {
        this.updateStatusText();
      },
      onBattleEnd: (result) => {
        if (result === 'victory') {
          // Unlock adjacent tiles on victory
          this.unlockSystem.unlockAdjacentTiles(this.party.tile);
        }
        // On defeat, player continues moving through already-unlocked tiles
        // (no special handling needed - just don't unlock new tiles)
        this.updateStatusText();
      },
    });

    // Set up party callbacks
    this.party.onDestinationReached = () => {
      this.clearPath();
      this.updateStatusText();
    };

    this.party.onTileReached = () => {
      this.updatePathDisplay();
    };

    // Set up camera
    this.setupCamera();
    this.setupDragPanning();

    // Center camera on party
    this.centerCameraOnParty();

    // Set up input
    this.setupInput();

    // Create status UI
    this.createUI();

    // Initial status
    this.updateStatusText();
  }

  private centerCameraOnParty(): void {
    const sprite = this.party.getSprite();
    this.cameras.main.centerOn(sprite.x, sprite.y);
  }

  private calculateMapOffset(): void {
    // Calculate the bounds of the map
    const tiles = this.grid.getAllTiles();
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const tile of tiles) {
      const pos = tile.pixelPosition;
      minX = Math.min(minX, pos.x);
      maxX = Math.max(maxX, pos.x);
      minY = Math.min(minY, pos.y);
      maxY = Math.max(maxY, pos.y);
    }

    // Center the map in the game view
    const mapWidth = maxX - minX + HEX_SIZE * 2;
    const mapHeight = maxY - minY + HEX_SIZE * 2;

    this.mapOffsetX = (this.cameras.main.width - mapWidth) / 2 - minX + HEX_SIZE;
    this.mapOffsetY = (this.cameras.main.height - mapHeight) / 2 - minY + HEX_SIZE;
  }

  private renderGrid(): void {
    // Clear previous graphics
    this.tileGraphics.clear();

    // Destroy old tile icons
    for (const icon of this.tileIcons) {
      icon.destroy();
    }
    this.tileIcons = [];

    const corners = getHexCorners(HEX_SIZE);

    for (const tile of this.grid.getAllTiles()) {
      // Skip rendering void tiles (they're holes)
      if (tile.type === TileType.Void) {
        continue;
      }

      const pos = tile.pixelPosition;
      const x = pos.x + this.mapOffsetX;
      const y = pos.y + this.mapOffsetY;

      // Check if tile is unlocked
      const isUnlocked = this.unlockSystem?.isUnlocked(tile) ?? false;

      // Locked tiles are darker and more transparent
      const alpha = isUnlocked ? 1 : 0.4;
      const color = isUnlocked ? tile.color : this.darkenColor(tile.color, 0.5);

      // Draw hex fill
      this.tileGraphics.fillStyle(color, alpha);
      this.tileGraphics.beginPath();
      this.tileGraphics.moveTo(x + corners[0].x, y + corners[0].y);
      for (let i = 1; i < 6; i++) {
        this.tileGraphics.lineTo(x + corners[i].x, y + corners[i].y);
      }
      this.tileGraphics.closePath();
      this.tileGraphics.fillPath();

      // Draw hex outline - locked tiles have darker outline
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

      // Draw icons for special tiles (only if unlocked or partially visible)
      this.drawTileIcon(tile, x, y, isUnlocked);
    }
  }

  /**
   * Darken a color by a factor (0-1, where 0 is black and 1 is original).
   */
  private darkenColor(color: number, factor: number): number {
    const r = Math.floor(((color >> 16) & 0xff) * factor);
    const g = Math.floor(((color >> 8) & 0xff) * factor);
    const b = Math.floor((color & 0xff) * factor);
    return (r << 16) | (g << 8) | b;
  }

  private drawTileIcon(tile: HexTile, x: number, y: number, isUnlocked: boolean): void {
    let icon = '';

    switch (tile.type) {
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
      const text = this.add.text(x, y, icon, {
        fontSize: '20px',
      });
      text.setOrigin(0.5);
      text.setDepth(10);
      // Fade icons on locked tiles
      text.setAlpha(isUnlocked ? 1 : 0.3);
      // Store for cleanup on re-render
      this.tileIcons.push(text);
    }
  }

  private setupCamera(): void {
    // Enable zoom with mouse wheel
    this.input.on('wheel', (
      _pointer: Phaser.Input.Pointer,
      _gameObjects: Phaser.GameObjects.GameObject[],
      _deltaX: number,
      deltaY: number
    ) => {
      const camera = this.cameras.main;
      const zoomDelta = deltaY > 0 ? -0.1 : 0.1;
      camera.zoom = Phaser.Math.Clamp(camera.zoom + zoomDelta, 0.5, 2);
    });

    // Pan with arrow keys
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
    // Track drag distance to distinguish click from drag
    let dragDistance = 0;
    const DRAG_THRESHOLD = 5;

    // Start drag on left-click
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.leftButtonDown()) {
        this.isDragging = true;
        this.dragStartX = pointer.x;
        this.dragStartY = pointer.y;
        dragDistance = 0;
      }
    });

    // Pan while dragging
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

    // Stop dragging on pointer up
    this.input.on('pointerup', () => {
      // Store whether this was a drag or click before resetting
      this.wasDragging = dragDistance > DRAG_THRESHOLD;
      this.isDragging = false;
      dragDistance = 0;
    });

    // Also stop if pointer leaves the game
    this.input.on('pointerupoutside', () => {
      this.isDragging = false;
      dragDistance = 0;
    });
  }

  private setupInput(): void {
    // Handle click on pointerup to distinguish from drag
    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      // Only handle as click if it wasn't a drag
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
      // Show feedback for impassable tile
      this.flashTile(tile, 0xff0000);
      return;
    }

    // Check if tile is unlocked
    if (!this.unlockSystem.isUnlocked(tile)) {
      // Show feedback for locked tile
      this.flashTile(tile, 0x666666);
      return;
    }

    // Set destination
    const success = this.party.setDestination(tile, this.unlockSystem);

    if (success) {
      this.updatePathDisplay();

      // Trigger battle immediately if in moving state
      if (this.battleTimer.currentState === 'moving') {
        this.battleTimer.start();
      }
    } else {
      this.flashTile(tile, 0xffff00);
    }

    this.updateStatusText();
  }

  private handleHover(pointer: Phaser.Input.Pointer): void {
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const adjustedX = worldPoint.x - this.mapOffsetX;
    const adjustedY = worldPoint.y - this.mapOffsetY;

    const cubeCoord = pixelToCube({ x: adjustedX, y: adjustedY });
    const tile = this.grid.getTile(cubeCoord);

    this.highlightGraphics.clear();

    if (!tile) return;

    // Highlight hovered tile
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

  private updatePathDisplay(): void {
    this.pathGraphics.clear();

    const path = this.party.remainingPath;
    if (path.length === 0) return;

    const corners = getHexCorners(HEX_SIZE * 0.3);

    // Draw path tiles
    for (const tile of path) {
      const pos = tile.pixelPosition;
      const x = pos.x + this.mapOffsetX;
      const y = pos.y + this.mapOffsetY;

      this.pathGraphics.fillStyle(0xffff00, 0.4);
      this.pathGraphics.beginPath();
      this.pathGraphics.moveTo(x + corners[0].x, y + corners[0].y);
      for (let i = 1; i < 6; i++) {
        this.pathGraphics.lineTo(x + corners[i].x, y + corners[i].y);
      }
      this.pathGraphics.closePath();
      this.pathGraphics.fillPath();
    }

    // Draw destination marker
    const destination = path[path.length - 1];
    const destPos = destination.pixelPosition;
    this.pathGraphics.fillStyle(0x00ff00, 0.6);
    this.pathGraphics.fillCircle(
      destPos.x + this.mapOffsetX,
      destPos.y + this.mapOffsetY,
      8
    );
  }

  private clearPath(): void {
    this.pathGraphics.clear();
  }

  private flashTile(tile: HexTile, color: number): void {
    const corners = getHexCorners(HEX_SIZE);
    const pos = tile.pixelPosition;
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

  private createUI(): void {
    this.statusText = this.add.text(16, 16, '', {
      fontSize: '16px',
      fontFamily: 'Arial',
      color: '#ffffff',
      backgroundColor: '#000000aa',
      padding: { x: 10, y: 5 },
    });
    this.statusText.setScrollFactor(0);
    this.statusText.setDepth(1000);
  }

  private updateStatusText(): void {
    const battleState = this.battleTimer.currentState;
    const remaining = this.party.remainingPath.length;

    let status = `State: ${battleState}`;
    if (remaining > 0) {
      status += ` | Tiles remaining: ${remaining}`;
    } else {
      status += ' | Click a tile to travel';
    }

    this.statusText.setText(status);
  }

  update(): void {
    this.battleTimer.update();
  }
}
