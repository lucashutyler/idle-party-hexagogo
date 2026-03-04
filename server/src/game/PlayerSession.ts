import {
  HexGrid,
  UnlockSystem,
  getStartingPosition,
  offsetToCube,
  cubeToOffset,
  createDefaultCharacter,
  addXp,
  addGold,
  calculateMaxHp,
  xpForNextLevel,
  XP_PER_VICTORY,
  MONSTERS,
  ITEMS,
  createCombatState,
  createEncounter,
  getZone,
  computeEquipmentBonuses,
  rollDrops,
  addItemToInventory,
  equipItem,
  unequipItem,
  EQUIP_SLOTS,
} from '@idle-party-rpg/shared';
import type {
  BattleResult,
  ServerStateMessage,
  OtherPlayerState,
  CombatLogEntry,
  CharacterState,
  StatName,
  CombatState,
  ClientCharacterState,
  ClientCombatState,
  EquipSlot,
  ClientSocialState,
  BlockLevel,
  ChatMessage,
} from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty.js';
import { ServerBattleTimer } from './ServerBattleTimer.js';
import type { ServerBattleCallbacks } from './ServerBattleTimer.js';
import type { PlayerSaveData } from './GameStateStore.js';

const MAX_LOG_ENTRIES = 100;
const MAX_SAVE_LOG_ENTRIES = 1000;
const MAX_CHAT_HISTORY = 1000;

export class PlayerSession {
  username: string;
  private grid: HexGrid;
  private party: ServerParty;
  private battleTimer: ServerBattleTimer;
  private unlockSystem: UnlockSystem;
  private combatLog: CombatLogEntry[] = [];
  private battleCount = 0;
  private character: CharacterState;
  private chatHistory: ChatMessage[] = [];
  private friends: string[] = [];
  private blockedUsers: Record<string, BlockLevel> = {};
  private guildId: string | null = null;
  private partyId: string | null = null;

  private broadcastToPlayer: () => void;

  /** Callback to get social state — set by PlayerManager after construction. */
  getSocialState?: () => ClientSocialState;

  /** Callback to share XP/loot with party members on victory. Set by PlayerManager. */
  onShareVictoryWithParty?: (xpGained: number, goldGained: number, drops: string[]) => void;

  constructor(username: string, grid: HexGrid, broadcastToPlayer: () => void) {
    this.username = username;
    this.grid = grid;
    this.broadcastToPlayer = broadcastToPlayer;

    const startPos = getStartingPosition();
    const startCoord = offsetToCube(startPos);
    const startTile = this.grid.getTile(startCoord);

    if (!startTile) {
      throw new Error('Invalid starting position');
    }

    this.character = createDefaultCharacter();
    this.unlockSystem = new UnlockSystem(this.grid, startTile);
    this.party = new ServerParty(this.grid, startTile);

    this.battleTimer = new ServerBattleTimer(
      this.party,
      () => this.createCombat(),
      this.createBattleCallbacks(),
    );
  }

  private createCombat(): CombatState {
    const maxHp = calculateMaxHp(this.character.level, this.character.stats.CON);
    const equipBonuses = computeEquipmentBonuses(this.character.equipment);
    return createCombatState(
      this.username,
      this.character.level,
      this.character.stats,
      maxHp,
      createEncounter(this.party.tile.zone),
      equipBonuses,
    );
  }

