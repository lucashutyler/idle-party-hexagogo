import { SEED_SKILLS } from '../src/systems/SkillTypes';
import type { SkillDefinition, SkillId } from '../src/systems/SkillTypes';

const LEGACY_TIMING: Record<SkillId, Pick<SkillDefinition, 'cooldown' | 'warmup'>> = {
  knight_bash: { cooldown: 2 },
  knight_intercept: { cooldown: 2 },
  knight_shield_slam: { cooldown: 1 },
  knight_sunder: { cooldown: 3, warmup: 1 },
  knight_dispel: { cooldown: 5 },
  archer_cut_down: { cooldown: 3 },
  archer_triple_shot: { cooldown: 4 },
  archer_snipe: { cooldown: 5 },
  archer_bleed: { cooldown: 3 },
  archer_crippling_shot: { cooldown: 3 },
  priest_minor_heal: { cooldown: 1 },
  priest_smite: { cooldown: 2 },
  priest_cure: { cooldown: 3 },
  priest_mending: { cooldown: 4 },
  priest_sanctuary: { cooldown: 1 },
  mage_magic_missile: { cooldown: 3 },
  mage_zap: { cooldown: 1 },
  mage_blizzard: { cooldown: 6 },
  mage_chain_lightning: { cooldown: 1 },
  mage_arcane_blast: { cooldown: 5 },
  bard_dissonance: { cooldown: 3 },
  bard_drumroll: { cooldown: 4 },
  bard_war_song: { cooldown: 4, warmup: 0 },
  bard_lullaby: { cooldown: 5 },
  bard_chaos: { cooldown: 6 },
};

function toLegacy(skill: SkillDefinition): SkillDefinition {
  const { charge: _charge, recovery: _recovery, warmup: _warmup, ...rest } = skill;
  return { ...rest, ...LEGACY_TIMING[skill.id] };
}

/** The seed skills as content with neither charge nor recovery plays them: the compatibility path for unmigrated content. */
export const LEGACY_SEED_SKILLS: Record<SkillId, SkillDefinition> = Object.fromEntries(
  Object.values(SEED_SKILLS).filter(skill => skill.type !== 'attack').map(skill => [skill.id, toLegacy(skill)]),
);
