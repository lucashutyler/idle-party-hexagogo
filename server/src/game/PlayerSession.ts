import {
  HexGrid,
  HexTile,
  UnlockSystem,
  getStartingPosition,
  offsetToCube,
  createDefaultCharacter,
  addXp,
  addGold,
  calculateMaxHp,
  xpForNextLevel,
  MONSTERS,
  ITEMS,
  computeEquipmentBonuses,
  rollDrops,
  addItemToInventory,
  equipItem,
  unequipItem,
  EQUIP_SLOTS,
  getZone,
} from '@idle-party-rpg/shared';
import type {
  ServerStateMessage,
  ServerBattleState,
  ServerPartyState,
  OtherPlayerState,
  CombatLogEntry,
  CharacterState,
  StatName,
  PartyCombatState,
  PartyCombatant,
  ClientCharacterState,
  EquipSlot,
  ClientSocialState,
  BlockLevel,
  ChatMessage,
  PartyGridPosition,
  FriendRequest,
} from '@idle-party-rpg/shared';
import type { PlayerSaveData } from './GameStateStore.js';

const MAX_LOG_ENTRIES = 100;
const MAX_SAVE_LOG_ENTRIES = 1000;
const MAX_CHAT_HISTORY = 1000;

export class PlayerSession {
  username: string;
  private grid: HexGrid;
  private unlockSystem: UnlockSystem;
  private combatLog: CombatLogEntry[] = [];
  private battleCount = 0;
  private character: CharacterState;
  private chatHistory: ChatMessage[] = [];
  private friends: string[] = [];
  private outgoingFriendRequests: FriendRequest[] = [];
  private blockedUsers: Record<string, BlockLevel> = {};
  private guildId: string | null = null;
  private partyId: string | null = null;

  /** Callback to get social state — set by PlayerManager after construction. */
  getSocialState?: () => ClientSocialState;

  /** Callback to get battle state — set by PlayerManager. */
  getBattleState?: () => ServerBattleState | null;

  /** Callback to get party movement state — set by PlayerManager. */
  getPartyPositionState?: () => ServerPartyState | null;

  /** Callback to get zone — set by PlayerManager. */
  getPartyZone?: () => string | null;

  /** Callback to get position — set by PlayerManager. */
  getPartyPosition?: () => { col: number; row: number } | null;

  constructor(username: string, grid: HexGrid) {
    this.username = username;
    this.grid = grid;

    const startPos = getStartingPosition();
    const startCoord = offsetToCube(startPos);
    const startTile = this.grid.getTile(startCoord);

    if (!startTile) {
      throw new Error('Invalid starting position');
    }

    this.character = createDefaultCharacter();
    this.unlockSystem = new UnlockSystem(this.grid, startTile);
  }

  /** Get combat info for the party combat system. */
  getCombatInfo(): PartyCombatant {
    const maxHp = calculateMaxHp(this.character.level, this.character.stats.CON);
    const equipBonuses = computeEquipmentBonuses(this.character.equipment);

    // Get grid position from party info via social state
    let gridPosition: PartyGridPosition = 4;
    const social = this.getSocialState?.();
    if (social?.party) {
      const member = social.party.members.find(m => m.username === this.username);
      if (member) gridPosition = member.gridPosition;
    }

    return {
      username: this.username,
      maxHp,
      currentHp: maxHp,
      stats: { ...this.character.stats },
      equipBonuses,
      gridPosition,
    };
  }

  /** Handle victory rewards (called by PartyBattleManager). */
  handleVictory(combat: PartyCombatState | null, tile: HexTile): void {
    this.addLogEntry('Victory!', 'victory');

    const unlocked = this.unlockSystem.unlockAdjacentTiles(tile);
    if (unlocked.length > 0) {
      this.addLogEntry(`${unlocked.length} new room${unlocked.length > 1 ? 's' : ''} unlocked!`, 'unlock');
    }

    // Award XP based on monsters defeated
    const xpGained = combat
      ? combat.monsters.reduce((sum, m) => sum + m.xp, 0)
      : 10;

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
  }

  /** Check if a tile is unlocked for this player. */
  isTileUnlocked(tile: HexTile): boolean {
    return this.unlockSystem.isUnlocked(tile);
  }

  incrementBattleCount(): void {
    this.battleCount++;
  }

  setPriorityStat(stat: StatName | null): void {
    this.character.priorityStat = stat;
  }

