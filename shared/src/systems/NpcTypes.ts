// --- Types ---

export interface NpcDefinition {
  id: string;
  name: string;
  /** Emoji portrait. Always required so an NPC always renders. */
  emoji: string;
  /** Greeting line shown when the player talks to this NPC. */
  greeting: string;
  /** Optional artwork URL (e.g. /npc-artwork/foo.png). Falls back to emoji. */
  artworkUrl?: string;
  /** Quest IDs this NPC offers. Wired in the quest phase; empty for the framework MVP. */
  questIds?: string[];
}

/**
 * Dev-only seed NPC. Used to verify the framework end-to-end before quests land.
 * `ContentStore` only seeds this when `NODE_ENV !== 'production'`, so production
 * deployments boot with an empty NPC catalog.
 */
export const SEED_NPCS: Record<string, NpcDefinition> = {
  test_healer: {
    id: 'test_healer',
    name: 'Test Healer',
    emoji: '🧙‍♀️',
    greeting: "I'm a placeholder NPC. Delete me once real NPCs exist.",
  },
};
