import Phaser from 'phaser';
import {
  HexGrid,
  HexTile,
  TileType,
  HEX_SIZE,
  getHexCorners,
  getNeighbors,
  pixelToCube,
  offsetToCube,
  cubeToPixel,
  cubeToOffset,
} from '@idle-party-rpg/shared';
import type { ServerStateMessage, OtherPlayerState, WorldTileDefinition } from '@idle-party-rpg/shared';
import type { WorldCache } from '../network/WorldCache';
import { Party } from '../entities/Party';

export interface TileClickInfo {
  col: number;
  row: number;
  tileType: string;
  zoneName: string;
  roomName: string;
  zoneId: string;
  isTraversable: boolean;
  isUnlocked: boolean;
  isSameZone: boolean;
  isCurrentTile: boolean;
  playersHere: { username: string; className?: string }[];
  partyMemberUsernames: string[];
}

const PLAYER_COUNT_BADGE_COLOR = '#4a90d9';

export class WorldMapScene extends Phaser.Scene {
  private grid!: HexGrid;
  private worldCache: WorldCache;
  private party?: Party;

  /** World tile definitions keyed by "col,row" for room name lookups. */
  private worldTileDefs = new Map<string, WorldTileDefinition>();

  /** Count badges for same-zone tiles with players. */
  private playerCounts = new Map<string, Phaser.GameObjects.Text>();

  /** Current player zone for filtering. */
  private currentZone = '';

  /** Current player position for tile modal context. */
  private playerCol = 0;
  private playerRow = 0;

  /** Last known other player list for tile info lookups. */
  private lastOtherPlayers: OtherPlayerState[] = [];

  /** Usernames of players in the current player's party. */
  private partyMemberUsernames: string[] = [];

  // Graphics layers
  private tileGraphics!: Phaser.GameObjects.Graphics;
  private zoneOverlayGraphics!: Phaser.GameObjects.Graphics;
  private zoneBorderGraphics!: Phaser.GameObjects.Graphics;
  private pathGraphics!: Phaser.GameObjects.Graphics;
  private highlightGraphics!: Phaser.GameObjects.Graphics;

  // Hover tooltip
  private tooltipText?: Phaser.GameObjects.Text;

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

  // External tile click handler (set by MapScreen for modal)
  private onTileClickFn?: (tileInfo: TileClickInfo) => void;

  // Track initial state for snap vs tween
  private isFirstState = true;

  constructor(worldCache: WorldCache) {
    super({ key: 'WorldMapScene' });
    this.worldCache = worldCache;
  }

