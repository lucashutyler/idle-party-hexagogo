import type { Screen } from './ScreenManager';

const PATCH_NOTES: { version: string; notes: string[] }[] = [
  {
    version: '2026.03.28.2',
    notes: [
      'Expanded skill trees — each class now has 11 skills (6 passives, 5 actives) from level 1 to 50',
      'Added 2 new equip slots: Passive at level 30 and Passive at level 50 (5 total: 4 passive + 1 active)',
      'Knight: Fortify, Shield Bash, Iron Will, Tenacity, War Cry passives; Intercept, Shield Slam, Sunder, Dispel actives',
      'Archer: Marksman, Brave, Exploit Weakness, Precision, Focus passives; Triple Shot, Snipe, Bleed, Crippling Shot actives',
      'Priest: Devotion, Blessed Arms, Consecrate, Martyr, Resurrection passives; Smite, Cure, Mending, Sanctuary actives',
      'Mage: Intensify, Ignite, Arcane Surge, Overflow, Scorch passives; Zap, Blizzard, Chain Lightning, Arcane Blast actives',
      'Bard: Tempo, Nimble, Inspiration (+20% XP), Unnerve, Encore passives; Dissonance, War Song, Lullaby, Chaos actives',
      'New combat mechanics: DoTs, HoTs, damage shields, stacking marks, damage debuffs, buff removal, and more',
      'Bard Tempo + Encore reduce active cooldowns by up to 2, enabling every-swing casting at high levels',
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

export class SettingsScreen implements Screen {
  private container: HTMLElement;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;

    this.container.innerHTML = `
      <div class="settings-content">
        <div class="settings-header">
          <div class="settings-icon">⚙</div>
          <h2 class="settings-title">Settings</h2>
        </div>
        <div class="settings-buttons">
          <button class="pixel-btn settings-btn" id="btn-patch-notes">Patch Notes</button>
        </div>
        <div id="patch-notes-panel" class="patch-notes-panel" style="display:none;">
          <button class="pixel-btn patch-notes-back" id="btn-patch-back">Back</button>
          <div class="patch-notes-list">
            ${PATCH_NOTES.map(p => `
              <div class="patch-note-entry">
                <div class="patch-note-version">${p.version}</div>
                <ul class="patch-note-items">
                  ${p.notes.map(n => `<li>${n}</li>`).join('')}
                </ul>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    const btnPatchNotes = this.container.querySelector('#btn-patch-notes') as HTMLButtonElement;
    const btnBack = this.container.querySelector('#btn-patch-back') as HTMLButtonElement;
    const patchPanel = this.container.querySelector('#patch-notes-panel') as HTMLElement;
    const buttonsSection = this.container.querySelector('.settings-buttons') as HTMLElement;
    const headerSection = this.container.querySelector('.settings-header') as HTMLElement;

    btnPatchNotes.addEventListener('click', () => {
      buttonsSection.style.display = 'none';
      headerSection.style.display = 'none';
      patchPanel.style.display = '';
    });

    btnBack.addEventListener('click', () => {
      patchPanel.style.display = 'none';
      buttonsSection.style.display = '';
      headerSection.style.display = '';
    });
  }

  onActivate(): void {
    // Reset to main settings view
    const patchPanel = this.container.querySelector('#patch-notes-panel') as HTMLElement;
    const buttonsSection = this.container.querySelector('.settings-buttons') as HTMLElement;
    const headerSection = this.container.querySelector('.settings-header') as HTMLElement;
    patchPanel.style.display = 'none';
    buttonsSection.style.display = '';
    headerSection.style.display = '';
  }

  onDeactivate(): void {
    // no-op
  }
}
