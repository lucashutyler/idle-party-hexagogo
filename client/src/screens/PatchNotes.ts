export const PATCH_NOTES: { version: string; notes: string[] }[] = [
  {
    version: '2026.06.21.1',
    notes: [
      'Some rooms now lead to whole new maps! Step onto a passage — like a manhole into the sewers beneath a town — and tap "Enter" to travel there with your party.',
      'You only see the map you\'re currently on; other maps stay hidden until you travel to them, then build up their own fog-of-war as you explore.',
      'Travelling moves your whole party at once and drops you on a specific room of the destination map. Find the way back to return.',
    ],
  },
  {
    version: '2026.06.14.1',
    notes: [
      'Dungeons are open for business! Stand on a dungeon room and tap "Enter" — your whole party dives in together and fights through its floors.',
      'Each dungeon is a private run for your party: clear a floor and you automatically descend to the next, all the way to the final floor.',
      'Beat the last floor to complete the dungeon. Floors can hand out bonus loot, and the first time you ever clear a dungeon you get a special one-time reward.',
      'Dungeons can require a minimum/maximum level, certain classes, a party size, or a key item to enter — some keys are consumed on the way in.',
      'Wipe inside a dungeon and your party is driven back to the entrance — regroup and try again.',
      'Tap "Leave Dungeon" any time to bail out back to the entrance. Your run keeps going even while you\'re offline, just like the rest of the world.',
      'Parties delving a dungeon now show a 🗝️ marker on the map at the entrance, and the room popup tells you which dungeon they\'re in.',
      'First-clear rewards can now include bonus XP and gold, on top of any item rewards.',
      'Dungeon rewards can be restricted by class, so a Knight and a Bard can earn different loot from the same dungeon.',
    ],
  },
  {
    version: '2026.06.02.1',
    notes: [
      'Map: your party marker, movement path, hover outline, and other players\' flags now show up on rooms away from your starting area again — they were being hidden once you travelled out a bit.',
      'Room popup: when a room is packed with players, the list of parties now scrolls inside the popup instead of growing past the screen — the close and action buttons always stay visible.',
    ],
  },
  {
    version: '2026.05.26.1',
    notes: [
      'Map is now rendered with WebGL — panning and zooming should feel substantially smoother on every device, especially mobile and larger maps. Idle map screens cost effectively zero performance now.',
      'Map: hovering an unexplored room now shows a tooltip again ("{zone}: Unexplored Room"), matching the room popup.',
    ],
  },
  {
    version: '2026.05.13.2',
    notes: [
      'Map performance improvements — panning and zooming is smoother, especially on larger maps and mobile.',
      'Map shadow fixed on larger maps — no more drifting inside the island. The shadow now reads as a single drop from the same direction at every zoom level.',
      'Room popup: other players are now grouped by party — each visible party gets its own box with its members inside, instead of one lump of "other parties".',
      'You can now click a far room in your zone that has other players on it and see who\'s there (grouped by party, same as your current room).',
      'Missing artwork no longer flashes the broken-image icon while loading. Item slots, nav icons, portraits, and popups stay tidy and fade in once the art is ready.',
      'Combat log: fixed "You has fallen!" → "You have fallen!"',
    ],
  },
  {
    version: '2026.05.13.1',
    notes: [
      'Trade modal: the item picker now uses a frozen inventory snapshot taken when you open the modal, so the global tick no longer rebuilds the list and yanks you back to the top. The server validates the offer at submission time, as before',
      'Chat with user: clicking Chat on a user popup now opens the global chat pop-out pre-filled for a DM to that player',
      'Mobile chat: opening the chat pop-out no longer steals focus / pops the soft keyboard over the timeline — tap the input when you actually want to type',
      'Combat: tapping the locked Run button on mobile shows the "Available after 5 rounds" hint again (the disabled attribute was swallowing the click)',
      'Skill slot picker: future skills you have not unlocked yet show up as dimmed rows with "Unlocks at Lv X" so you can preview what is coming',
    ],
  },
  {
    version: '2026.05.11.1',
    notes: [
      'Admin: artwork upload added to all CRM entities (monsters, sets, shops, zones, tile types) — same pipeline as items',
      'Monster popup now shows an optional flavor description (set in the admin monster form); the placeholder "drops/abilities/resistances are unknown" hint is gone',
      'Settings: Sign Out / Patch Notes buttons now use the pixel font (were defaulting to Arial)',
      'Chat: clicking a sender name opens the user popup; clicking a channel tag (Global, Zone, Room, Party, Guild, DM) switches your composer to that channel. Server messages stay plain text. Per-channel colors preserved on the new clickable variants.',
      'Mobile chat: docks at the bottom of the screen instead of overlaying content — the active screen shrinks above so the visible center stays centered; the bottom nav + XP bar stay pinned at the viewport bottom. Drop shadows removed on mobile so the chat reads as a top-level layout bar rather than a floating popup',
      'Combat: restored the lunge / hit-flash / dodge-sidestep animations on combatant cards. On mobile, the attack lunge no longer clips combatants out of view at the tray edge.',
      'Map: tiles now layer in three stages — tile-type color (always), real artwork overlay if uploaded, otherwise the tile-type emoji. Tile artwork is baked into hex-clipped offscreen sprites on first load and the map drop-shadow is pre-blurred once per grid change, so pan/zoom stays smooth on mobile.',
      'Dev: vite proxy now forwards every artwork mount (parchment, monster, class, set, shop, zone, tile-type, combat-bg, room-bg, logo, nav/class/slot icons), not just /item-artwork — previously the other paths fell through to the SPA index in dev.',
    ],
  },
  {
    version: '2026.05.10.2',
    notes: [
      'Crafting skill! Each class now has its own craft skill (Knight=Smithing, Archer=Fletching, Priest=Inscription, Mage=Alchemy, Bard=Tinkering). Each finished craft grants XP toward your skill level',
      'Skill level + XP bar shown at the top of the Craft tab — watch it tick up as your queue completes',
      'Mage gets a starter Alchemy recipe: Brew Lesser Red Potion (consumable — no effect yet, full potion system coming soon)',
      'Items can now be configured in the admin as consumables with custom emoji + color (potions etc.). Tooltip on consumables reads "Not usable yet — coming soon!" until the consumables framework lands',
      'New admin Recipes tab — author/edit/delete recipes without touching JSON',
    ],
  },
  {
    version: '2026.05.10.1',
    notes: [
      'New: Crafting tab! Unlocks at level 20. Each class has a starter recipe, plus one shared recipe anyone can use',
      'Single FIFO queue (up to 5 jobs). Materials are reserved when you queue a job — cancel anytime to get them back',
      'Crafting runs in the background like combat — jobs complete on schedule even while you\'re offline',
    ],
  },
  {
    version: '2026.05.09.2',
    notes: [
      'NPCs have arrived! Rooms with a 💬 badge have someone to talk to — chat them up for quests. Slay, collect, or visit to earn XP, gold, and item rewards',
    ],
  },
  {
    version: '2026.05.09.1',
    notes: [
      'Rooms can now link to Dungeons, but the feature is still under construction. Expect big challenges ahead!',
    ],
  },
  {
    version: '2026.05.04.1',
    notes: [
      'UI overhaul — sweeping pass to make the game feel less like a web app and more like a game',
      'Char and Items screens merged into a single Inventory tab — silhouette + equipped gear + skill loadout above the fold, condensed stat card (ATK/DR/MR/HP) + inventory grid below',
      'Skill points removed — skills now auto-unlock at their level milestone. Equipping is the only constraint (5 slots, swap freely)',
      'Skill loadout UI: clicking a slot opens a popup with all unlocked skills of the matching type. Move slot 1 → slot 3 leaves slot 1 empty (no auto-shuffle)',
      'Inventory grid now groups items with visible headers when sorted by Rarity or Type (Newest stays chronological)',
      'Stat card abbreviations have click-to-show tooltips — tap ATK/DR/MR/HP to see the long form',
      'Combat: bare sprites are now cards — image + name + HP bar bundled together. Multi-line names allowed for monsters (e.g. "Skeletal Warrior")',
      'Click any monster in combat to see its name + image (drops/abilities stay hidden for now)',
      'Combat backgrounds — per-zone default with optional per-tile override (drop art into /combat-bg-artwork)',
      'New Chat tab on the bottom nav opens a global chat pop-out. Floating, draggable, freely resizable on desktop; full-screen or bottom-sheet on mobile (toggle with the layout button)',
      'Combat log stays on the Combat screen (intentionally NOT merged into chat)',
      'Persistent XP bar lives directly above the bottom nav now, visible on every screen — level on the left, XP fill across',
      'Bottom nav restyled — depth, fancier borders, glow on the active tab. Now 6 tabs: Combat, Map, Inventory, Social, Chat, Settings',
      'Social tab reworked — Users renamed to Leaderboard (sort by level), default sub-tab is now Party, Chat sub-tab removed (use the new Chat pop-out)',
      'Map: Phaser is gone — the world map is now a custom Canvas implementation. Snappier loads, parchment background, tile shadows for depth, scroll bounce-back, 2-finger pinch zoom on mobile, smarter default zoom (≥15 tiles visible)',
      'Other parties on the map are now flagged per-tile so you can see them at a glance instead of just an aggregate count',
      'Room popups have three states — current room (full-screen, background art, parties grouped visually), remote room (smaller popup with a Go button), undiscovered room (minimal). Travel-arrival expands the popup to signal you have arrived',
      'New retro font — Silkscreen + Pixelify Sans replace Press Start 2P, fixing the 6/G readability problem',
      'New splash + logo placeholders on first load (drop your real artwork in /logo-artwork/ to override)',
      'Image-everywhere convention — anywhere a name shows, an image can show beside it. Monsters, classes, items, sets, shops, zones, rooms — all read from `/<kind>-artwork/{id}.png` with a placehold.co fallback when art is missing',
    ],
  },
  {
    version: '2026.05.02.1',
    notes: [
      'Bug fix: Priest Blessed Arms holy damage was being mislabeled as physical damage in the combat log when the physical hit was fully resisted. The HP math was always correct; now the log correctly shows "0 physical + X holy" so it\'s clear holy damage isn\'t blocked by physical resistance',
    ],
  },
  {
    version: '2026.04.29.3',
    notes: [
      'Sets now support breakpoints — partial set rewards at e.g. 2/4 and 4/4 pieces. Item tooltips show every tier and highlight the one currently active',
      'Sets can be class-restricted — class-locked sets show as "Set Name (Knight)" in tooltips, and only activate for the listed classes',
      'Items can belong to multiple sets across different classes (e.g., Glowing Crystal Bracers in both a Bard set and a Knight set). The admin panel rejects two sets sharing an item for the same class',
      'Set bonuses no longer stack within a single set — only the highest unlocked breakpoint applies',
      'Set bonuses are now actually applied in combat: HP, attack, DR/MR, damage %, damage resistance %, and active-skill cooldown reduction all take effect',
    ],
  },
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
