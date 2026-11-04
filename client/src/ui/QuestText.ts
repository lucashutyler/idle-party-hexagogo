import type { QuestObjective, QuestReward, QuestScope, QuestStatus, ServerStateMessage } from '@idle-party-rpg/shared';
import { getObjectiveTarget } from '@idle-party-rpg/shared';
import { escapeHtml } from './ItemIcon';

export type QuestResolutions = ServerStateMessage['questResolutions'];

/** HTML-safe objective line with capped progress, e.g. "Kill Goblin (2/5)". */
export function objectiveText(obj: QuestObjective, progress: number, resolutions: QuestResolutions): string {
  const target = getObjectiveTarget(obj);
  const cap = Math.min(progress, target);
  if (obj.kind === 'kill') {
    return `Kill ${escapeHtml(resolutions?.monsters[obj.monsterId] ?? 'unknown monster')} (${cap}/${target})`;
  }
  if (obj.kind === 'collect') {
    return `Collect ${escapeHtml(resolutions?.items[obj.itemId] ?? 'unknown item')} (${cap}/${target})`;
  }
  const place = escapeHtml(roomText(obj.tileId, resolutions));
  return cap >= 1 ? `Visit ${place} — done` : `Visit ${place}`;
}

/** HTML-safe comma-separated reward list, or "none". */
export function rewardsText(rewards: readonly QuestReward[], resolutions: QuestResolutions): string {
  return rewards.map(r => rewardText(r, resolutions)).join(', ') || 'none';
}

export function statusLabel(status: QuestStatus): string {
  switch (status) {
    case 'accepted': return 'Accepted';
    case 'in_progress': return 'In progress';
    case 'ready': return 'Ready to turn in';
    case 'completed': return 'Completed';
  }
}

export function scopeBadgeHtml(scope: QuestScope): string {
  return scope === 'solo'
    ? `<span class="quest-pill quest-scope-solo">Solo</span>`
    : `<span class="quest-pill quest-scope-party">Party</span>`;
}

function rewardText(reward: QuestReward, resolutions: QuestResolutions): string {
  if (reward.kind === 'xp') return `${reward.amount} XP`;
  if (reward.kind === 'gold') return `${reward.amount} Gold`;
  return `${reward.quantity}× ${escapeHtml(resolutions?.items[reward.itemId] ?? 'unknown item')}`;
}

function roomText(tileId: string, resolutions: QuestResolutions): string {
  const tile = resolutions?.tiles[tileId];
  if (!tile) return 'a specific room';
  if (!tile.name) return tile.zoneName ? `a room in ${tile.zoneName}` : 'a specific room';
  return tile.zoneName ? `${tile.name}, ${tile.zoneName}` : tile.name;
}
