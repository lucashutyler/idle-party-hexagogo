import {
  computeStatus,
  initialProgress,
  objectivesComplete,
  canAcceptQuest,
  getObjectiveTarget,
} from '@idle-party-rpg/shared';
import type {
  QuestDefinition,
  QuestProgressEntry,
  CompletedQuestEntry,
  QuestStatus,
  QuestReward,
} from '@idle-party-rpg/shared';

/**
 * Quest scope behavior summary:
 *  - 'solo':         only acceptable while the player is in a solo party (party size === 1).
 *  - 'party_shared': acceptable any time.
 *  After acceptance, both scopes credit the player for kills/visits in any combat or
 *  movement they participate in. The scope is enforced at accept time, not at progress time.
 */
export interface QuestEvent {
  type: 'accepted' | 'progress' | 'ready' | 'turned_in';
  questId: string;
  username: string;
}

export interface QuestSystemSaveData {
  active: QuestProgressEntry[];
  completed: CompletedQuestEntry[];
  weeklyCompletions: Record<string, string>;
}

export interface TurnInResult {
  success: boolean;
  error?: string;
  rewards?: QuestReward[];
}

export class QuestSystem {
  private active: Map<string, QuestProgressEntry> = new Map();
  private completed: CompletedQuestEntry[] = [];
  private weeklyCompletions: Record<string, string> = {};
  private username: string;
  private onEvent?: (event: QuestEvent) => void;

  constructor(username: string, onEvent?: (event: QuestEvent) => void) {
    this.username = username;
    this.onEvent = onEvent;
  }

  // --- Accessors ---

  getActiveProgress(): QuestProgressEntry[] {
    return Array.from(this.active.values());
  }

  getActiveQuestIds(): Set<string> {
    return new Set(this.active.keys());
  }

  getCompletedQuestIds(): Set<string> {
    return new Set(this.completed.map(c => c.questId));
  }

  getCompleted(): CompletedQuestEntry[] {
    return this.completed.slice();
  }

  getWeeklyCompletions(): Record<string, string> {
    return { ...this.weeklyCompletions };
  }

  hasAccepted(questId: string): boolean {
    return this.active.has(questId);
  }

  getProgress(questId: string): QuestProgressEntry | undefined {
    return this.active.get(questId);
  }

  // --- Mutations ---

  /**
   * Accept a quest. Returns null on success, or an error reason.
   * `partySize` is used to enforce 'solo' scope (must be in a party of 1).
   */
  accept(
    quest: QuestDefinition,
    ctx: { playerLevel: number; partySize: number },
  ): string | null {
    const reason = canAcceptQuest(quest, {
      playerLevel: ctx.playerLevel,
      activeQuestIds: this.getActiveQuestIds(),
      completedQuestIds: this.getCompletedQuestIds(),
      weeklyCompletions: this.weeklyCompletions,
    });
    if (reason) return reason;

    if (quest.scope === 'solo' && ctx.partySize > 1) {
      return 'Solo quest — leave your party first.';
    }

    this.active.set(quest.id, {
      questId: quest.id,
      status: 'accepted',
      progress: initialProgress(quest),
      acceptedAt: new Date().toISOString(),
    });
    this.fire({ type: 'accepted', questId: quest.id, username: this.username });
    return null;
  }

  /**
   * Apply a kill event to all matching active kill objectives.
   * Returns the list of quest IDs whose status changed (e.g., entered 'ready').
   */
  applyKill(monsterId: string, quests: Record<string, QuestDefinition>): string[] {
    const transitioned: string[] = [];
    for (const entry of this.active.values()) {
      if (entry.status === 'ready') continue;
      const def = quests[entry.questId];
      if (!def) continue;
      let changed = false;
      for (let i = 0; i < def.objectives.length; i++) {
        const obj = def.objectives[i];
        if (obj.kind !== 'kill') continue;
        if (obj.monsterId !== monsterId) continue;
        if (entry.progress[i] >= obj.count) continue;
        entry.progress[i] = Math.min(obj.count, entry.progress[i] + 1);
        changed = true;
      }
      if (changed) {
        const before = entry.status;
        entry.status = computeStatus(def, entry.progress);
        if (entry.status !== before) {
          transitioned.push(entry.questId);
          if (entry.status === 'ready') {
            this.fire({ type: 'ready', questId: entry.questId, username: this.username });
          }
        }
        this.fire({ type: 'progress', questId: entry.questId, username: this.username });
      }
    }
    return transitioned;
  }

