import type { Screen } from './ScreenManager';

const PATCH_NOTES: { version: string; notes: string[] }[] = [
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
