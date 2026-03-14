import {
  HexGrid,
  HexTile,
  UnlockSystem,
  offsetToCube,
  createDefaultCharacter,
  createCharacter,
  ALL_CLASS_NAMES,
  addXp,
  addGold,
  calculateMaxHp,
  xpForNextLevel,
  computeEquipmentBonuses,
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
  ClassName,
  StatName,
  PartyCombatant,
  ClientCharacterState,
  EquipSlot,
  ClientSocialState,
  BlockLevel,
  ChatMessage,
  PartyGridPosition,
  FriendRequest,
  ChatChannelType,
  ItemDefinition,
} from '@idle-party-rpg/shared';
import type { PlayerSaveData } from './GameStateStore.js';
import type { ContentStore } from './ContentStore.js';

const MAX_LOG_ENTRIES = 100;
const MAX_SAVE_LOG_ENTRIES = 1000;
const MAX_CHAT_HISTORY = 1000;

export class PlayerSession {
  username: string;
  private grid: HexGrid;
  private content: ContentStore;
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
  private chatSendChannel: ChatChannelType = 'zone';
  private chatDmTarget = '';

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

  constructor(username: string, grid: HexGrid, content: ContentStore) {
    this.username = username;
    this.grid = grid;
    this.content = content;

    const startPos = content.getStartTile();
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
    const maxHp = calculateMaxHp(this.character.level, this.character.stats.CON, this.character.className);
    const equipBonuses = computeEquipmentBonuses(this.character.equipment, this.content.getAllItems());

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
      className: this.character.className,
      level: this.character.level,
    };
  }

  /** Handle victory rewards (called by PartyBattleManager with pre-split rewards). */
  handleVictory(rewards: { xp: number; gold: number; items: string[] }, tile: HexTile): void {
    this.addLogEntry('Victory!', 'victory');

    const unlocked = this.unlockSystem.unlockAdjacentTiles(tile);
    if (unlocked.length > 0) {
      this.addLogEntry(`${unlocked.length} new room${unlocked.length > 1 ? 's' : ''} unlocked!`, 'unlock');
    }

    if (rewards.gold > 0) {
      addGold(this.character, rewards.gold);
      this.addLogEntry(`+${rewards.gold} Gold`, 'victory');
    }

    for (const itemId of rewards.items) {
      const itemDef = this.content.getItem(itemId);
      if (itemDef && addItemToInventory(this.character.inventory, itemId)) {
        this.addLogEntry(`Found ${itemDef.name}!`, 'victory');
      }
    }

    const { leveledUp, levelsGained } = addXp(this.character, rewards.xp);
    this.addLogEntry(`+${rewards.xp} XP`, 'victory');
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

  /**
   * Get all world tiles with zone display names populated.
   * Client determines fog of war rendering using state.unlocked.
   */
  getWorldData(): {
    startTile: { col: number; row: number };
    tiles: import('@idle-party-rpg/shared').WorldTileDefinition[];
  } {
    const world = this.content.getWorld();
    const allZones = this.content.getAllZones();

    return {
      startTile: world.startTile,
      tiles: world.tiles.map(wt => {
        const zone = getZone(wt.zone, allZones);
        return { ...wt, zoneName: zone?.displayName ?? wt.zone };
      }),
    };
  }

  /** Build item definitions for items the player currently owns (inventory + equipment). */
  private getOwnedItemDefinitions(): Record<string, ItemDefinition> {
    const defs: Record<string, ItemDefinition> = {};

    // Inventory items
    for (const itemId of Object.keys(this.character.inventory)) {
      const def = this.content.getItem(itemId);
      if (def) defs[itemId] = def;
    }

    // Equipment items
    for (const itemId of Object.values(this.character.equipment)) {
      if (itemId) {
        const def = this.content.getItem(itemId);
        if (def) defs[itemId] = def;
      }
    }

    return defs;
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
      maxHp: calculateMaxHp(this.character.level, this.character.stats.CON, this.character.className),
      gold: this.character.gold,
      stats: { ...this.character.stats },
      priorityStat: this.character.priorityStat,
      inventory: { ...this.character.inventory },
      equipment: { ...this.character.equipment },
    };

    const allZones = this.content.getAllZones();
    const zone = partyZone ? getZone(partyZone, allZones) : null;
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
      itemDefinitions: this.getOwnedItemDefinitions(),
    };
  }

  getPosition(): { col: number; row: number } {
    return this.getPartyPosition?.() ?? { col: 0, row: 0 };
  }

  getZone(): string {
    return this.getPartyZone?.() ?? 'hatchetmill';
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

  getChatSendChannel(): ChatChannelType { return this.chatSendChannel; }
  setChatSendChannel(channel: ChatChannelType): void { this.chatSendChannel = channel; }
  getChatDmTarget(): string { return this.chatDmTarget; }
  setChatDmTarget(target: string): void { this.chatDmTarget = target; }

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

  getClassName(): ClassName { return this.character.className; }

  /** Set class for a new character. Only works if className is still Adventurer. */
  setClass(className: ClassName): boolean {
    if (this.character.className !== 'Adventurer') return false;
    this.character = createCharacter(className);
    return true;
  }

  addLogEntry(text: string, type: CombatLogEntry['type']): void {
    this.combatLog.push({ text, type });
    if (this.combatLog.length > MAX_LOG_ENTRIES) {
      this.combatLog.shift();
    }
  }

  /** Force-unlock a tile and its adjacent tiles (for relocation after deploy). */
  forceUnlockTileArea(tile: HexTile): void {
    this.unlockSystem.forceUnlock(tile);
    const neighbors = this.grid.getTraversableNeighbors(tile.coord);
    for (const neighbor of neighbors) {
      this.unlockSystem.forceUnlock(neighbor);
    }
  }

  /**
   * Master reset: reset character to level 1 with 0 XP (keeping class),
   * clear inventory/equipment, move to start tile, reset unlocks and combat log.
   */
  resetForMasterReset(startTile: HexTile): void {
    const className = this.character.className;
    // Keep the chosen class, but if still Adventurer, stay Adventurer
    if (className === 'Adventurer') {
      this.character = createDefaultCharacter();
    } else {
      this.character = createCharacter(className);
    }

    this.battleCount = 0;
    this.combatLog = [];
    this.unlockSystem = new UnlockSystem(this.grid, startTile);
    this.partyId = null;

    this.addLogEntry('The world has been reset! Starting fresh...', 'battle');
  }

  getStartingTile(): HexTile {
    const startPos = this.content.getStartTile();
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
      chatSendChannel: this.chatSendChannel,
      chatDmTarget: this.chatDmTarget,
    };
  }

  /**
   * Restore a PlayerSession from saved data.
   * Battle timer is NOT started here — PartyBattleManager handles that.
   */
  static fromSaveData(
    data: PlayerSaveData,
    grid: HexGrid,
    content: ContentStore,
  ): PlayerSession {
    // Build session via Object.create to bypass constructor
    const session = Object.create(PlayerSession.prototype) as PlayerSession;
    (session as { username: string }).username = data.username;
    session['grid'] = grid;
    session['content'] = content;
    session['battleCount'] = data.battleCount;
    session['combatLog'] = data.combatLog.slice(-MAX_LOG_ENTRIES);
    // Migrate old cube-key-based unlocks ("q,r,s") to tile GUIDs
    let unlockedKeys = data.unlockedKeys;
    if (unlockedKeys.length > 0 && unlockedKeys[0].split(',').length === 3) {
      // Old format: cube coordinate keys — map to tile GUIDs via grid lookup
      const migrated: string[] = [];
      for (const cubeKey of unlockedKeys) {
        const tile = grid.getTileByKey(cubeKey);
        if (tile) migrated.push(tile.id);
      }
      unlockedKeys = migrated;
    }
    session['unlockSystem'] = UnlockSystem.fromKeys(grid, unlockedKeys);

    // Restore character — reset to fresh Adventurer if class is invalid/legacy
    const savedClassName = data.character?.className;
    const isValidClass = savedClassName && ALL_CLASS_NAMES.includes(savedClassName as ClassName);

    if (data.character && isValidClass) {
      session['character'] = {
        className: savedClassName as ClassName,
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
      // Invalid or legacy class — reset to Adventurer (will force class selection on login)
      session['character'] = createDefaultCharacter();
    }

    // Restore social state
    session['friends'] = data.friends ? [...data.friends] : [];
    session['outgoingFriendRequests'] = data.outgoingFriendRequests ? [...data.outgoingFriendRequests] : [];
    session['blockedUsers'] = data.blockedUsers ? { ...data.blockedUsers } : {};
    session['guildId'] = data.guildId ?? null;
    session['partyId'] = null; // Parties are transient, not restored across restarts
    session['chatHistory'] = data.chatHistory ? [...data.chatHistory] : [];
    session['chatSendChannel'] = (data.chatSendChannel as ChatChannelType) ?? 'zone';
    session['chatDmTarget'] = data.chatDmTarget ?? '';

    // Add server-online log entry
    session['addLogEntry']('Server back online — resuming!', 'battle');

    return session;
  }

  handleEquipItem(itemId: string): boolean {
    const def = this.content.getItem(itemId);
    if (!def || !def.equipSlot) return false;

    const result = equipItem(this.character.inventory, this.character.equipment, itemId, this.content.getAllItems());
    return result.success;
  }

  handleUnequipItem(slot: EquipSlot): boolean {
    if (!EQUIP_SLOTS.includes(slot)) return false;

    const result = unequipItem(this.character.inventory, this.character.equipment, slot);
    return result.success;
  }
}