  getState(otherPlayers: OtherPlayerState[]): Omit<ServerStateMessage, 'type'> {
    const battleState = this.getBattleState?.();
    const partyState = this.getPartyPositionState?.();
    const partyZone = this.getPartyZone?.();

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

    const zone = partyZone ? getZone(partyZone) : null;
    const zoneName = zone ? zone.displayName : (partyZone ?? 'Unknown');

    return {
      username: this.username,
      party: partyState ?? { col: 0, row: 0, state: 'idle', path: [] },
      battle: battleState ?? { state: 'battle', visual: 'none', duration: 0 },
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
    return this.getPartyPosition?.() ?? { col: 0, row: 0 };
  }

  getZone(): string {
    return this.getPartyZone?.() ?? 'friendly_forest';
  }

  // ── Social Accessors ──────────────────────────────────────

  getFriends(): string[] { return this.friends; }
  setFriends(friends: string[]): void { this.friends = friends; }

  getOutgoingFriendRequests(): FriendRequest[] { return this.outgoingFriendRequests; }
  setOutgoingFriendRequests(requests: FriendRequest[]): void { this.outgoingFriendRequests = requests; }

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

  getStartingTile(): HexTile {
    const startPos = getStartingPosition();
    const startCoord = offsetToCube(startPos);
    const tile = this.grid.getTile(startCoord);
    if (!tile) throw new Error('Invalid starting position');
    return tile;
  }

  getUnlockedKeys(): string[] {
    return this.unlockSystem.getUnlockedKeys();
  }

  toSaveData(movementData?: {
    position: { col: number; row: number };
    target: { col: number; row: number } | null;
    movementQueue: { col: number; row: number }[];
  }, partyInfo?: {
    role: 'owner' | 'leader' | 'member';
    gridPosition: number;
  }): PlayerSaveData {
    const pos = movementData?.position ?? this.getPosition();

    return {
      username: this.username,
      battleCount: this.battleCount,
      combatLog: this.combatLog.slice(-MAX_SAVE_LOG_ENTRIES),
      unlockedKeys: this.unlockSystem.getUnlockedKeys(),
      position: { col: pos.col, row: pos.row },
      target: movementData?.target ?? null,
      movementQueue: movementData?.movementQueue ?? [],
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
      outgoingFriendRequests: [...this.outgoingFriendRequests],
      blockedUsers: { ...this.blockedUsers },
      guildId: this.guildId,
      partyId: this.partyId,
      partyRole: partyInfo?.role,
      partyGridPosition: partyInfo?.gridPosition,
      chatHistory: this.chatHistory.slice(-MAX_CHAT_HISTORY),
    };
  }

  /**
   * Restore a PlayerSession from saved data.
   * Battle timer is NOT started here — PartyBattleManager handles that.
   */
  static fromSaveData(
    data: PlayerSaveData,
    grid: HexGrid,
  ): PlayerSession {
    // Build session via Object.create to bypass constructor
    const session = Object.create(PlayerSession.prototype) as PlayerSession;
    (session as { username: string }).username = data.username;
    session['grid'] = grid;
    session['battleCount'] = data.battleCount;
    session['combatLog'] = data.combatLog.slice(-MAX_LOG_ENTRIES);
    session['unlockSystem'] = UnlockSystem.fromKeys(grid, data.unlockedKeys);

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
    session['outgoingFriendRequests'] = data.outgoingFriendRequests ? [...data.outgoingFriendRequests] : [];
    session['blockedUsers'] = data.blockedUsers ? { ...data.blockedUsers } : {};
    session['guildId'] = data.guildId ?? null;
    session['partyId'] = null; // Parties are transient, not restored across restarts
    session['chatHistory'] = data.chatHistory ? [...data.chatHistory] : [];

    // Add server-online log entry
    session['addLogEntry']('Server back online — resuming!', 'battle');

    return session;
  }

  handleEquipItem(itemId: string): boolean {
    const def = ITEMS[itemId];
    if (!def || !def.equipSlot) return false;

    const result = equipItem(this.character.inventory, this.character.equipment, itemId);
    return result.success;
  }

  handleUnequipItem(slot: EquipSlot): boolean {
    if (!EQUIP_SLOTS.includes(slot)) return false;

    const result = unequipItem(this.character.inventory, this.character.equipment, slot);
    return result.success;
  }
}
