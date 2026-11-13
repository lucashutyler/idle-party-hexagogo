import type { FightXpInput, XpMonster } from '../../../../shared/src/index.js';
import type { DungeonWeeklyRule, FightView, MemberView, MonsterGroup, PayoutContext, XpPlan } from '../plan.js';

type Counted = Pick<MonsterGroup, 'def' | 'killed' | 'standing'>;
type PayRule = (fight: FightView, member: MemberView, ctx: PayoutContext) => number;

export function topHumanLevel(ctx: PayoutContext): number {
  return Math.max(0, ...ctx.party.members.map(m => m.level));
}

/** Every monster present, standing walls too, once per head. */
export function presentMonsters(groups: readonly Counted[]): XpMonster[] {
  return groups.flatMap(g => Array.from({ length: g.killed + g.standing }, () => g.def));
}

/** What PartyBattleManager.payVictory hands `fightXp` for this member. */
export function fightXpInput(fight: FightView, member: MemberView, ctx: PayoutContext): FightXpInput {
  const floor = ctx.table.kind === 'floor';
  return {
    monsters: presentMonsters(fight.monsters),
    memberLevel: member.level,
    topHumanLevel: topHumanLevel(ctx),
    bodies: Math.max(1, ctx.party.shareCount),
    starterZone: !floor && ctx.table.starterZone === true,
    ...(floor ? { floorXpFactor: ctx.table.floorXpFactor } : {}),
    xpBonus: ctx.party.xpMultiplier,
    rewardMultiplier: ctx.rewardMultiplier,
  };
}

/** The game's XP for a won fight, through the shared `fightXp`. */
export function shippedXp(fight: FightView, member: MemberView, ctx: PayoutContext): number {
  return ctx.rules.fightXp(fightXpInput(fight, member, ctx));
}

/** Monster XP of these groups at this member's level as the game weighs it, after the floor factor and level gap, before the share and multipliers. */
export function memberXp(groups: readonly Counted[], memberLevel: number, ctx: PayoutContext): number {
  const { rules } = ctx;
  const factor = ctx.table.kind === 'floor' ? rules.floorPayFactor(ctx.table.floorXpFactor) : 1;
  const top = topHumanLevel(ctx);
  let xp = 0;
  for (const g of groups) {
    if (!Number.isFinite(g.def.xp)) continue;
    const each = rules.floorMonsterXp(g.def.xp, factor);
    const gap = g.def.authored && Number.isFinite(g.def.level) ? rules.levelGapXpFactor(g.def.level, memberLevel, top, rules.isHarmlessMonster(g.def)) : 1;
    xp += each * gap * (g.killed + g.standing);
  }
  return xp;
}

/** What this fight's monsters are worth to this member before any share: `memberXp`, the party's xp_bonus, the game's reward multiplier. */
export function fightPot(fight: FightView, member: MemberView, ctx: PayoutContext): number {
  return memberXp(fight.monsters, member.level, ctx) * ctx.party.xpMultiplier * ctx.rewardMultiplier;
}

export interface PlanSpec extends Omit<XpPlan, 'payout'> {
  /** XP for a won fight. Lost fights pay nothing, as in the game. */
  victory: PayRule;
}

export function definePlan(spec: PlanSpec): XpPlan {
  const { victory, ...plan } = spec;
  return {
    ...plan,
    payout(fight, member, ctx) {
      return fight.won ? victory(fight, member, ctx) : 0;
    },
  };
}

/** A pot growing by `bonus` per extra body, split evenly. */
export function growingPotShare(bodies: number, bonus: number): number {
  return (1 + bonus * (bodies - 1)) / bodies;
}

export function powerShare(bodies: number, beta: number): number {
  return bodies ** -beta;
}

/** Humans plus hires counted at `hireWeight` each. */
export function weightedBodies(ctx: PayoutContext, hireWeight: number): number {
  return ctx.party.members.length + ctx.party.hireDetails.length * hireWeight;
}

/** Highest level in the party minus the lowest, hires included. */
export function partyLevelSpread(ctx: PayoutContext): number {
  const levels = [...ctx.party.members.map(m => m.level), ...ctx.party.hireDetails.map(h => h.level)];
  return Math.max(...levels) - Math.min(...levels);
}

/** Full pay on the first clear each week, then `repeatFactor` of the XP, in the dungeons one player can enter; pass a plain rule to cover every dungeon. Gold stays in full unless `gold` cuts it. */
export function weeklyRuleForSoloDungeons(repeatFactor: number, fullClearsPerWeek = 1, gold: { coin?: number; rewards?: number } = {}): (dungeonId: string, oneCanEnter: boolean) => DungeonWeeklyRule | undefined {
  const factors = { ...(gold.coin === undefined ? {} : { repeatCoinFactor: gold.coin }), ...(gold.rewards === undefined ? {} : { repeatRewardFactor: gold.rewards }) };
  return (_dungeonId, oneCanEnter) => (oneCanEnter ? { fullClearsPerWeek, repeatFactor, ...factors } : undefined);
}
