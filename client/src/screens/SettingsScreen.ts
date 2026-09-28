import type { Screen } from './ScreenManager';
import { PATCH_NOTES } from './PatchNotes';
import { logout } from '../network/AuthClient';
import { getQuestHintsEnabled, setQuestHintsEnabled } from '../settings/UserSettings';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';
import type { GameClient } from '../network/GameClient';
import { renderNotificationPreferences } from '../ui/NotificationPreferences';
import { placeholderUrl } from '../ui/assets';
import type { AutoRetreatPct } from '@idle-party-rpg/shared';
import { AUTO_RETREAT_OPTIONS, DEFAULT_COMBAT_PREFS } from '@idle-party-rpg/shared';
import { autoRetreatLine, formatPct } from '../combat/ForecastFormat';

const SETTINGS_NAV_PLACEHOLDER = placeholderUrl('Settings', { w: 96, h: 96, glyph: '⚙️' });

export class SettingsScreen implements Screen {
  private container: HTMLElement;
  private optionsOverlay: HTMLElement | null = null;
  private optionsUnsubscribe?: () => void;
  private notifPrefsOverlay: HTMLElement | null = null;

  constructor(containerId: string, private gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;

    this.container.innerHTML = `
      <div class="settings-content">
        <div class="settings-header">
          <img class="settings-icon-img" src="/nav-icons/settings.png" alt="Settings"
               onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${SETTINGS_NAV_PLACEHOLDER}';}else{this.style.display='none';}" />
          <h2 class="settings-title">Settings</h2>
        </div>
        <div class="settings-buttons">
          <button class="pixel-btn settings-btn" id="btn-player-options">Player Options</button>
          <button class="pixel-btn settings-btn" id="btn-notifications">Notifications</button>
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

    const btnPlayerOptions = this.container.querySelector('#btn-player-options') as HTMLButtonElement;
    const btnNotifications = this.container.querySelector('#btn-notifications') as HTMLButtonElement;
    const btnPatchNotes = this.container.querySelector('#btn-patch-notes') as HTMLButtonElement;
    const btnBack = this.container.querySelector('#btn-patch-back') as HTMLButtonElement;
    const patchPanel = this.container.querySelector('#patch-notes-panel') as HTMLElement;
    const buttonsSection = this.container.querySelector('.settings-buttons') as HTMLElement;
    const headerSection = this.container.querySelector('.settings-header') as HTMLElement;

    btnPlayerOptions.addEventListener('click', () => this.openPlayerOptions());
    btnNotifications.addEventListener('click', () => this.openNotificationPreferences());

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

  /**
   * Player Options popup. Keeps each per-toggle setting wired here so adding
   * a new option is one HTML block + one change listener — no plumbing
   * through to SettingsScreen state.
   */
  openPlayerOptions(): void {
    if (this.optionsOverlay) {
      bringToFront(this.optionsOverlay);
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal" role="dialog" aria-label="Player Options">
        <div class="player-options-header">
          <span class="player-options-title">Player Options</span>
          <button class="player-options-close" aria-label="Close">×</button>
        </div>
        <ul class="settings-options-list">
          <li class="settings-option-row">
            <label class="settings-option">
              <input type="checkbox" id="po-quest-hints" ${getQuestHintsEnabled() ? 'checked' : ''}>
              <span class="settings-option-label">Quest hints</span>
            </label>
            <div class="settings-option-desc">Highlight quest-giver rooms and visit objectives on the map.</div>
          </li>
          ${this.renderAutoRetreatRow()}
        </ul>
      </div>
    `;
    document.body.appendChild(overlay);
    this.optionsOverlay = overlay;

    const close = () => this.closePlayerOptions();

    // Click outside the modal closes; click on the X closes.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.player-options-close')!.addEventListener('click', close);
    this.optionsUnsubscribe = this.gameClient.subscribe(() => this.refreshAutoRetreatNote(overlay));

    const questHintsToggle = overlay.querySelector('#po-quest-hints') as HTMLInputElement;
    questHintsToggle.addEventListener('change', () => {
      setQuestHintsEnabled(questHintsToggle.checked);
    });

    this.wireAutoRetreat(overlay);

    bringToFront(overlay);
    wireFocusOnInteract(overlay);
  }

