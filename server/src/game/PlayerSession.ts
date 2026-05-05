import {
  HexGrid,
  HexTile,
  UnlockSystem,
  offsetToCube,
  createCharacter,
  ALL_CLASS_NAMES,
  CLASS_DEFINITIONS,
  addXp,
  addGold,
  calculateMaxHp,
  calculateBaseDamage,
  xpForNextLevel,
  computeEquipmentBonuses,
  computeActiveSetBonuses,
  mergeSetBonusesIntoEquip,
  MAX_STACK,
  addItemToInventory,
  equipItem,
  unequipItem,
  destroyItems,
  equipItemForceDestroy,
  EQUIP_SLOTS,
  isTwoHandedEquipped,
  getOwnedItemIds,
  hasItemEquipped as inventoryHasItemEquipped,
  getZone,
  setAppliesToClass,
  createDefaultSkillLoadout,
  SKILL_SLOTS,
  getUnlockedSkillsForLevel,
  equipSkillInSlot,
  unequipSkillFromSlot,
  getSkillById,
} from '@idle-party-rpg/shared';
import type {
  ServerStateMessage,
  ServerBattleState,
  ServerPartyState,
  OtherPlayerState,
  CombatLogEntry,
  CharacterState,
  ClassName,
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
  SetDefinition,
  ShopDefinition,
  SkillDefinition,
  SkillLoadout,
  MailboxEntry,
} from '@idle-party-rpg/shared';
import type { PlayerSaveData } from './GameStateStore.js';
import type { ContentStore } from './ContentStore.js';

const MAX_LOG_ENTRIES = 1000;
const MAX_SAVE_LOG_ENTRIES = 1000;
const MAX_CHAT_HISTORY = 1000;

export class PlayerSession {
  username: string;
  private grid: HexGrid;
  private content: ContentStore;
  private unlockSystem: UnlockSystem;
  private combatLog: CombatLogEntry[] = [];
  private logIdCounter = 0;
  private battleCount = 0;
  private character: CharacterState | null = null;
  private chatHistory: ChatMessage[] = [];
  private friends: string[] = [];
  private outgoingFriendRequests: FriendRequest[] = [];
  private blockedUsers: Record<string, BlockLevel> = {};
  private guildId: string | null = null;
  private partyId: string | null = null;
  private chatSendChannel: ChatChannelType = 'zone';
  private chatDmTarget = '';
  /** Initial mailbox snapshot from save data; live state lives in MailboxSystem. */
  private initialMailbox: MailboxEntry[] = [];
  /** Callback to fetch the player's live mailbox from MailboxSystem. */
  getMailbox?: () => MailboxEntry[];

  /** XP rate tracking — in-memory only, resets on server restart. */
  private xpRateStartTime = Date.now();
  private xpRateXpTotal = 0;

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

  /** Callback to get the current tile — set by PlayerManager. */
  getCurrentTile?: () => HexTile | null;

  /** Callback to get the remaining movement path — set by PlayerManager. */
  getCurrentPath?: () => HexTile[];

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

