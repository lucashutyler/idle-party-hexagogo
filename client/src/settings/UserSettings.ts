/**
 * Client-side user preferences persisted to localStorage.
 * UI-only state — does not sync across devices. For preferences that need to
 * sync (e.g. chat channel) use the server-backed paths instead.
 */

const QUEST_HINTS_KEY = 'idleparty.questHints';

export function getQuestHintsEnabled(): boolean {
  const raw = localStorage.getItem(QUEST_HINTS_KEY);
  // Default ON if not set
  return raw === null ? true : raw === 'true';
}

export function setQuestHintsEnabled(enabled: boolean): void {
  localStorage.setItem(QUEST_HINTS_KEY, enabled ? 'true' : 'false');
  for (const listener of listeners) {
    try { listener(); } catch { /* swallow */ }
  }
}

const listeners = new Set<() => void>();

/** Subscribe to user-settings changes. Returns unsubscribe. */
export function onSettingsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
