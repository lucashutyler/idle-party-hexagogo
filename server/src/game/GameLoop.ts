import { generateWorldMap } from '@idle-party-rpg/shared';
import { PlayerManager } from './PlayerManager';

export class GameLoop {
  readonly playerManager: PlayerManager;

  constructor() {
    const grid = generateWorldMap();
    this.playerManager = new PlayerManager(grid);

    console.log(`Game loop started. Map: ${grid.size} tiles`);
  }
}