  private createBattleCallbacks(): ServerBattleCallbacks {
    return {
      onBattleStart: () => {
        this.battleCount++;
        this.addLogEntry('Battle begins!', 'battle');
      },
      onStateChange: () => {
        this.broadcastToPlayer();
      },
      onCombatTick: (_state: CombatState, logEntries: string[]) => {
        for (const entry of logEntries) {
          this.addLogEntry(entry, 'damage');
        }
        this.broadcastToPlayer();
      },
      onBattleEnd: (result: BattleResult) => {
        if (result === 'victory') {
          this.addLogEntry('Victory!', 'victory');
          const unlocked = this.unlockSystem.unlockAdjacentTiles(this.party.tile);
          if (unlocked.length > 0) {
            this.addLogEntry(`${unlocked.length} new room${unlocked.length > 1 ? 's' : ''} unlocked!`, 'unlock');
          }
          // Award XP based on monsters defeated
          const combat = this.battleTimer.currentCombat;
          const xpGained = combat
            ? combat.monsters.reduce((sum, m) => sum + m.xp, 0)
            : XP_PER_VICTORY;
          // Award gold based on monsters defeated
          let goldGained = 0;
          if (combat) {
            for (const m of combat.monsters) {
              const def = MONSTERS[m.id];
              if (def) {
                goldGained += def.goldMin + Math.floor(Math.random() * (def.goldMax - def.goldMin + 1));
              }
            }
          }
          if (goldGained > 0) {
            addGold(this.character, goldGained);
            this.addLogEntry(`+${goldGained} Gold`, 'victory');
          }

          // Roll item drops per monster
          if (combat) {
            for (const m of combat.monsters) {
              const def = MONSTERS[m.id];
              if (def?.drops) {
                const dropped = rollDrops(def.drops);
                for (const itemId of dropped) {
                  const itemDef = ITEMS[itemId];
                  if (itemDef && addItemToInventory(this.character.inventory, itemId)) {
                    this.addLogEntry(`Found ${itemDef.name}!`, 'victory');
                  }
                }
              }
            }
          }

          const { leveledUp, levelsGained } = addXp(this.character, xpGained);
          this.addLogEntry(`+${xpGained} XP`, 'victory');
          if (leveledUp) {
            for (let i = 0; i < levelsGained; i++) {
              this.addLogEntry(`Level up! Now level ${this.character.level - levelsGained + i + 1}!`, 'levelup');
            }
          }

          // Share with party members
          if (this.onShareVictoryWithParty) {
            const droppedItems: string[] = [];
            if (combat) {
              for (const m of combat.monsters) {
                const def = MONSTERS[m.id];
                if (def?.drops) {
                  const dropped = rollDrops(def.drops);
                  droppedItems.push(...dropped);
                }
              }
            }
            this.onShareVictoryWithParty(xpGained, goldGained, droppedItems);
          }
        } else {
          this.addLogEntry('Defeat...', 'defeat');
        }
        this.broadcastToPlayer();
      },
      onMove: () => {
        const pos = this.getPosition();
        const zone = getZone(this.party.tile.zone);
        const zName = zone ? zone.displayName : this.party.tile.zone;
        this.addLogEntry(`Moved to ${zName} (${pos.col}, ${pos.row})`, 'move');
      },
      canMoveToNextTile: () => {
        const nextTile = this.party.nextTile;
        return nextTile ? this.unlockSystem.isUnlocked(nextTile) : false;
      },
    };
  }

  /** Receive shared XP/loot from a party member's victory. */
  receivePartyShare(xpGained: number, goldGained: number, drops: string[]): void {
    this.addLogEntry('Party member won a battle!', 'victory');

    if (goldGained > 0) {
      addGold(this.character, goldGained);
      this.addLogEntry(`+${goldGained} Gold (shared)`, 'victory');
    }

    for (const itemId of drops) {
      const itemDef = ITEMS[itemId];
      if (itemDef && addItemToInventory(this.character.inventory, itemId)) {
        this.addLogEntry(`Found ${itemDef.name}! (shared)`, 'victory');
      }
    }

    const { leveledUp, levelsGained } = addXp(this.character, xpGained);
    this.addLogEntry(`+${xpGained} XP (shared)`, 'victory');
    if (leveledUp) {
      for (let i = 0; i < levelsGained; i++) {
        this.addLogEntry(`Level up! Now level ${this.character.level - levelsGained + i + 1}!`, 'levelup');
      }
    }

    this.broadcastToPlayer();
  }

  handleMove(col: number, row: number): boolean {
    const coord = offsetToCube({ col, row });
    const tile = this.grid.getTile(coord);

    if (!tile || !tile.isTraversable) {
      return false;
    }

    const success = this.party.setDestination(tile);
    this.broadcastToPlayer();
    return success;
  }

