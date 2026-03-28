# Skill Tree Design — Working Draft

## Slot System

| Slot | Type | Unlocks At |
|------|------|------------|
| 1 | Passive | Level 1 |
| 2 | Active | Level 5 |
| 3 | Passive | Level 10 |
| 4 | Passive | Level 30 |
| 5 | Passive | Level 50 |

Skills are learned sequentially in the tree (one every 5 levels via skill points; first is free). By level 50, all 11 skills are unlocked. Players choose **4 of 6 passives** and **1 of 5 actives** to equip.

## Design Principles

1. **Passives stack** — multiple equipped passives combine within a class and synergize across party classes
2. **No role crossing** — Knight tanks, Archer does physical DPS, Mage does magical DPS, Priest heals/protects with holy damage, Bard supports
3. **Sidegrades, not upgrades** — earlier skills remain viable; later skills are situationally different, not strictly better
4. **Party > Solo** — many skills become dramatically better in a group

---

## Knight (Tank)

*Role: Absorb damage, draw aggro, protect the party. Weak damage output, extremely hard to kill.*

### Passives (choose 4 of 6)

| # | Learn | Name | Effect | Notes |
|---|-------|------|--------|-------|
| 1 | Lv 1 | **Guard** | +2 physical DR per level | Bread-and-butter. Scales linearly — always useful but never broken. Best vs many small hits. |
| 2 | Lv 10 | **Fortify** | +2% max HP per level | Better vs big burst hits where DR is less effective. At Lv 50, that's +100% HP on an already huge HP pool. Doesn't help the party directly — selfish tank pick. |
| 3 | Lv 20 | **Shield Bash** | When hit by a physical attack, 10% chance to stun the attacker for 1 turn | Passive CC from tanking physical hits. Doesn't trigger on magical/holy damage — you block with your shield, not your face. Pairs with Iron Will (can't be stunned, stun them back). More procs in physical-heavy zones. |
| 4 | Lv 30 | **Iron Will** | Immune to stun effects | Niche but huge in stun-heavy zones. Keeps the Knight swinging so their actives (Intercept, Bash) stay available when it matters most. Worthless if nothing stuns. |
| 5 | Lv 40 | **Tenacity** | All healing received increased by 30% | Makes the Knight a better heal target without healing themselves. Priest Minor Heal on a Tenacity Knight is 30% more effective. Rewards having a healer — useless solo. Pairs with Fortify (bigger HP pool to fill) and Unyielding (easier to stabilize after dropping low). |
| 6 | Lv 50 | **War Cry** | While the Knight is below 50% HP, all Archers in the party deal 25% more damage | The Knight bleeding out rallies the Archer to fight harder. Rewards staying in the danger zone instead of healing to full — interesting tension with Tenacity (+30% healing received). Cross-class synergy that only works with Archers in the party. Useless solo. |

**Why earlier skills stay good:** Guard is the most consistent DR in the game — always useful, always equipped. Fortify is the best burst survival. Later passives reward getting hit (Retaliate), being in big fights (Stalwart), or surviving crisis moments (Unyielding) — different axes of "tanking," not better versions of DR/HP.

### Actives (choose 1 of 5)