  create(): void {
    // Build grid from world cache data
    this.grid = this.buildGridFromCache();

    // Create graphics layers
    this.tileGraphics = this.add.graphics();
    this.zoneOverlayGraphics = this.add.graphics();
    this.zoneOverlayGraphics.setDepth(15);
    this.zoneBorderGraphics = this.add.graphics();
    this.zoneBorderGraphics.setDepth(5);
    this.pathGraphics = this.add.graphics();
    this.highlightGraphics = this.add.graphics();

    // Hover tooltip (fixed to camera, above everything)
    this.tooltipText = this.add.text(0, 0, '', {
      fontSize: '8px',
      fontFamily: "'Press Start 2P', monospace",
      color: '#ffffff',
      backgroundColor: '#000000aa',
      padding: { x: 6, y: 4 },
    });
    this.tooltipText.setDepth(200);
    this.tooltipText.setVisible(false);
    this.tooltipText.setScrollFactor(0); // fixed to screen

    // Render the hex grid
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

  setOnTileClick(fn: (tileInfo: TileClickInfo) => void): void {
    this.onTileClickFn = fn;
  }

  /** Adjust camera zoom by a delta (clamped 0.5–2). */
  adjustZoom(delta: number): void {
    const camera = this.cameras.main;
    camera.zoom = Phaser.Math.Clamp(camera.zoom + delta, 0.5, 2);
  }

  /** Apply a state update from the server. */
  applyServerState(state: ServerStateMessage, snap?: boolean): void {
    const shouldSnap = snap || this.isFirstState;

    // Update unlock state from server; re-render if changed or on snap
    const unlockedChanged = this.worldCache.updateUnlocked(state.unlocked);
    if (unlockedChanged || shouldSnap) {
      this.grid = this.buildGridFromCache();
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

    // Track current player position and zone
    this.playerCol = state.party.col;
    this.playerRow = state.party.row;
    const myTile = this.grid.getTile(offsetToCube({ col: state.party.col, row: state.party.row }));
    this.currentZone = myTile?.zone ?? '';

    // Track party members for tile modal filtering
    this.partyMemberUsernames = (state.social?.party?.members ?? []).map(m => m.username);

    // Sync other players on the map
    this.syncOtherPlayers(state.otherPlayers);

    // Draw zone overlay (needs currentZone to be set)
    this.renderZoneOverlay();

    this.isFirstState = false;
  }

  /** Center the camera on the party sprite. */
  centerOnParty(): void {
    if (this.party) {
      const sprite = this.party.getSprite();
      this.cameras.main.centerOn(sprite.x, sprite.y);
    }
  }

  // ── Grid Building ─────────────────────────────────────────

  /** Rebuild the grid from updated WorldCache data and re-render. */
  rebuildFromCache(): void {
    this.grid = this.buildGridFromCache();
    this.renderGrid();
  }

  private buildGridFromCache(): HexGrid {
    const grid = new HexGrid();
    this.worldTileDefs.clear();

    for (const tileDef of this.worldCache.getTiles()) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      const tile = new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id);
      grid.addTile(tile);
      this.worldTileDefs.set(`${tileDef.col},${tileDef.row}`, tileDef);
    }

    return grid;
  }

  // ── Other Players ────────────────────────────────────────