  setPriorityStat(stat: StatName | null): void {
    this.character.priorityStat = stat;
    this.broadcastToPlayer();
  }

  getState(otherPlayers: OtherPlayerState[]): Omit<ServerStateMessage, 'type'> {
    const combat = this.battleTimer.currentCombat;
    const clientCombat: ClientCombatState | undefined = combat ? {
      playerHp: combat.player.currentHp,
      playerMaxHp: combat.player.maxHp,
      monsters: combat.monsters.map(m => ({
        name: m.name,
        currentHp: m.currentHp,
        maxHp: m.maxHp,
        level: m.level,
      })),
      tickCount: combat.tickCount,
    } : undefined;

    const charState: ClientCharacterState = {
      className: this.character.className,
      level: this.character.level,
      xp: this.character.xp,
      xpForNextLevel: xpForNextLevel(this.character.level),
      maxHp: calculateMaxHp(this.character.level, this.character.stats.CON),
      gold: this.character.gold,
      stats: { ...this.character.stats },
      priorityStat: this.character.priorityStat,
      inventory: { ...this.character.inventory },
      equipment: { ...this.character.equipment },
    };

    const zone = getZone(this.party.tile.zone);
    const zoneName = zone ? zone.displayName : this.party.tile.zone;

    return {
      username: this.username,
      party: this.party.toJSON(),
      battle: {
        state: this.battleTimer.currentState,
        result: this.battleTimer.lastResult,
        visual: this.battleTimer.visual,
        duration: this.battleTimer.currentDuration,
        combat: clientCombat,
      },
      unlocked: this.unlockSystem.getUnlockedKeys(),
      mapSize: this.grid.size,
      otherPlayers,
      combatLog: this.combatLog,
      battleCount: this.battleCount,
      character: charState,
      zoneName,
      social: this.getSocialState?.(),
    };
  }

  getPosition(): { col: number; row: number } {
    return cubeToOffset(this.party.position);
  }

  getZone(): string {
    return this.party.tile.zone;
  }

  // ── Social Accessors ──────────────────────────────────────

  getFriends(): string[] { return this.friends; }
  setFriends(friends: string[]): void { this.friends = friends; }

  getBlockedUsers(): Record<string, BlockLevel> { return this.blockedUsers; }
  setBlockedUsers(blocked: Record<string, BlockLevel>): void { this.blockedUsers = blocked; }

  getGuildId(): string | null { return this.guildId; }
  setGuildId(id: string | null): void { this.guildId = id; }

  getPartyId(): string | null { return this.partyId; }
  setPartyId(id: string | null): void { this.partyId = id; }