| # | Learn | Name | Effect | CD | Notes |
|---|-------|------|--------|----|-------|
| 1 | Lv 5 | **Bash** | 50% chance to stun target for 1 turn | 2 | Every other swing is a stun attempt. Reliable, frequent CC. |
| 2 | Lv 15 | **Intercept** | Instead of attacking, redirect the next attack targeting any other player to the Knight instead | 1 | Every single swing is replaced with drawing aggro. Zero damage output — full tank mode. The Knight eats the hit (DR still applies). Pairs with Guard/Fortify to survive the extra incoming. Pairs with Shield Bash passive (more hits on you = more stun procs). |
| 3 | Lv 25 | **Shield Slam** | Instead of attacking, brace — reflect 10% of all damage taken this round back to attackers | 1 | Every swing replaced with a defensive stance. No attack output, but anything that hits the Knight this round gets 10% back. Pairs naturally with Intercept (redirecting more hits to you = more reflected). Tiny damage — won't compete with DPS classes, just a small payoff for tanking. |
| 4 | Lv 35 | **Sunder** | Deal normal damage and mark the target — marked enemies take 25% increased damage from all sources (stacks) | 3 | Every 3rd swing adds another +25% incoming damage stack. Scales predictably regardless of enemy DR. After 3 procs, that target is taking +75% from everyone. Enables the whole party, not just physical. |
| 5 | Lv 45 | **Dispel** | Deal normal damage and remove all buffs from the target | 4 | Every 4th swing strips enemy buffs. Essential for boss zones where monsters self-buff (enrage, shields, damage ramp). Useless against enemies that don't buff. A niche pick you swap in when the zone demands it. |

**Active trade-offs:** Bash = frequent CC. Intercept = zero damage, total party protection. Shield Slam = tiny sustained DPS. Sunder = strip enemy armor for party. Challenge = periodic single-target aggro. Intercept is the "pure tank" pick; Bash is the "CC tank"; Sunder is the "party enabler"; Challenge is the middle ground between protection and damage.

---

## Archer (Physical DPS)

*Role: High physical damage, target priority, crit-based burst. Glass cannon — needs protection.*

### Passives (choose 4 of 6)

| # | Learn | Name | Effect | Notes |
|---|-------|------|--------|-------|
| 1 | Lv 1 | **Pierce** | 20% chance to crit (2x damage) | Simple, consistent DPS boost. Always good. Multiplicative with Bard Rally. |
| 2 | Lv 10 | **Marksman** | +15% damage against targets above 75% HP | Anti-synergy with Cut Down active (targets lowest HP). Rewards spreading damage. Better in multi-monster fights where fresh targets are available. |
| 3 | Lv 20 | **Brave** | +25% damage when positioned in the front column (col 2) | High risk, high reward. Glass cannon in the front line — you'll get targeted by monsters more but hit significantly harder. Almost requires a Knight running Intercept to survive. By Lv20 you have 3 passive slots so it's a real choice, not forced. |
| 4 | Lv 30 | **Exploit Weakness** | +30% damage against bleeding or stunned targets | Combo passive. Self-synergy with Bleed active. Cross-class synergy with Knight Bash/Bard Drumroll stuns. Does nothing without the right setup. |
| 5 | Lv 40 | **Precision** | +100% critical damage | Doubles down on crit builds. With Pierce (20% crit), crits now deal 3x instead of 2x. Useless without a crit source. Could also scale with future crit gear. |
| 6 | Lv 50 | **Focus** | Each consecutive attack on the same target increases damage by 10% (resets on target switch) | Rewards single-target focus. Anti-synergy with AoE actives and Marksman (which wants target switching). Best on boss-type monsters. |

**Why earlier skills stay good:** Pierce is a flat 20% DPS increase against everything — no conditions, no ramp. Brave is a huge damage boost if you can survive the front line. Later passives are conditional (Marksman, Exploit Weakness) or build-dependent (Precision needs crit, Focus needs single-target).

### Actives (choose 1 of 5)

| # | Learn | Name | Effect | CD | Notes |
|---|-------|------|--------|----|-------|
| 1 | Lv 5 | **Cut Down** | Target the lowest HP enemy (normal damage) | 3 | Finish off wounded monsters. Simple, effective, always relevant. |
| 2 | Lv 15 | **Triple Shot** | Attack 3 random enemies for 50% damage each | 4 | AoE pressure. Good vs many weak enemies. Less efficient on single targets. 150% total but spread out. |
| 3 | Lv 25 | **Snipe** | Deal 200% damage to a single target, ignoring DR | 5 | The nuke. Huge single-target burst but long cooldown. Great for finishing boss-type enemies. |
| 4 | Lv 35 | **Bleed** | Deal normal damage and apply a bleed: 20% of the hit's damage dealt over 3 ticks (stacks) | 3 | DoT active. Every 3rd swing adds a bleed stack. Rewards long fights — better when the party has a good tank/healer extending combat. Synergizes with Exploit Weakness (+30% vs bleeding targets). |
| 5 | Lv 45 | **Crippling Shot** | Deal normal damage and reduce target's damage by 30% for 3 turns | 3 | DPS class contributing to survival. Doesn't deal extra damage — trades potential burst for party safety. |