  private syncOtherPlayers(others: OtherPlayerState[]): void {
    this.lastOtherPlayers = others;

    // Count same-zone players per tile (ignore other zones and own party members)
    const partySet = new Set(this.partyMemberUsernames);
    const tileCounts = new Map<string, number>();
    for (const other of others) {
      if (!this.currentZone || other.zone !== this.currentZone) continue;
      if (partySet.has(other.username)) continue;
      const key = `${other.col},${other.row}`;
      tileCounts.set(key, (tileCounts.get(key) ?? 0) + 1);
    }

    // Update count badges for same-zone tiles
    const seenTiles = new Set<string>();
    for (const [key, count] of tileCounts) {
      seenTiles.add(key);
      const [col, row] = key.split(',').map(Number);
      const pixel = cubeToPixel(offsetToCube({ col, row }));
      const x = pixel.x + this.mapOffsetX;
      const y = pixel.y + this.mapOffsetY;

      let badge = this.playerCounts.get(key);
      if (badge) {
        badge.setText(`${count}`);
        badge.setPosition(x, y);
      } else {
        badge = this.add.text(x, y, `${count}`, {
          fontSize: '10px',
          fontFamily: "'Press Start 2P', monospace",
          color: '#ffffff',
          backgroundColor: PLAYER_COUNT_BADGE_COLOR,
          padding: { x: 4, y: 2 },
        });
        badge.setOrigin(0.5, 0.5);
        badge.setDepth(95);
        this.playerCounts.set(key, badge);
      }
    }

    // Remove stale count badges
    for (const [key, badge] of this.playerCounts) {
      if (!seenTiles.has(key)) {
        badge.destroy();
        this.playerCounts.delete(key);
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

      const offset = cubeToOffset(tile.coord);

      // Non-traversable tiles (mountains, water) are always darkened and never respond to unlock state
      const isNonTraversable = !tile.isTraversable;
      const isUnlocked = isNonTraversable ? false : this.worldCache.isUnlocked(offset.col, offset.row);
      const isZoneUnlocked = isNonTraversable ? false : this.worldCache.isZoneUnlocked(tile.zone);

      // Visibility: unlocked tiles are bright, zone-unlocked tiles are dimmed, foggy tiles are very dim
      // Non-traversable tiles always use the dimmed style
      const alpha = isNonTraversable ? 0.6 : isUnlocked ? 1 : isZoneUnlocked ? 0.6 : 0.3;
      const darkenFactor = isNonTraversable ? 0.7 : isUnlocked ? 1 : isZoneUnlocked ? 0.7 : 0.4;
      const color = isUnlocked ? tile.color : this.darkenColor(tile.color, darkenFactor);

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

      // Icons: non-traversable tiles always show their terrain icon,
      // traversable tiles show real type if zone unlocked, clouds if still in fog
      this.drawTileIcon(tile.type, tile.isTraversable, isNonTraversable || isZoneUnlocked, isUnlocked, x, y);
    }

    // Draw zone boundary lines
    this.renderZoneBorders();
  }

  private renderZoneOverlay(): void {
    this.zoneOverlayGraphics.clear();
    if (!this.currentZone) return;

    const corners = getHexCorners(HEX_SIZE);

    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === TileType.Void) continue;
      if (!tile.isTraversable) continue;
      if (tile.zone === this.currentZone) continue;

      const pos = tile.pixelPosition;
      const x = pos.x + this.mapOffsetX;
      const y = pos.y + this.mapOffsetY;

      this.zoneOverlayGraphics.fillStyle(0x000000, 0.4);
      this.zoneOverlayGraphics.beginPath();
      this.zoneOverlayGraphics.moveTo(x + corners[0].x, y + corners[0].y);
      for (let i = 1; i < 6; i++) {
        this.zoneOverlayGraphics.lineTo(x + corners[i].x, y + corners[i].y);
      }
      this.zoneOverlayGraphics.closePath();
      this.zoneOverlayGraphics.fillPath();
    }
  }

  private darkenColor(color: number, factor: number): number {
    const r = Math.floor(((color >> 16) & 0xff) * factor);
    const g = Math.floor(((color >> 8) & 0xff) * factor);
    const b = Math.floor((color & 0xff) * factor);
    return (r << 16) | (g << 8) | b;
  }

  private renderZoneBorders(): void {
    this.zoneBorderGraphics.clear();
    const corners = getHexCorners(HEX_SIZE);

    const EDGE_CORNERS: [number, number][] = [
      [0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2],
    ];

    const processed = new Set<string>();

    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === TileType.Void) continue;

      const neighbors = getNeighbors(tile.coord);
      for (let dir = 0; dir < 6; dir++) {
        const neighborTile = this.grid.getTile(neighbors[dir]);

        if (!neighborTile) continue;
        if (neighborTile.zone === tile.zone) continue;

        const edgeKey = tile.key < neighborTile.key
          ? `${tile.key}|${neighborTile.key}`
          : `${neighborTile.key}|${tile.key}`;
        if (processed.has(edgeKey)) continue;
        processed.add(edgeKey);

        const pos = tile.pixelPosition;
        const x = pos.x + this.mapOffsetX;
        const y = pos.y + this.mapOffsetY;

        const [ci1, ci2] = EDGE_CORNERS[dir];
        const c1 = corners[ci1];
        const c2 = corners[ci2];

        this.zoneBorderGraphics.lineStyle(4, 0xffaa00, 0.3);
        this.zoneBorderGraphics.beginPath();
        this.zoneBorderGraphics.moveTo(x + c1.x, y + c1.y);
        this.zoneBorderGraphics.lineTo(x + c2.x, y + c2.y);
        this.zoneBorderGraphics.strokePath();

        this.zoneBorderGraphics.lineStyle(2, 0xffcc44, 0.7);
        this.zoneBorderGraphics.beginPath();
        this.zoneBorderGraphics.moveTo(x + c1.x, y + c1.y);
        this.zoneBorderGraphics.lineTo(x + c2.x, y + c2.y);
        this.zoneBorderGraphics.strokePath();
      }
    }
  }

  private drawTileIcon(
    type: TileType,
    isTraversable: boolean,
    isZoneUnlocked: boolean,
    isUnlocked: boolean,
    x: number,
    y: number,
  ): void {
    let icon = '';

    if (!isZoneUnlocked) {
      // Zone not unlocked — show cloud icons
      icon = isTraversable ? '☁️' : '🌑';
    } else {
      // Zone unlocked — show real tile type
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
    }

    if (icon) {
      const text = this.add.text(x, y, icon, { fontSize: '20px' });
      text.setOrigin(0.5);
      text.setDepth(10);
      text.setAlpha(isUnlocked ? 1 : isZoneUnlocked ? 0.5 : 0.4);
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

    const offset = cubeToOffset(cubeCoord);
    const worldTileDef = this.worldTileDefs.get(`${offset.col},${offset.row}`);
    const isUnlocked = this.worldCache.isUnlocked(offset.col, offset.row);
    const isSameZone = tile.zone === this.currentZone;
    const isCurrentTile = offset.col === this.playerCol && offset.row === this.playerRow;

    // Zone display name from world tile def
    const zoneName = worldTileDef?.zoneName ?? worldTileDef?.zone ?? tile.zone;
    // Room name: actual name if unlocked, "Unexplored Room" if not unlocked (non-traversable excluded)
    const roomName = isUnlocked && worldTileDef?.name
      ? worldTileDef.name
      : (!isUnlocked && tile.isTraversable) ? 'Unexplored Room' : '';

    // Find players on this tile (only visible in same zone)
    const playersHere = isSameZone
      ? this.lastOtherPlayers
        .filter(p => p.col === offset.col && p.row === offset.row)
        .map(p => ({ username: p.username, className: p.className }))
      : [];

    if (this.onTileClickFn) {
      this.onTileClickFn({
        col: offset.col,
        row: offset.row,
        tileType: tile.type === TileType.Town ? 'Town'
          : tile.type === TileType.Forest ? 'Forest'
          : tile.type === TileType.Plains ? 'Plains'
          : tile.type === TileType.Dungeon ? 'Dungeon'
          : 'Unknown',
        zoneName,
        roomName,
        zoneId: tile.zone,
        isTraversable: tile.isTraversable,
        isUnlocked,
        isSameZone,
        isCurrentTile,
        playersHere,
        partyMemberUsernames: this.partyMemberUsernames,
      });
    } else {
      this.sendMoveFn?.(offset.col, offset.row);
    }
  }

  private handleHover(pointer: Phaser.Input.Pointer): void {
    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const adjustedX = worldPoint.x - this.mapOffsetX;
    const adjustedY = worldPoint.y - this.mapOffsetY;

    const cubeCoord = pixelToCube({ x: adjustedX, y: adjustedY });
    const tile = this.grid.getTile(cubeCoord);

    this.highlightGraphics.clear();

    if (!tile) {
      this.tooltipText?.setVisible(false);
      return;
    }

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

    // Tooltip shows zone name only on hover
    this.updateTooltip(tile, pointer);
  }

  private updateTooltip(tile: HexTile, pointer: Phaser.Input.Pointer): void {
    if (!this.tooltipText) return;

    // Non-traversable tiles always show their terrain type name
    if (!tile.isTraversable) {
      const typeLabel = tile.type === TileType.Mountain ? 'Mountain'
        : tile.type === TileType.Water ? 'Water'
        : tile.type.charAt(0).toUpperCase() + tile.type.slice(1);
      this.tooltipText.setText(typeLabel);
      this.tooltipText.setPosition(pointer.x + 12, pointer.y - 20);
      this.tooltipText.setVisible(true);
      return;
    }

    const offset = cubeToOffset(tile.coord);
    const worldTileDef = this.worldTileDefs.get(`${offset.col},${offset.row}`);
    const zoneName = worldTileDef?.zoneName ?? worldTileDef?.zone ?? tile.zone;
    const isSameZone = tile.zone === this.currentZone;

    let label = zoneName;
    if (isSameZone) {
      const isUnlocked = this.worldCache.isUnlocked(offset.col, offset.row);
      if (isUnlocked && worldTileDef?.name) {
        label = `${zoneName}\n${worldTileDef.name}`;
      } else {
        label = `${zoneName}\nUndiscovered`;
      }
    }

    this.tooltipText.setText(label);
    this.tooltipText.setPosition(pointer.x + 12, pointer.y - 20);
    this.tooltipText.setVisible(true);
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
