import type { PassiveEffectKind, SkillDefinition, SkillCardType, SkillId } from '@idle-party-rpg/shared';
import {
  COMBAT_PACE,
  findAttackSkill,
  isTimedSkill,
  paceEngineMs,
  paceRealMs,
  SKILL_CARD_TYPE_INFO,
  SKILL_TRIGGER_INFO,
  getSkillCardType,
  getSkillTrigger,
  paceSkillSeconds,
  skillRatingMitigation,
} from '@idle-party-rpg/shared';

const RATING_KIND_LABELS: Partial<Record<PassiveEffectKind, string>> = {
  physical_reduction: 'Physical',
  magical_reduction_party: 'Magical & holy',
};

export interface SkillCardSummary {
  cardType: SkillCardType;
  cooldown: string | null;
  /** Skills with charge and recovery only; `cooldown` is null on them, and `recovery` on an instant. */
  charge: string | null;
  recovery: string | null;
  castTime: string | null;
  trigger: string | null;
  triggerDescription: string | null;
}

/** `1` → `1s`, `1.5` → `1.5s`; trims float noise to two decimals. */
export function formatSeconds(seconds: number): string {
  const rounded = Math.round(seconds * 100) / 100;
  return `${rounded}s`;
}

/** The class's Attack card, if it has one the engine plays: an attack skill with neither timing field is ignored. */
export function classAttackSkill(className: string, skills: Record<SkillId, SkillDefinition>): SkillDefinition | undefined {
  const attack = findAttackSkill(className, skills);
  return attack && isTimedSkill(attack) ? attack : undefined;
}

/** Real seconds a charge or recovery of `seconds` plays for, one decimal: it snaps to the engine's step grid. */
export function snappedSeconds(seconds: number | undefined): number {
  const realMs = paceRealMs(COMBAT_PACE, paceEngineMs(COMBAT_PACE, seconds ?? 0));
  return Math.round(realMs / 100) / 10;
}

/** `ownerClass` matters for a granted skill, which runs at its wearer's pace rather than its home class's. */
export function summarizeSkillCard(skill: SkillDefinition, ownerClass: string = skill.className): SkillCardSummary {
  const isActive = skill.type === 'active';
  const trigger = getSkillTrigger(skill);
  const castTime = isActive && skill.castTime && skill.castTime > 0 ? skill.castTime : 0;
  const real = (seconds: number): string => formatSeconds(paceSkillSeconds(COMBAT_PACE, skill, ownerClass, seconds));
  const timed = skill.type !== 'passive' && isTimedSkill(skill);
  return {
    cardType: getSkillCardType(skill),
    cooldown: isActive && !timed ? `CD ${real(skill.cooldown ?? 1)}` : null,
    charge: timed ? `Charge ${formatSeconds(snappedSeconds(skill.charge))}` : null,
    recovery: timed && !trigger ? `Recovery ${formatSeconds(snappedSeconds(skill.recovery))}` : null,
    castTime: castTime > 0 ? `Cast ${real(castTime)}` : null,
    trigger: trigger ? SKILL_TRIGGER_INFO[trigger].label : null,
    triggerDescription: trigger ? SKILL_TRIGGER_INFO[trigger].description : null,
  };
}

/** Cooldown or charge and recovery, cast time and trigger as display fragments, in that order, omitting absent ones. */
export function skillMetaParts(skill: SkillDefinition): string[] {
  const s = summarizeSkillCard(skill);
  return [s.cooldown, s.charge, s.recovery, s.castTime, s.trigger ? `Trigger: ${s.trigger}` : null]
    .filter((p): p is string => p !== null);
}

/** Mitigation of Guard/Bless-style rating options against enemies of the owner's level: "≈50 % vs enemies of your level". */
export function skillComputedLine(skill: SkillDefinition): string | null {
  const parts = (skill.passiveEffects ?? [])
    .filter(e => RATING_KIND_LABELS[e.kind] && (e.valuePerLevel ?? 0) > 0)
    .map(e => ({ label: RATING_KIND_LABELS[e.kind]!, pct: Math.round(skillRatingMitigation(e.valuePerLevel ?? 0) * 100) }));
  if (parts.length === 0) return null;
  if (parts.length === 1) return `≈${parts[0].pct}\u202f% vs enemies of your level`;
  return `${parts.map(p => `${p.label} ≈${p.pct}\u202f%`).join(' · ')} vs enemies of your level`;
}

export function renderSkillCardChip(skill: SkillDefinition): string {
  const cardType = getSkillCardType(skill);
  const info = SKILL_CARD_TYPE_INFO[cardType];
  const label = `<span class="skill-card-chip-label">${info.label}</span>`;
  return `<span class="skill-card-chip" data-card-type="${cardType}" title="${escapeAttr(`${info.label}: ${info.blurb}`)}">`
    + `<span class="skill-card-chip-icon" aria-hidden="true">${info.icon}</span>${label}</span>`;
}

/** Chip plus a `CD · Cast · Trigger` or `Charge · Recovery · Cast · Trigger` line; the trigger's description rides along as a tooltip. */
export function renderSkillCardMeta(skill: SkillDefinition, ownerClass?: string): string {
  const s = summarizeSkillCard(skill, ownerClass);
  const timing = [s.cooldown, s.charge, s.recovery, s.castTime].filter((p): p is string => p !== null)
    .map(p => `<span class="skill-card-meta-part">${p}</span>`).join('');
  const trigger = s.trigger
    ? `<span class="skill-card-meta-trigger" title="${escapeAttr(s.triggerDescription ?? '')}"><span class="skill-card-meta-trigger-prefix">Trigger: </span>${s.trigger}</span>`
    : '';
  const line = skillComputedLine(skill);
  const computed = line ? `<span class="skill-card-meta-computed">${line}</span>` : '';
  return `<span class="skill-card-meta" data-card-type="${s.cardType}">${renderSkillCardChip(skill)}${timing}${trigger}${computed}</span>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}
