import type { XpPlan } from '../plan.js';

/** Pays nothing: drives the stats pass, whose win rates and fight times don't depend on any XP rule. */
const nullPlan: XpPlan = {
  id: 'null',
  describe: 'Pays nothing',
  payout: () => 0,
};

export default nullPlan;
