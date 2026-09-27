import type { SkillDefinition, SkillCardType } from '@idle-party-rpg/shared';
import {
  SKILL_CARD_TYPE_INFO,
  SKILL_TRIGGER_INFO,
  getSkillCardType,
  getSkillTrigger,
} from '@idle-party-rpg/shared';

export interface SkillCardSummary {
  cardType: SkillCardType;
  cooldown: string | null;
  castTime: string | null;
  trigger: string | null;
  triggerDescription: string | null;
}

/** `1` → `1s`, `1.5` → `1.5s`; trims float noise to two decimals. */
export function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 100) / 100;
  return `${rounded}s`;
}

export function summarizeSkillCard(skill: SkillDefinition): SkillCardSummary {
  const isActive = skill.type === 'active';
  const trigger = getSkillTrigger(skill);
  const castTime = isActive && skill.castTime && skill.castTime > 0 ? skill.castTime : 0;
  return {
    cardType: getSkillCardType(skill),
    cooldown: isActive ? `CD ${formatSeconds(skill.cooldown ?? 1)}` : null,
    castTime: castTime > 0 ? `Cast ${formatSeconds(castTime)}` : null,
    trigger: trigger ? SKILL_TRIGGER_INFO[trigger].label : null,
    triggerDescription: trigger ? SKILL_TRIGGER_INFO[trigger].description : null,
  };
}

/** Cooldown, cast time and trigger as display fragments, in that order, omitting absent ones. */
export function skillMetaParts(skill: SkillDefinition): string[] {
  const s = summarizeSkillCard(skill);
  return [s.cooldown, s.castTime, s.trigger ? `Trigger: ${s.trigger}` : null]
    .filter((p): p is string => p !== null);
}

export function renderSkillCardChip(skill: SkillDefinition): string {
  const cardType = getSkillCardType(skill);
  const info = SKILL_CARD_TYPE_INFO[cardType];
  const label = `<span class="skill-card-chip-label">${info.label}</span>`;
  return `<span class="skill-card-chip" data-card-type="${cardType}" title="${escapeAttr(`${info.label}: ${info.blurb}`)}">`
    + `<span class="skill-card-chip-icon" aria-hidden="true">${info.icon}</span>${label}</span>`;
}

/** Chip plus a `CD · Cast · Trigger` line; the trigger's description rides along as a tooltip. */
export function renderSkillCardMeta(skill: SkillDefinition): string {
  const s = summarizeSkillCard(skill);
  const timing = [s.cooldown, s.castTime].filter((p): p is string => p !== null)
    .map(p => `<span class="skill-card-meta-part">${p}</span>`).join('');
  const trigger = s.trigger
    ? `<span class="skill-card-meta-trigger" title="${escapeAttr(s.triggerDescription ?? '')}"><span class="skill-card-meta-trigger-prefix">Trigger: </span>${s.trigger}</span>`
    : '';
  return `<span class="skill-card-meta" data-card-type="${s.cardType}">${renderSkillCardChip(skill)}${timing}${trigger}</span>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