  /**
   * Apply a tile-visit event to all matching active visit objectives.
   * Returns the list of quest IDs whose status changed.
   */
  applyVisit(tileId: string, quests: Record<string, QuestDefinition>): string[] {
    const transitioned: string[] = [];
    for (const entry of this.active.values()) {
      if (entry.status === 'ready') continue;
      const def = quests[entry.questId];
      if (!def) continue;
      let changed = false;
      for (let i = 0; i < def.objectives.length; i++) {
        const obj = def.objectives[i];
        if (obj.kind !== 'visit') continue;
        if (obj.tileId !== tileId) continue;
        if (entry.progress[i] >= 1) continue;
        entry.progress[i] = 1;
        changed = true;
      }
      if (changed) {
        const before = entry.status;
        entry.status = computeStatus(def, entry.progress);
        if (entry.status !== before) {
          transitioned.push(entry.questId);
          if (entry.status === 'ready') {
            this.fire({ type: 'ready', questId: entry.questId, username: this.username });
          }
        }
        this.fire({ type: 'progress', questId: entry.questId, username: this.username });
      }
    }
    return transitioned;
  }

  /**
   * Recompute collect-objective progress from current inventory ownership counts.
   * Called before exposing state to the client and before turn-in.
   */
  recomputeCollect(
    quests: Record<string, QuestDefinition>,
    getInventoryCount: (itemId: string) => number,
  ): void {
    for (const entry of this.active.values()) {
      const def = quests[entry.questId];
      if (!def) continue;
      let changed = false;
      for (let i = 0; i < def.objectives.length; i++) {
        const obj = def.objectives[i];
        if (obj.kind !== 'collect') continue;
        const owned = Math.min(obj.count, getInventoryCount(obj.itemId));
        if (entry.progress[i] !== owned) {
          entry.progress[i] = owned;
          changed = true;
        }
      }
      if (changed) {
        entry.status = computeStatus(def, entry.progress);
      }
    }
  }

  /**
   * Turn in a ready quest. Returns rewards to be granted by the caller, or an error.
   * The caller is responsible for actually consuming collect items and granting XP/gold/items.
   * `consumeCollectItems` callback is given (itemId, count) pairs to deduct from inventory.
   */
  turnIn(
    questId: string,
    quests: Record<string, QuestDefinition>,
    consumeCollectItems: (itemId: string, count: number) => boolean,
    getInventoryCount: (itemId: string) => number,
  ): TurnInResult {
    const entry = this.active.get(questId);
    if (!entry) return { success: false, error: 'Quest not accepted.' };

    const def = quests[questId];
    if (!def) return { success: false, error: 'Quest definition missing.' };

    // Recompute collect progress before validating ready state
    for (let i = 0; i < def.objectives.length; i++) {
      const obj = def.objectives[i];
      if (obj.kind !== 'collect') continue;
      entry.progress[i] = Math.min(obj.count, getInventoryCount(obj.itemId));
    }
    entry.status = computeStatus(def, entry.progress);

    if (!objectivesComplete(def, entry.progress)) {
      return { success: false, error: 'Objectives incomplete.' };
    }

    // Verify and deduct collect items
    for (const obj of def.objectives) {
      if (obj.kind !== 'collect') continue;
      if (getInventoryCount(obj.itemId) < obj.count) {
        return { success: false, error: 'Missing required items.' };
      }
    }
    for (const obj of def.objectives) {
      if (obj.kind !== 'collect') continue;
      const ok = consumeCollectItems(obj.itemId, obj.count);
      if (!ok) return { success: false, error: 'Failed to consume items.' };
    }

    this.active.delete(questId);
    const completedAt = new Date().toISOString();
    this.completed.push({ questId, completedAt });
    if ((def.repeat ?? 'once') === 'weekly') {
      this.weeklyCompletions[questId] = completedAt;
    }
    this.fire({ type: 'turned_in', questId, username: this.username });

    return { success: true, rewards: def.rewards };
  }

  // --- Persistence ---

  toSaveData(): QuestSystemSaveData {
    return {
      active: Array.from(this.active.values()).map(e => ({
        questId: e.questId,
        status: e.status,
        progress: [...e.progress],
        acceptedAt: e.acceptedAt,
      })),
      completed: [...this.completed],
      weeklyCompletions: { ...this.weeklyCompletions },
    };
  }

  loadFromSaveData(data: QuestSystemSaveData): void {
    this.active.clear();
    for (const entry of data.active) {
      this.active.set(entry.questId, {
        questId: entry.questId,
        status: entry.status,
        progress: [...entry.progress],
        acceptedAt: entry.acceptedAt,
      });
    }
    this.completed = [...data.completed];
    this.weeklyCompletions = { ...data.weeklyCompletions };
  }

  // --- Helpers (also used by tests) ---

  /** For UI: status filter helper. */
  isStatus(questId: string, status: QuestStatus): boolean {
    return this.active.get(questId)?.status === status;
  }

  /** For UI: get the target for an objective index on a given quest. */
  static getTarget(quest: QuestDefinition, objectiveIndex: number): number {
    return getObjectiveTarget(quest.objectives[objectiveIndex]);
  }

  // --- Private ---

  private fire(event: QuestEvent): void {
    this.onEvent?.(event);
  }
}
