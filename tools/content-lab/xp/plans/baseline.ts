import type { XpPlan } from '../plan.js';
import { definePlan, shippedXp } from './lib.js';

/** The game's XP rule as shipped: PartyBattleManager.payVictory through the shared fightXp. */
const baseline: XpPlan = definePlan({
  id: 'baseline',
  describe: 'Current rule: every monster present pays on victory, by level gap, party share by bodies, starter-zone lone share, floor XP factor',
  victory: shippedXp,
});

export default baseline;