  private closePlayerOptions(): void {
    this.optionsUnsubscribe?.();
    this.optionsUnsubscribe = undefined;
    if (!this.optionsOverlay) return;
    release(this.optionsOverlay);
    this.optionsOverlay.remove();
    this.optionsOverlay = null;
  }

  /** The owner's policy and this player's role can change while the window is open. */
  private refreshAutoRetreatNote(overlay: HTMLElement): void {
    const row = overlay.querySelector('.settings-option-row-retreat');
    if (!row) return;
    const current = row.querySelector('.settings-option-note');
    const next = this.autoRetreatNote();
    if ((current?.outerHTML ?? '') === next) return;
    current?.remove();
    if (next) row.insertAdjacentHTML('beforeend', next);
  }

  private renderAutoRetreatRow(): string {
    const current = this.gameClient.lastState?.character?.combatPrefs?.autoRetreatBelowPct
      ?? DEFAULT_COMBAT_PREFS.autoRetreatBelowPct;
    const buttons = AUTO_RETREAT_OPTIONS.map(pct => {
      const on = pct === current;
      return `<button type="button" class="settings-seg-btn${on ? ' active' : ''}" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-retreat="${pct}">`
        + `${pct === 0 ? 'Off' : formatPct(pct)}</button>`;
    }).join('');
    return `
      <li class="settings-option-row settings-option-row-retreat">
        <div class="settings-option-label" id="po-retreat-label">Auto-retreat</div>
        <div class="settings-segmented" role="radiogroup" aria-labelledby="po-retreat-label">${buttons}</div>
        <div class="settings-option-desc">Leave overworld fights when your party's chance to win is below this. Dungeons are not affected.</div>
        ${this.autoRetreatNote()}
      </li>
    `;
  }

  /** Non-owners follow their party owner's setting. */
  private autoRetreatNote(): string {
    const state = this.gameClient.lastState;
    const party = state?.social?.party;
    const me = party?.members.find(m => m.username === state?.username);
    if (!party || !me || me.role === 'owner') return '';
    const policy = party.autoRetreat ? ` (${autoRetreatLine(party.autoRetreat.belowPct).replace('Auto-retreat: ', '')})` : '';
    return `<div class="settings-option-note">Your party owner's setting is used${policy}.</div>`;
  }

  private wireAutoRetreat(overlay: HTMLElement): void {
    const group = overlay.querySelector<HTMLElement>('.settings-segmented');
    if (!group) return;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('.settings-seg-btn[data-retreat]')];
    const select = (btn: HTMLButtonElement): void => {
      if (btn.getAttribute('aria-checked') === 'true') return;
      for (const b of buttons) {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
      this.gameClient.sendSetCombatPrefs(Number(btn.dataset.retreat) as AutoRetreatPct);
    };
    group.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.settings-seg-btn[data-retreat]');
      if (btn) select(btn);
    });
    group.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      e.preventDefault();
      const current = buttons.findIndex(b => b.getAttribute('aria-checked') === 'true');
      const next = buttons[(current + step + buttons.length) % buttons.length];
      select(next);
      next.focus();
    });
  }

  private openNotificationPreferences(): void {
    if (this.notifPrefsOverlay) return;

    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal notif-prefs-modal" role="dialog" aria-label="Notification Settings">
        <div class="player-options-header">
          <span class="player-options-title">Notifications</span>
          <button class="player-options-close" aria-label="Close">×</button>
        </div>
        <div class="notif-prefs-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.notifPrefsOverlay = overlay;

    const close = () => {
      release(overlay);
      overlay.remove();
      this.notifPrefsOverlay = null;
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.player-options-close')!.addEventListener('click', close);

    renderNotificationPreferences(overlay.querySelector('.notif-prefs-body') as HTMLElement, this.gameClient);

    bringToFront(overlay);
    wireFocusOnInteract(overlay);
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
    // Close any open notification-preferences popup so it doesn't survive a tab switch.
    if (this.notifPrefsOverlay) {
      release(this.notifPrefsOverlay);
      this.notifPrefsOverlay.remove();
      this.notifPrefsOverlay = null;
    }
    this.closePlayerOptions();
  }
}