  /** Store a chat message in this player's personal history. */
  addChatMessage(message: ChatMessage): void {
    this.chatHistory.push(message);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY);
    }
  }

  /** Get chat history, optionally filtered by channel type. */
  getChatHistory(channelType?: string, channelId?: string): ChatMessage[] {
    if (!channelType) return this.chatHistory;
    return this.chatHistory.filter(m => {
      if (m.channelType !== channelType) return false;
      if (channelId !== undefined && m.channelId !== channelId) return false;
      return true;
    });
  }

  getLevel(): number { return this.character.level; }

  addLogEntry(text: string, type: CombatLogEntry['type']): void {
    this.combatLog.push({ text, type });
    if (this.combatLog.length > MAX_LOG_ENTRIES) {
      this.combatLog.shift();
    }
  }

  toSaveData(): PlayerSaveData {
    const pos = this.getPosition();
    const partyJSON = this.party.toJSON();

    return {
      username: this.username,
      battleCount: this.battleCount,
      combatLog: this.combatLog.slice(-MAX_SAVE_LOG_ENTRIES),
      unlockedKeys: this.unlockSystem.getUnlockedKeys(),
      position: { col: pos.col, row: pos.row },
      target: partyJSON.targetCol !== undefined && partyJSON.targetRow !== undefined
        ? { col: partyJSON.targetCol, row: partyJSON.targetRow }
        : null,
      movementQueue: partyJSON.path,
      character: {
        className: this.character.className,
        level: this.character.level,
        xp: this.character.xp,
        gold: this.character.gold,
        stats: { ...this.character.stats },
        priorityStat: this.character.priorityStat,
        inventory: { ...this.character.inventory },
        equipment: { ...this.character.equipment },
      },
      friends: [...this.friends],
      blockedUsers: { ...this.blockedUsers },
      guildId: this.guildId,
      chatHistory: this.chatHistory.slice(-MAX_CHAT_HISTORY),
    };
  }

  /**
   * Restore a PlayerSession from saved data.
   * Battle timer starts fresh; a "Server back online" log entry is added.
   */
  static fromSaveData(
    data: PlayerSaveData,
    grid: HexGrid,
    broadcastToPlayer: () => void,
  ): PlayerSession {
    const coord = offsetToCube(data.position);
    const currentTile = grid.getTile(coord);
    if (!currentTile) {
      throw new Error(`Invalid saved position for "${data.username}": (${data.position.col}, ${data.position.row})`);
    }

    // Resolve target tile
    let targetTile = null;
    if (data.target) {
      const targetCoord = offsetToCube(data.target);
      targetTile = grid.getTile(targetCoord) ?? null;
    }

    // Resolve movement queue
    const movementQueue = data.movementQueue
      .map(p => grid.getTile(offsetToCube(p)))
      .filter((t): t is NonNullable<typeof t> => t !== null);

    // Build session via Object.create to bypass constructor
    const session = Object.create(PlayerSession.prototype) as PlayerSession;
    (session as { username: string }).username = data.username;
    session['grid'] = grid;
    session['broadcastToPlayer'] = broadcastToPlayer;
    session['battleCount'] = data.battleCount;
    session['combatLog'] = data.combatLog.slice(-MAX_LOG_ENTRIES);
    session['unlockSystem'] = UnlockSystem.fromKeys(grid, data.unlockedKeys);
    session['party'] = ServerParty.restore(grid, currentTile, targetTile, movementQueue);

    // Restore character (default to fresh character for old saves)
    if (data.character) {
      session['character'] = {
        className: data.character.className as 'Adventurer',
        level: data.character.level,
        xp: data.character.xp,
        gold: data.character.gold ?? 0,
        stats: { ...data.character.stats },
        priorityStat: data.character.priorityStat,
        inventory: data.character.inventory ? { ...data.character.inventory } : {},
        equipment: data.character.equipment
          ? { ...data.character.equipment }
          : { head: null, chest: null, hand: null, foot: null },
      };
    } else {
      session['character'] = createDefaultCharacter();
    }

    // Restore social state
    session['friends'] = data.friends ? [...data.friends] : [];
    session['blockedUsers'] = data.blockedUsers ? { ...data.blockedUsers } : {};
    session['guildId'] = data.guildId ?? null;
    session['partyId'] = null; // Parties are transient, not restored across restarts
    session['chatHistory'] = data.chatHistory ? [...data.chatHistory] : [];

    // Add server-online log entry
    session['addLogEntry']('Server back online — resuming!', 'battle');

    // Start battle timer fresh (no resume of previous battle state)
    session['battleTimer'] = new ServerBattleTimer(
      session['party'],
      () => session['createCombat'](),
      session['createBattleCallbacks'](),
    );

    return session;
  }

  handleEquipItem(itemId: string): boolean {
    const def = ITEMS[itemId];
    if (!def || !def.equipSlot) return false;

    const result = equipItem(this.character.inventory, this.character.equipment, itemId);
    if (result.success) {
      this.broadcastToPlayer();
    }
    return result.success;
  }

  handleUnequipItem(slot: EquipSlot): boolean {
    if (!EQUIP_SLOTS.includes(slot)) return false;

    const result = unequipItem(this.character.inventory, this.character.equipment, slot);
    if (result.success) {
      this.broadcastToPlayer();
    }
    return result.success;
  }

  destroy(): void {
    this.battleTimer.destroy();
  }
}
