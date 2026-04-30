export const PATCH_NOTES: { version: string; notes: string[] }[] = [
  {
    version: '2026.04.29.2',
    notes: [
      'New: Send Gift action on the user popup — gift items to anyone, no same-room requirement',
      'Recipients see gifts in a new Mailbox section on the Items tab; Accept adds to inventory, Decline returns to sender',
      'Gifts that would push a stack over 99 are blocked at Accept time with a warning (not at send time, so they can stay in the mailbox until inventory frees up)',
      'Trades are now asynchronous! No same-room requirement, both sides can update offers freely, and trades persist across server restarts and movement',
      'You can now have multiple trades active at once (one per partner) — manage them all from the new Proposed Trades section on the Items tab',
      'Items tab gets a notification dot when you have mailbox items or a trade waiting on your response',
    ],
  },
  {
    version: '2026.04.29.1',
    notes: [
      'Set piece tooltips now show item names for pieces you don\'t own yet (was showing item GUIDs)',
      'Trade picker now lists every unequipped copy of an item — previously the entire stack was hidden if you had any copy equipped',
      'Shop sell list has the same fix — unequipped extras of an equipped item are now sellable',
    ],
  },
  {
    version: '2026.04.27.1',
    notes: [
      'Knight Intercept now correctly redirects only the next attack, not every attack until the Knight\'s next turn',
    ],
  },
  {
    version: '2026.04.22.1',
    notes: [
      'Monster skills (Fireball, Assassinate, etc.) now honor your defenses — equipment DR/MR, Knight Guard, Priest Bless, and damage shields all apply',
      'Bard Nimble dodge now applies to monster skills as well — including AoE (each player rolls dodge independently against Fireball)',
      'Knight Intercept now redirects single-target monster skills like Assassinate, not just normal attacks',
      'Knight Shield Slam now reflects only physical damage taken (magical fireballs no longer charge the reflect)',
      'Knight Shield Bash retaliation still triggers only on physical hits (unchanged behavior, now consistent across skills and basic attacks)',
      'Priest Martyr now triggers from any damage to a Knight — including DoTs and skill damage. Bonus is capped at one stack between heals',
    ],
  },
  {
    version: '2026.04.19.2',
    notes: [
      'Priests no longer waste a turn casting heal/cure/sanctuary on a no-op — they fall back to a normal attack instead',
      'Bard Drumroll stun chance buffed from 10% → 25% per enemy',
      'Bard Encore now reduces active skill cooldowns for the entire party (Tempo still self-only)',
      'Mage Ignite reworked: each auto-attack adds a permanent burn stack worth 25% of pre-resistance damage. Stacks last the rest of combat — devastating in long fights',
      'Shop sell now updates available quantity immediately and shows "You sold X for Y gold" confirmation',
      'New monster type — passive walls. They never attack and don\'t count toward victory, but they can block your line of attack on the grid',
    ],
  },
  {
    version: '2026.04.19.1',
    notes: [
      'Fixed party leave/kick sometimes teleporting the leaver to the starting room',
      'Party invites now auto-expire when either player leaves the room',
      'Party chat now announces joins, kicks, promotions, demotions, and ownership changes',
    ],
  },
  {
    version: '2026.04.15.1',
    notes: [
      'Characters no longer start as Adventurer — you pick your class right away',
      'Players are not visible in the world until they choose a class',
      'Welcome message now broadcasts when a new player picks their class',
      'Running from combat now moves the party forward (to discovered rooms only)',
      'Hovering over items on desktop now shows the item name instantly',
      'Player popup no longer cuts off the level when the name is long',
    ],
  },
  {
    version: '2026.04.03.2',
    notes: [
      'Item icons now show artwork when available, with rarity-colored frames',
      'Higher rarity items have animated glowing borders',
      'Equipment silhouette is larger and easier to read',
      'Viewing another player shows the same equipment layout as your own inventory',
      'Clicking an item on another player shows full item details',
    ],
  },
  {
    version: '2026.04.03.1',
    notes: [
      'Fixed bug where rings could corrupt equipment slots',
      'Two-handed weapons now use a dedicated equipment slot',
      'Removed dodge chance from equipment — Bard Nimble skill remains',
      'Added Magic Resistance (MR) stat to equipment — reduces magical damage',
      'Items screen reworked: square grid icons with rarity backgrounds and animated borders',
      'Click any item to see full details, stats, and set info',
      'Inventory search and sort (by rarity, type, or newest)',
      'Item sets: equip all pieces for bonus stats',
      'Shops: buy and sell items at designated rooms',
      'Items now have a gold value',
    ],
  },
  {
    version: '2026.04.02.1',
    notes: [
      'New tile types: Desert, Lava Field, Beach, Hedge, and Volcano',
      'Desert rooms require a Waterskin equipped by all party members to traverse',
      'Lava Field rooms require Magma Boots equipped by all party members to traverse',
      'Required traversal items are locked while on or en route to gated rooms',
      'Map editor now clones tile type, room name, and encounters from the selected room when adding adjacent rooms',
    ],
  },
  {
    version: '2026.04.01.1',
    notes: [
      'Fixed admin class switch not unlocking skills for the new class',
      'Fixed skills appearing unlockable before reaching the required level',
      'DOT and HOT effects are now grouped in the combat log (e.g. "receives 136 magical damage from ignite (x6)!")',
    ],
  },
  {
    version: '2026.03.31.2',
    notes: [
      'Overhauled the encounter system — monsters can now appear in mixed groups with randomized formations',
      'Monsters can now have resistances and vulnerabilities to different damage types',
      'Monsters can now use skills — watch out for fireballs, fear, and more',
      'Look out for more dangerous and varied encounters coming soon!',
    ],
  },
  {
    version: '2026.03.31.1',
    notes: [
      'Added Sign Out button in Settings',
    ],
  },
  {
    version: '2026.03.29.1',
    notes: [
      'Added Run button — escape combat after 5 rounds (no rewards)',
      'Round counter now displayed during combat',
      'Only party owners and leaders can trigger Run',
      'Fixed chat messages from filtered channels not being available after unfiltering',
    ],
  },
  {
    version: '2026.03.28.2',
    notes: [
      'Expanded skill trees — each class now has 11 skills (6 passives, 5 actives) from level 1 to 50',
      'Added 2 new equip slots: Passive at level 30 and Passive at level 50 (5 total: 4 passive + 1 active)',
      'Skills now auto-unlock as you level — no manual unlocking needed',
      'Knight: Fortify, Shield Bash, Iron Will, Tenacity, War Cry passives; Intercept, Shield Slam, Sunder, Dispel actives',
      'Archer: Marksman, Brave, Exploit Weakness, Precision, Focus passives; Triple Shot, Snipe, Bleed, Crippling Shot actives',
      'Priest: Devotion, Blessed Arms, Consecrate, Martyr, Resurrection passives; Smite, Cure, Mending, Sanctuary actives',
      'Mage: Intensify, Ignite, Arcane Surge, Overflow, Scorch passives; Zap, Blizzard, Chain Lightning, Arcane Blast actives',
      'Bard: Tempo, Nimble, Inspiration (+20% XP), Unnerve, Encore passives; Dissonance, War Song, Lullaby, Chaos actives',
      'New combat mechanics: DoTs, HoTs, damage shields, stacking marks, damage debuffs, buff removal, and more',
      'Bard Tempo + Encore reduce active cooldowns by up to 2, enabling every-swing casting at high levels',
      'Skill UI redesigned: active slot on the left, passive slots on the right; skill tree split into two columns',
      'Locked skills now show the level required to learn them',
      'Active skill usage now shows in the combat log (e.g., "uses Zap on Goblin for 12 damage")',
      'Skill section no longer resets scroll position on state updates',
      'Click party member names on the combat screen to open the user popup (View Player, Chat, etc.)',
    ],
  },
  {
    version: '2026.03.28.1',
    notes: [
      'Chat filter choices now persist across sessions — your toggled channels are saved to your account',
      'Combat log increased from 100 to 1000 entries',
      'Combat log can now be paused by scrolling up — a "Resume Live" button appears to jump back to live updates',
      'Added fullscreen toggle for the combat log',
      'Damage types (physical, magical, holy) are now shown and color-coded in the combat log',
    ],
  },
  {
    version: '2026.03.26.1',
    notes: [
      'Added View Player — click any username to see their level, class, guild, equipped items, skills, and party members',
      'Player level is now shown in the user popup menu',
    ],
  },
  {
    version: '2026.03.24.3',
    notes: [
      'Fixed item duplication exploit — equipping two-handed weapons with a full offhand stack no longer duplicates the mainhand item',
      'Fixed stale two-handed weapon state — unequipping a weapon that occupies both slots now always clears both slots correctly',
      'Added equipment slot validation to prevent items from being equipped into invalid slots',
      'Added player-to-player item trading — click a player in the same room to open the Trade option',
      'Trades require both players to be in the same room with at least one unequipped inventory item each',
      'Trade flow: propose an item → partner counters with their item → initiator confirms → items are swapped',
      'Trades auto-cancel on movement, disconnect, or explicit cancellation by either player',
    ],
  },
  {
    version: '2026.03.24.2',
    notes: [
      'Fixed chat not refreshing when resuming from a backgrounded tab — chat history is now re-fetched on resume',
    ],
  },
  {
    version: '2026.03.24.1',
    notes: [
      'Added Settings screen with Patch Notes viewer',
      'Fixed two-handed weapons: equipping a 2H when offhand inventory is full now shows the correct blocked-item prompt instead of a generic error',
      'Fixed two-handed weapons: force-equipping a 2H no longer silently destroys the offhand item without notification',
      'Added Server chat channel — server messages (welcome, shutdown) now appear in their own filterable channel instead of World chat',
    ],
  },
];