**Active trade-offs:** Cut Down = finish wounded targets. Triple Shot = AoE pressure. Snipe = single-target nuke. Bleed = sustained DoT (combos with Exploit Weakness). Crippling Shot = trade damage for party safety.

---

## Priest (Healer / Holy Protector)

*Role: Keep the party alive, reduce magic damage, deal holy damage. The party glue — mediocre solo, transformative in a group.*

### Passives (choose 4 of 6)

| # | Learn | Name | Effect | Notes |
|---|-------|------|--------|-------|
| 1 | Lv 1 | **Bless** | +2 magical/holy DR for the whole party per level | Party-wide protection. Always valuable. Scales with level like Knight Guard but covers a different damage type and helps everyone. |
| 2 | Lv 10 | **Devotion** | +3% healing power per level (increases all healing done) | Scaling multiplier on all heals. At Lv 50 that's +150% healing. Makes Minor Heal massive. Selfish in the sense that it only boosts YOUR heals. |
| 3 | Lv 20 | **Blessed Arms** | All party members' attacks deal +1 holy damage per Priest level | Makes the whole party deal holy damage. In non-undead zones this is just small bonus damage — doesn't compete with Bard Rally. In undead zones this is essential, letting every class contribute to killing undead. Synergizes with multi-hit skills (Mage Magic Missile, Archer Triple Shot). |
| 4 | Lv 30 | **Consecrate** | Undead killed by any party member stay dead (don't respawn) | Zone-specific but essential. Without this, undead zones are a war of attrition you can't win. With it, the party can actually clear. Does nothing in non-undead zones. The reason you bring a Priest to undead content. |
| 5 | Lv 40 | **Martyr** | When the Knight takes damage, the Priest's next heal is 25% stronger | Direct Knight-Priest synergy. The more the Knight tanks, the harder the Priest heals. Rewards the intended party structure. Stacks with Devotion for enormous heals after the Knight eats a big hit. Useless without a Knight in the party. |
| 6 | Lv 50 | **Resurrection** | Once per battle, when an ally would die, they instead revive at 20% HP | Massively powerful but only triggers once and only matters if someone would die. Worthless in easy fights. Run-saving in hard content. |

**Why earlier skills stay good:** Bless is the only party-wide magic DR in the game — irreplaceable. Devotion makes your heals scale forever. Blessed Arms is the key to undead content. Later passives are situational (Consecrate in undead zones, Martyr with a Knight, Resurrection as insurance).

### Actives (choose 1 of 5)

| # | Learn | Name | Effect | CD | Notes |
|---|-------|------|--------|----|-------|
| 1 | Lv 5 | **Minor Heal** | Heal the lowest %-HP ally for level x 4 HP | 1 | The workhorse. CD1 means constant healing. Scales with Devotion. Reliable, never bad. |
| 2 | Lv 15 | **Smite** | Deal normal physical damage plus level x 3 bonus holy damage to undead | 2 | The anti-undead active. Against living enemies it's just a normal hit. Against undead the bonus holy damage is significant. Note: Priest auto-attacks are physical — holy damage only comes from skills and Blessed Arms. |
| 3 | Lv 25 | **Cure** | Remove all debuffs from the lowest-HP ally | 3 | Cleanse active. Essential in zones where monsters apply bleeds, stuns, or damage debuffs. Useless if nothing debuffs. The Priest's utility pick — trades healing throughput for debuff control. |
| 4 | Lv 35 | **Mending** | Apply a heal-over-time to the lowest %-HP ally: level x 2 HP per tick for 3 ticks | 2 | HoT that ticks between attacks. Less burst healing than Minor Heal but more total healing over the duration (level x 6 vs level x 4). Better in sustained fights where topping off matters more than emergency heals. Scales with Devotion. |
| 5 | Lv 45 | **Sanctuary** | Instead of attacking, shield the lowest-HP non-Knight ally — absorb up to level x 4 incoming damage (any type) this round | 1 | CD1 full protection mode. Every swing is replaced with a damage shield on the squishiest non-Knight. Zero damage output. Matches Minor Heal's scaling (level x 4) but prevents damage instead of healing it. The "keep the Archer/Mage alive" pick. |

**Active trade-offs:** Minor Heal = steady healing (CD1). Smite = anti-undead damage (CD2). Cure = debuff removal (CD3). Mending = HoT sustain (CD2). Sanctuary = zero damage, full squishy protection (CD1). Minor Heal and Sanctuary are both CD1 "full commitment" picks — one heals, one prevents.

---

## Mage (Magical DPS)

*Role: High magical damage, AoE potential, burns through magic-resistant enemies. Glass cannon with a different flavor than Archer.*

### Passives (choose 4 of 6)

| # | Learn | Name | Effect | Notes |
|---|-------|------|--------|-------|
| 1 | Lv 1 | **Burn** | +2 magical damage per level | Simple flat damage scaling. Always relevant. At Lv 50, +100 damage on every hit. |
| 2 | Lv 10 | **Intensify** | Reduce auto-attack damage by 50%, but active skill damage increased by 50% | Trade-off passive. Dramatically boosts your active (Magic Missile becomes devastating) but guts your normal attacks. Best with low-CD actives. |
| 3 | Lv 20 | **Ignite** | Normal attacks apply a burn: 25% of damage dealt over 3 ticks (magical) | DoT like Archer Bleed but magical damage type. Bypasses physical DR. Stacks from multiple hits. Anti-synergy with Intensify (weaker autos = weaker DoT). |
| 4 | Lv 30 | **Arcane Surge** | Every second active skill cast deals double damage | Rhythm-based burst. Every other active proc hits twice as hard. With Zap CD1: alternating 75% / 150%. With Magic Missile CD3: every other burst is devastating. Rewards active-heavy builds but doesn't stack multiplicatively with Intensify's +50% — they're additive on the big hit. |
| 5 | Lv 40 | **Overflow** | Overkill damage on a single-target hit splashes to a random enemy (does not trigger on AoE skills) | Rewards big single-target hits that overkill. Great for cleaning up weak mobs — nuke one, splash kills another. Anti-synergy with AoE actives (Chain Lightning, Blizzard) since it only triggers on single-target. Pairs well with Zap, Magic Missile, and Arcane Blast. |
| 6 | Lv 50 | **Scorch** | Enemies the Mage damages take +10% magical damage from all sources for 2 turns | Debuff that benefits all magical damage dealers. Self-stacking in long fights. Cross-class synergy if there's another Mage or Priest (Blessed Arms holy damage). The Mage equivalent of Knight Sunder but passive and weaker per-stack. |

**Why earlier skills stay good:** Burn is unconditional damage on every attack — always equipped. Intensify is the biggest active DPS boost. Ignite is the best sustained DoT. Later passives are situational: Arcane Surge for active-heavy builds, Overflow for single-target, Scorch for party magical synergy.

### Actives (choose 1 of 5)

| # | Learn | Name | Effect | CD | Notes |
|---|-------|------|--------|----|-------|
| 1 | Lv 5 | **Magic Missile** | 4 hits at 30% damage each (120% total, magical) | 3 | Multi-hit burst every 3rd swing. Each hit is reduced by DR separately, but 4 chances to trigger on-hit effects (Ignite, Scorch). Great with Intensify (+50% = 180% total). |
| 2 | Lv 15 | **Zap** | Deal 75% damage to a single target | 1 | Every swing is a spell. Consistent, reliable magical damage. With Intensify: 112.5%. With Arcane Surge: alternating 75% / 150%. The "always casting" pick. Triggers Overflow on every hit. |
| 3 | Lv 25 | **Blizzard** | Deal 100% damage to all enemies | 6 | Full AoE nuke on a long cooldown. Devastating when it fires — 100% to everything. 5 auto-attacks between casts. Best in large encounters. Doesn't trigger Overflow (AoE). |
| 4 | Lv 35 | **Chain Lightning** | Deal 10% damage to all enemies | 1 | Every swing hits everything, but weakly. Constant AoE pressure. Great for keeping Scorch/Ignite applied to all targets. Doesn't trigger Overflow (AoE). Anti-synergy with Intensify (10% boosted to 15% is still tiny per target). |
| 5 | Lv 45 | **Arcane Blast** | Deal 250% damage to a single target (magical) | 5 | The single-target nuke. Highest single hit in the game. With Intensify: 375%. With Arcane Surge on the double-damage proc: 500%/750%. Triggers Overflow — overkill splashes to another enemy. |

**Active trade-offs:** Magic Missile = burst multi-hit (CD3). Zap = constant single-target (CD1). Blizzard = massive AoE nuke (CD6). Chain Lightning = constant weak AoE (CD1). Arcane Blast = single-target delete (CD5). Two CD1 options with very different identities — Zap is single-target focused, Chain Lightning is AoE spread.

---

## Bard (Support)

*Role: Buff the party, disrupt enemies, make everyone better. Worst solo class in the game, best party member in the game.*

### Passives (choose 4 of 6)

| # | Learn | Name | Effect | Notes |
|---|-------|------|--------|-------|
| 1 | Lv 1 | **Rally** | +20% damage to the whole party per party member | The defining Bard skill. In a 5-player party, that's +100% damage for everyone. Useless solo (+20% to just you). The reason you want a Bard. |
| 2 | Lv 10 | **Tempo** | Reduce Bard's active cooldown by 1 (minimum 1) | First CD reduction. Dissonance CD3→CD2, Drumroll CD3→CD2, War Song CD4→CD3, Lullaby CD5→CD4, Chaos CD6→CD5. Early investment in casting frequency. Stacks with Encore at Lv50. |
| 3 | Lv 20 | **Nimble** | +3% dodge chance for each party member (party-wide) | Dodge aura. In a full party, +15% dodge for everyone. Knight Intercept catches the big hits, dodge handles the rest. Solid in any party but better with more members. |
| 4 | Lv 30 | **Inspiration** | +20% XP rate for the whole party | Not a combat passive — pure progression speed. The Bard makes the party level faster. Always valuable, always worth having a Bard around even if the zone is easy. The "I want a Bard in my party even when we don't need support" passive. |
| 5 | Lv 40 | **Unnerve** | Reduce enemy damage by 5% per party member | Passive party-wide damage reduction that scales with party size. In a 5-player party, enemies deal 25% less. Stacks with Knight DR, Priest Bless. The Bard making everyone tankier just by being there. |
| 6 | Lv 50 | **Encore** | Reduce Bard's active cooldown by another 1 (minimum 1) | Stacks with Tempo for -2 CD total. Dissonance CD3→CD1 (every swing). Drumroll CD3→CD1 (every swing). War Song CD4→CD2. Lullaby CD5→CD3. Chaos CD6→CD4. The Bard becomes a machine gun. |

**Why earlier skills stay good:** Rally is the single strongest party buff in the game — almost always equipped. Tempo is an early power spike for any active. Nimble is the only source of party-wide dodge. Later passives are powerful but serve different needs (Inspiration for leveling, Unnerve for survival, Encore for casting speed).

### Actives (choose 1 of 5)

| # | Learn | Name | Effect | CD | Notes |
|---|-------|------|--------|----|-------|
| 1 | Lv 5 | **Dissonance** | Deal 0.2 damage per Bard level to all enemies | 3 | Small AoE damage. The Bard's only direct damage — tiny, but it's something. With Tempo: CD2. With Tempo + Encore: CD1 (every swing). Applies Mage Scorch if present. |
| 2 | Lv 15 | **Drumroll** | 10% chance per enemy to stun for 1 turn | 3 | AoE disruption. Low chance per target but hits all enemies. With Tempo: CD2. With Tempo + Encore: CD1 — 10% stun check on every enemy, every swing. |
| 3 | Lv 25 | **War Song** | Increase party damage by 10% for the rest of combat | 4 | Permanent stacking buff. Each proc adds another +10%. Multiplicative with Rally. With Tempo + Encore: CD2, stacking +10% every other swing. Fights get out of hand fast. |
| 4 | Lv 35 | **Lullaby** | All enemies deal 20% less damage for 3 turns | 5 | Party-wide damage reduction. Better for survival in hard zones. Doesn't stack with itself. With Tempo: CD4. With Tempo + Encore: CD3, nearly permanent uptime. |
| 5 | Lv 45 | **Chaos** | All enemies attack a random enemy (including chance to hit themselves) this round | 6 | Complete disruption. Enemies turn on each other for one round. With Tempo + Encore: CD4, firing regularly. Incredible in large encounters — more enemies = more friendly fire. |

**Active trade-offs:** Dissonance = tiny AoE damage. Drumroll = AoE stun chance. War Song = permanent stacking party damage. Lullaby = enemy damage reduction. Chaos = enemies hit each other. Tempo and Encore transform every active — the Bard's power curve is about casting frequency. War Song at CD2 with permanent stacking is probably the scariest late-game pick.

---

## Cross-Class Synergies (Examples)

| Combo | How It Works |
|-------|-------------|
| Knight Intercept + Bard Nimble | Knight blocks the big hit, party dodges the rest |
| Knight Tenacity + Priest Devotion | Knight receives 30% more healing, Priest heals 150% harder at Lv50. Together: enormous sustain on the tank. |
| Knight Shield Bash + Iron Will | Can't be stunned, but stuns enemies back when they hit you. Defensive CC loop. |
| Knight Sunder + Archer/Mage | Knight stacks +25% incoming damage marks, both DPS classes benefit equally. After 3 Sunders that's +75% from everyone. |
| Priest Devotion + Bard Harmony | Healing power up by 150% AND healing received up by 15% — stacking multipliers for massive throughput. |
| Priest Blessed Arms + Mage Magic Missile | 4 hits = 4 procs of holy damage. Multi-hit skills multiply the value of Blessed Arms in undead zones. |
| Priest Martyr + Knight Intercept | Knight draws all hits (Intercept CD1), each hit charges the Priest's next heal by 25%. Constant massive heals. |
| Priest Sanctuary + Archer Brave | Archer stands in front for +25% damage, Sanctuary shields them every tick. Priest + Archer front-line combo. |
| Archer Bleed (active) + Exploit Weakness | Self-combo: Bleed applies DoT, then every subsequent hit gets +30% vs bleeding targets. |
| Archer Brave + Knight Intercept | Archer in the front column for +25% damage, Knight redirects all incoming hits to themselves. Glass cannon behind a bodyguard. |
| Archer Exploit Weakness + Knight Bash | Knight stuns, Archer gets +30% on stunned targets. |
| Mage Intensify + Magic Missile | -50% auto / +50% active → Magic Missile effectively deals 180% instead of 120%. |
| Mage Overflow + Arcane Blast | 250% nuke overkills → splash damage finishes off another enemy. Single-target becomes pseudo-AoE. |
| Mage Scorch + Priest Blessed Arms | Scorch makes enemies take +10% magical, Blessed Arms adds holy per hit. Party-wide magical damage amplification in undead zones. |
| Bard Tempo + Encore + Drumroll | CD3 → CD1. 10% stun check on every enemy, every single swing. Permanent AoE disruption. |
| Bard Tempo + Encore + War Song | CD4 → CD2. Stacking +10% party damage every other swing. Fights snowball fast. |
| Bard Unnerve + Knight Guard + Priest Bless | Triple layer of damage reduction: flat physical DR, flat magical DR, and % reduction from Unnerve. Party becomes very hard to kill. |
| Bard Chaos + large encounters | More enemies = more friendly fire damage. In a 6-enemy fight, that's 6 attacks aimed randomly at enemies. |
| Knight War Cry + Archer DPS | Knight below 50% HP = Archer gets +25% damage. Creates tension: do you heal the Knight or let them stay low for the DPS boost? |
| Knight War Cry + Knight Tenacity | Opposing incentives — Tenacity wants you healed up, War Cry wants you low. Player has to choose which matters more for this fight. |

---

## Open Questions

1. **Mage Volatile Magic** — is a crit-boosting passive worth a slot if there's no reliable crit source for Mages yet? Options: give it 5% innate crit, replace it with something else, or lean into it as a gear-dependent build-around.

2. **Bard War Song stacking** — permanent +10% party damage per cast, no cap. With Tempo + Encore that's CD2. After 10 procs (+100% party damage) fights become trivial. Does battle length naturally limit this, or does it need a cap?

3. **Priest Resurrection** — once-per-battle revive is either useless or run-saving. Is that OK for a Lv50 passive? It's not "better" than Bless or Devotion — it's insurance. Could feel underwhelming if you never die.

4. **Active cooldowns** — with Bard Encore reducing CDs by 1, should we be careful about CD2 actives becoming CD1 (essentially every other attack)? Currently only Bash (Knight) is CD2. Probably fine since Encore is a Lv50 passive competing with other strong options.

5. **Intensify + Burn interaction** — Burn adds flat damage per level to every hit. Intensify halves auto-attack damage. Does Burn get halved too (it's part of the auto), or is it separate? Needs a ruling. If Burn is halved by Intensify, that's a real trade-off. If not, Intensify + Burn is too strong.

6. **Solo vs Party balance** — several Lv1 skills are the best solo picks (Guard, Pierce, Burn). Bard Rally is nearly useless solo. Is that OK for the class designed to be "worst solo, best in party"?

7. **Knight Tenacity + Bard Harmony stacking** — Knight receives +30% healing, Bard gives all allies +15% healing received. Multiplicative or additive? Multiplicative (1.3 × 1.15 = 1.495) is cleaner but stronger. Additive (+45%) is simpler. Needs a ruling.

9. **Sunder stacking** — +25% damage from all sources, stacking with no cap, could get wild in long fights. At 10 stacks that's +250% incoming damage. Does it need a cap, or does battle length naturally limit it? Every 3rd swing = ~3 stacks per 9 ticks. Probably fine since battles don't last forever, but worth watching.

---

## TODO

- [ ] Priest auto-attack damage type needs to change from holy to physical. Holy damage only comes from skills (Smite) and passives (Blessed Arms).
- [ ] Undead respawn mechanic — all undead respawn after 1 round if the battle isn't over. Consecrate passive prevents this.
- [ ] Run button — with undead zones being very difficult without a Priest, players need a way to flee.
- [ ] Mage tree — not yet reviewed/revised
- [x] Bard tree — reviewed and revised
- [ ] Holy damage type clarification — holy only affects undead? Does Bless (magical/holy DR) still reduce holy damage from enemy undead priests/etc?
- [x] Mage Volatile Magic — replaced with Scorch (+10% magical damage debuff)
- [x] Mage tree — reviewed and revised
