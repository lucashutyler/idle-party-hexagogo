export const PATCH_NOTES: { version: string; notes: string[] }[] = [
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
