import type { Screen } from './ScreenManager';
import { PATCH_NOTES } from './PatchNotes';
import { logout } from '../network/AuthClient';
import { getQuestHintsEnabled, setQuestHintsEnabled } from '../settings/UserSettings';

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
        <div class="settings-section">
          <div class="settings-section-title">Player options</div>
          <ul class="settings-options-list">
            <li class="settings-option-row">
              <label class="settings-option">
                <input type="checkbox" id="toggle-quest-hints" ${getQuestHintsEnabled() ? 'checked' : ''}>
                <span class="settings-option-label">Quest hints</span>
              </label>
              <div class="settings-option-desc">Highlight quest-giver rooms and visit objectives on the map.</div>
            </li>
          </ul>
        </div>
        <div class="settings-buttons">
          <button class="pixel-btn settings-btn" id="btn-patch-notes">Patch Notes</button>
          <button class="pixel-btn settings-btn settings-btn-danger" id="btn-sign-out">Sign Out</button>
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

    const questHintsToggle = this.container.querySelector('#toggle-quest-hints') as HTMLInputElement;
    questHintsToggle.addEventListener('change', () => {
      setQuestHintsEnabled(questHintsToggle.checked);
    });

    const btnSignOut = this.container.querySelector('#btn-sign-out') as HTMLButtonElement;
    btnSignOut.addEventListener('click', async () => {
      if (!confirm('Sign out of your account?')) return;
      btnSignOut.disabled = true;
      btnSignOut.textContent = 'Signing out...';
      try {
        await logout();
      } finally {
        window.location.reload();
      }
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