    this.unlockSystem = new UnlockSystem(this.grid, startTile);
  }

  /** Get combat info for the party combat system. Requires character to exist. */
  getCombatInfo(): PartyCombatant {
    if (!this.character) throw new Error('getCombatInfo called on characterless session');
    const baseMaxHp = calculateMaxHp(this.character.level, this.character.className);
    let baseDamage = calculateBaseDamage(this.character.level, this.character.className);
    const rawEquipBonuses = computeEquipmentBonuses(this.character.equipment, this.content.getAllItems(), this.character.level);
    const playerDamageType = CLASS_DEFINITIONS[this.character.className].damageType;

    // Compute set bonuses (filtered by class) and merge flat DR/MR/attack into equipBonuses.
    // Multiplicative bonuses (damagePercent, damageResistancePercent, cooldownReduction)
    // ride along on `setBonuses` so the combat engine can consume them at the right time.
    const setResult = computeActiveSetBonuses(this.character.equipment, this.content.getAllSets(), this.character.className);
    const equipBonuses = mergeSetBonusesIntoEquip(rawEquipBonuses, setResult.bonuses);
    const flatHp = setResult.bonuses.flatHp ?? 0;
    const percentHp = setResult.bonuses.percentHp ?? 0;
    const maxHp = Math.max(1, Math.floor((baseMaxHp + flatHp) * (1 + percentHp / 100)));

    // Resolve equipped skill definitions
    const equippedSkills: (SkillDefinition | null)[] = this.character.skillLoadout.equippedSkills.map(
      id => id ? getSkillById(id) ?? null : null
    );

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
      baseDamage,
      playerDamageType,
      equipBonuses,
      setBonuses: setResult.bonuses,
      gridPosition,
      className: this.character.className,
      level: this.character.level,
      equippedSkills,
      attackCount: 0,
      stunTurns: 0,
      dots: [],
      hots: [],
      damageShield: 0,
      debuffs: [],
      consecutiveHits: 0,
      lastTargetId: '',
      hasResurrected: false,
      martyrBonus: 0,
      braceActive: false,
      braceDamageTaken: 0,
      interceptActive: false,
      activeSkillCount: 0,
    };
  }

  /** Handle victory rewards (called by PartyBattleManager with pre-split rewards). */
  handleVictory(rewards: { xp: number; gold: number; items: string[] }, tile: HexTile): void {
    if (!this.character) return;
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
    this.xpRateXpTotal += rewards.xp;
    this.addLogEntry(`+${rewards.xp} XP`, 'victory');
    if (leveledUp) {
      for (let i = 0; i < levelsGained; i++) {
        this.addLogEntry(`Level up! Now level ${this.character.level - levelsGained + i + 1}!`, 'levelup');
      }
      // Auto-unlock skills for the new level
      this.autoUnlockSkills();
    }
  }

  /** Check if a tile is unlocked for this player. */
  isTileUnlocked(tile: HexTile): boolean {
    return this.unlockSystem.isUnlocked(tile);
  }

  /** Returns true if this player has no character (hasn't selected a class yet). */
  isNewPlayer(): boolean {
    return this.character === null;
  }

  /** Returns true if this player has a character (has selected a class). */
  hasCharacter(): boolean {
    return this.character !== null;
  }

  incrementBattleCount(): void {
    this.battleCount++;
  }

  resetXpRate(): void {
    this.xpRateStartTime = Date.now();
    this.xpRateXpTotal = 0;
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

  /**
   * Build item definitions for items the player currently owns (inventory + equipment),
   * plus shop items and every piece of any set the player has at least one piece of —
   * the latter so the set-info popup can render piece names instead of item GUIDs.
   */
  private getOwnedItemDefinitions(setDefs: Record<string, SetDefinition>): Record<string, ItemDefinition> {
    if (!this.character) return {};
    const defs: Record<string, ItemDefinition> = {};

    // Owned items (unequipped + equipped, deduped)
    for (const itemId of getOwnedItemIds(this.character.inventory, this.character.equipment)) {
      const def = this.content.getItem(itemId);
      if (def) defs[itemId] = def;
    }

    // Shop items (so client has defs for buyable items)
    const shop = this.getCurrentShopDefinition();
    if (shop) {
      for (const si of shop.inventory) {
        if (!defs[si.itemId]) {
          const def = this.content.getItem(si.itemId);
          if (def) defs[si.itemId] = def;
        }
      }
    }

    // Set pieces — needed so the popup can render names for unowned pieces of a set the player partially owns.
    for (const set of Object.values(setDefs)) {
      for (const itemId of set.itemIds) {
        if (!defs[itemId]) {
          const def = this.content.getItem(itemId);
          if (def) defs[itemId] = def;
        }
      }
    }

    return defs;
  }

  /**
   * Build set definitions for sets the player can activate AND owns at least one piece of.
   * Class-restricted sets that don't include the player's class are excluded — owning a
   * piece of a Knight set as a Bard does nothing for the Bard, so the popup shouldn't
   * mention it on their own item view.
   */
  private getOwnedSetDefinitions(): Record<string, SetDefinition> {
    if (!this.character) return {};
    const ownedItemIds = getOwnedItemIds(this.character.inventory, this.character.equipment);

    const allSets = this.content.getAllSets();
    const result: Record<string, SetDefinition> = {};
    for (const [id, set] of Object.entries(allSets)) {
      if (!setAppliesToClass(set, this.character.className)) continue;
      if (set.itemIds.some(itemId => ownedItemIds.has(itemId))) {
        result[id] = set;
      }
    }
    return result;
  }

  /** Get the shop definition for the player's current tile, if any. */
  private getCurrentShopDefinition(): ShopDefinition | undefined {
    const pos = this.getPosition();
    const world = this.content.getWorld();
    const tile = world.tiles.find(t => t.col === pos.col && t.row === pos.row);
    if (!tile?.shopId) return undefined;
    return this.content.getShop(tile.shopId);
  }

  getState(otherPlayers: OtherPlayerState[]): Omit<ServerStateMessage, 'type' | 'serverVersion'> {
    const battleState = this.getBattleState?.();
    const partyState = this.getPartyPositionState?.();
    const partyZone = this.getPartyZone?.();

    let charState: ClientCharacterState | null = null;
    if (this.character) {
      const baseMaxHp = calculateMaxHp(this.character.level, this.character.className);
      const setResult = computeActiveSetBonuses(this.character.equipment, this.content.getAllSets(), this.character.className);
      const flatHp = setResult.bonuses.flatHp ?? 0;
      const percentHp = setResult.bonuses.percentHp ?? 0;
      const maxHp = Math.max(1, Math.floor((baseMaxHp + flatHp) * (1 + percentHp / 100)));

      charState = {
        className: this.character.className,
        level: this.character.level,
        xp: this.character.xp,
        xpForNextLevel: xpForNextLevel(this.character.level),
        maxHp,
        gold: this.character.gold,
        baseDamage: calculateBaseDamage(this.character.level, this.character.className),
        damageType: CLASS_DEFINITIONS[this.character.className].damageType,
        skillLoadout: this.character.skillLoadout,
        inventory: { ...this.character.inventory },
        equipment: { ...this.character.equipment },
        xpRate: { startTime: this.xpRateStartTime, totalXp: this.xpRateXpTotal },
      };
    }

    const allZones = this.content.getAllZones();
    const zone = partyZone ? getZone(partyZone, allZones) : null;
    const zoneName = zone ? zone.displayName : (partyZone ?? 'Unknown');

    const setDefs = this.getOwnedSetDefinitions();

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
      itemDefinitions: this.getOwnedItemDefinitions(setDefs),
      setDefinitions: setDefs,
      shopDefinition: this.getCurrentShopDefinition(),
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

  /** Mailbox snapshot from save data — used once at startup to populate MailboxSystem. */
  consumeInitialMailbox(): MailboxEntry[] {
    const m = this.initialMailbox;
    this.initialMailbox = [];
    return m;
  }

  /** Store a chat message in this player's personal history. */
  addChatMessage(message: ChatMessage): void {
    this.chatHistory.push(message);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY);
    }
  }

  /** Get all chat history. */
  getChatHistory(): ChatMessage[] {
    return this.chatHistory;
  }

  /** Get messages since a given message ID. Returns found=false if ID not in history. */
  getMessagesSince(sinceId: string): { messages: ChatMessage[]; found: boolean } {
    const idx = this.chatHistory.findIndex(m => m.id === sinceId);
    if (idx === -1) return { messages: [], found: false };
    return { messages: this.chatHistory.slice(idx + 1), found: true };
  }

  /** Returns the count of an item in the unequipped inventory (0 if not present). */
  getInventoryCount(itemId: string): number {
    if (!this.character) return 0;
    return this.character.inventory[itemId] ?? 0;
  }

  /** Remove one item from the unequipped inventory. Returns false if item not present. */
  removeOneFromInventory(itemId: string): boolean {
    if (!this.character) return false;
    const current = this.character.inventory[itemId] ?? 0;
    if (current <= 0) return false;
    if (current === 1) {
      delete this.character.inventory[itemId];
    } else {
      this.character.inventory[itemId] = current - 1;
    }
    return true;
  }

  /** Add one item to the unequipped inventory. Returns false if stack is full (MAX_STACK). */
  addOneToInventory(itemId: string): boolean {
    if (!this.character) return false;
    return addItemToInventory(this.character.inventory, itemId);
  }

  /** Remove `quantity` items from the unequipped inventory. Returns false if insufficient. */
  removeFromInventory(itemId: string, quantity: number): boolean {
    if (!this.character) return false;
    const current = this.character.inventory[itemId] ?? 0;
    if (current < quantity) return false;
    const newCount = current - quantity;
    if (newCount === 0) {
      delete this.character.inventory[itemId];
    } else {
      this.character.inventory[itemId] = newCount;
    }
    return true;
  }

  /** Add `quantity` items to the unequipped inventory. Returns false if it would exceed MAX_STACK. */
  addToInventory(itemId: string, quantity: number): boolean {
    if (!this.character) return false;
    const current = this.character.inventory[itemId] ?? 0;
    if (current + quantity > MAX_STACK) return false;
    this.character.inventory[itemId] = current + quantity;
    return true;
  }

  getGold(): number { return this.character?.gold ?? 0; }

  /** Deduct gold from the character. Returns false if insufficient gold. */
  deductGold(amount: number): boolean {
    if (!this.character) return false;
    if (this.character.gold < amount) return false;
    this.character.gold -= amount;
    return true;
  }

  /** Add gold to the character. */
  grantGold(amount: number): void {
    if (!this.character) return;
    addGold(this.character, amount);
  }

  getLevel(): number { return this.character?.level ?? 0; }

  getClassName(): ClassName | null { return this.character?.className ?? null; }
  getSkillLoadout(): SkillLoadout | null { return this.character?.skillLoadout ?? null; }

  /** Returns publicly visible profile data (no HP, damage, gold, inventory). */
  getPublicProfile(): { className: string; level: number; equipment: Record<string, string | null>; skillLoadout: SkillLoadout } | null {
    if (!this.character) return null;
    return {
      className: this.character.className,
      level: this.character.level,
      equipment: { ...this.character.equipment },
      skillLoadout: { ...this.character.skillLoadout, equippedSkills: [...this.character.skillLoadout.equippedSkills] },
    };
  }

  /** Set class for a new character. Only works if no character exists yet. */
  setClass(className: ClassName): boolean {
    if (this.character !== null) return false;
    this.character = createCharacter(className);
    return true;
  }

  /** Admin: force-change class, keeping level, XP, gold, and inventory. Unequips all gear. */
  forceSetClass(className: ClassName): void {
    if (!this.character) {
      // Admin creating a character for a player who hasn't chosen yet
      this.character = createCharacter(className);
      this.autoUnlockSkills();
      this.addLogEntry(`Class set to ${className}!`, 'battle');
      return;
    }
    // Unequip all gear back to inventory (skip offhand if same as mainhand — 2H weapon)
    for (const slot of EQUIP_SLOTS) {
      const itemId = this.character.equipment[slot];
      if (itemId) {
        const skip = slot === 'offhand' && itemId === this.character.equipment.mainhand;
        if (!skip) {
          this.character.inventory[itemId] = (this.character.inventory[itemId] ?? 0) + 1;
        }
        this.character.equipment[slot] = null;
      }
    }
    this.character.className = className;
    this.character.skillLoadout = createDefaultSkillLoadout(className);
    this.autoUnlockSkills();
    this.addLogEntry(`Class changed to ${className}!`, 'battle');
  }

  // ── Skill System ──────────────────────────────────────

  /** Auto-unlock all skills the player qualifies for based on level. */
  autoUnlockSkills(): void {
    if (!this.character) return;
    const available = getUnlockedSkillsForLevel(this.character.className, this.character.level);
    this.character.skillLoadout.unlockedSkills = available;
  }

  handleEquipSkill(skillId: string, slotIndex: number): boolean {
    if (!this.character) return false;
    const result = equipSkillInSlot(
      skillId,
      slotIndex,
      this.character.className,
      this.character.level,
      this.character.skillLoadout,
    );
    if (!result) return false;
    this.character.skillLoadout.equippedSkills = result;
    return true;
  }

  handleUnequipSkill(slotIndex: number): boolean {
    if (!this.character) return false;
    const newEquipped = unequipSkillFromSlot(slotIndex, this.character.skillLoadout.equippedSkills);
    this.character.skillLoadout.equippedSkills = newEquipped;
    return true;
  }

  addLogEntry(text: string, type: CombatLogEntry['type']): void {
    this.combatLog.push({ id: ++this.logIdCounter, text, type });
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
    if (this.character) {
      this.character = createCharacter(this.character.className);
    }

    this.battleCount = 0;
    this.combatLog = [];
    this.logIdCounter = 0;
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
      character: this.character ? {
        className: this.character.className,
        level: this.character.level,
        xp: this.character.xp,
        gold: this.character.gold,
        inventory: { ...this.character.inventory },
        equipment: { ...this.character.equipment },
        skillLoadout: { ...this.character.skillLoadout },
      } : undefined,
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
      mailbox: this.getMailbox ? this.getMailbox() : this.initialMailbox,
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
    // Migrate old log entries without IDs and restore the counter
    const restoredLog = data.combatLog.slice(-MAX_LOG_ENTRIES);
    let maxId = 0;
    for (const entry of restoredLog) {
      if (!entry.id) entry.id = ++maxId;
      else if (entry.id > maxId) maxId = entry.id;
    }
    session['combatLog'] = restoredLog;
    session['logIdCounter'] = maxId;
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

    // Restore character — null if class is invalid/legacy (forces class selection)
    const savedClassName = data.character?.className;
    const isValidClass = savedClassName && ALL_CLASS_NAMES.includes(savedClassName as ClassName);

    if (data.character && isValidClass) {
      const className = savedClassName as ClassName;

      // Migrate skill loadout from old saves
      const skillLoadout: SkillLoadout = data.character.skillLoadout
        ? { ...data.character.skillLoadout, equippedSkills: [...data.character.skillLoadout.equippedSkills] }
        : createDefaultSkillLoadout(className);

      // Pad equippedSkills to 5 slots (backward compat from 3-slot saves)
      while (skillLoadout.equippedSkills.length < SKILL_SLOTS.length) {
        skillLoadout.equippedSkills.push(null);
      }

      session['character'] = {
        className,
        level: data.character.level,
        xp: data.character.xp,
        gold: data.character.gold ?? 0,
        inventory: data.character.inventory ? { ...data.character.inventory } : {},
        equipment: data.character.equipment
          ? { ...data.character.equipment }
          : { head: null, shoulders: null, chest: null, bracers: null, gloves: null, mainhand: null, offhand: null, foot: null, ring: null, necklace: null, back: null, relic: null },
        skillLoadout,
      };
    } else {
      // Invalid or legacy class — no character (will force class selection on login)
      session['character'] = null;
    }

    // Auto-unlock skills for current level (only if character exists)
    if (session['character']) {
      session.autoUnlockSkills();
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
    session['initialMailbox'] = data.mailbox ? [...data.mailbox] : [];

    // XP rate tracking — auto-start from session restore time
    session['xpRateStartTime'] = Date.now();
    session['xpRateXpTotal'] = 0;

    // Add server-online log entry
    session['addLogEntry']('Server back online — resuming!', 'battle');

    return session;
  }

  handleEquipItem(itemId: string): boolean {
    if (!this.character) return false;
    const def = this.content.getItem(itemId);
    if (!def || !def.equipSlot) return false;

    const result = equipItem(this.character.inventory, this.character.equipment, itemId, this.content.getAllItems(), this.character.className);
    return result.success;
  }

  /** Check if the player has a specific item equipped in any slot. */
  hasItemEquipped(itemId: string): boolean {
    if (!this.character) return false;
    return inventoryHasItemEquipped(itemId, this.character.equipment);
  }

  /** Get item IDs locked by the current tile and remaining path (required for traversal). */
  getLockedItemIds(): string[] {
    const locked = new Set<string>();
    const tile = this.getCurrentTile?.();
    if (tile?.requiredItemId) locked.add(tile.requiredItemId);
    const path = this.getCurrentPath?.() ?? [];
    for (const t of path) {
      if (t.requiredItemId) locked.add(t.requiredItemId);
    }
    return [...locked];
  }

  handleUnequipItem(slot: EquipSlot): { success: boolean; lockedByTile?: boolean } {
    if (!this.character) return { success: false };
    if (!EQUIP_SLOTS.includes(slot)) return { success: false };

    // Check if the equipped item in this slot is locked by tile traversal
    const equippedInSlot = this.character.equipment[slot];
    if (equippedInSlot) {
      const lockedIds = this.getLockedItemIds();
      if (lockedIds.includes(equippedInSlot)) return { success: false, lockedByTile: true };
    }

    const result = unequipItem(this.character.inventory, this.character.equipment, slot, this.content.getAllItems());
    return { success: result.success };
  }

  /** Check why equip failed — returns the blocking item info if inventory full. */
  getEquipBlockInfo(itemId: string): { blockedByItemId: string; blockedBySlot: EquipSlot } | null {
    if (!this.character) return null;
    const def = this.content.getItem(itemId);
    if (!def || !def.equipSlot) return null;

    const slot = def.equipSlot;

    const is2H = slot === 'twohanded';

    // If a 2H weapon is equipped and we're touching mainhand/offhand/twohanded, check that
    if ((slot === 'mainhand' || slot === 'offhand' || is2H) && isTwoHandedEquipped(this.character.equipment, this.content.getAllItems())) {
      const twoHandId = this.character.equipment.mainhand!;
      const current = this.character.inventory[twoHandId] ?? 0;
      if (current >= 99) {
        return { blockedByItemId: twoHandId, blockedBySlot: 'mainhand' };
      }
      return null;
    }

    // If equipping a 2H weapon, also check offhand stack
    if (is2H) {
      const offhandItem = this.character.equipment.offhand;
      if (offhandItem && (this.character.inventory[offhandItem] ?? 0) >= 99) {
        return { blockedByItemId: offhandItem, blockedBySlot: 'offhand' };
      }
      const mainhandItem = this.character.equipment.mainhand;
      if (mainhandItem && (this.character.inventory[mainhandItem] ?? 0) >= 99) {
        return { blockedByItemId: mainhandItem, blockedBySlot: 'mainhand' };
      }
    }

    // For twohanded items, check mainhand slot (since that's where it maps in the equipment record)
    const effectiveSlot = is2H ? 'mainhand' : slot;
    const currentEquipped = this.character.equipment[effectiveSlot];
    if (!currentEquipped) return null;

    // Check if the old item's stack is at max
    const current = this.character.inventory[currentEquipped] ?? 0;
    if (current >= 99) {
      return { blockedByItemId: currentEquipped, blockedBySlot: slot };
    }
    return null;
  }

  handleEquipItemForceDestroy(itemId: string): boolean {
    if (!this.character) return false;
    const def = this.content.getItem(itemId);
    if (!def || !def.equipSlot) return false;

    const result = equipItemForceDestroy(
      this.character.inventory, this.character.equipment, itemId, this.content.getAllItems(), this.character.className
    );
    return result.success;
  }

  handleDestroyItems(itemId: string, count: number): boolean {
    if (!this.character) return false;
    const result = destroyItems(this.character.inventory, itemId, count);
    return result.success;
  }

}
