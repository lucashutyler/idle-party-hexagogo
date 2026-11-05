import type { Screen } from './ScreenManager';
import { logout } from '../network/AuthClient';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';
import type { GameClient } from '../network/GameClient';
import { renderNotificationPreferences } from '../ui/NotificationPreferences';
import { escapeHtml } from '../ui/ItemIcon';
import { deferWhilePressed, setHtml } from '../ui/render';
import type { AutoRetreatPct } from '@idle-party-rpg/shared';
import { AUTO_RETREAT_OPTIONS, DEFAULT_COMBAT_PREFS, GAME_VERSION } from '@idle-party-rpg/shared';
import { autoRetreatLine, formatPct } from '../combat/ForecastFormat';
import { confirmDialog } from '../ui/ConfirmDialog';

function settingsRow(id: string, glyph: string, title: string, sub: string, extraClass = ''): string {
  return `
    <button type="button" class="ui-row settings-row${extraClass}" id="${id}">
      <span class="ui-row-media settings-row-glyph" aria-hidden="true">${glyph}</span>
      <span class="ui-row-main">
        <span class="ui-row-title">${title}</span>
        <span class="ui-row-sub">${sub}</span>
      </span>
      <span class="settings-row-chevron" aria-hidden="true">›</span>
    </button>
  `;
}

export class SettingsScreen implements Screen {
  private container: HTMLElement;
  private optionsOverlay: HTMLElement | null = null;
  private optionsUnsubscribe?: () => void;
  private notifPrefsOverlay: HTMLElement | null = null;
  private patchNotesOverlay: HTMLElement | null = null;
  private patchNotesLoading = false;
  private rowsUnsubscribe?: () => void;

  constructor(containerId: string, private gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;

    this.container.innerHTML = `
      <div class="settings-content">
        <div class="settings-page">
          <h2 class="settings-title">Settings</h2>
          <div class="ui-section-label">Game</div>
          <div class="settings-group">
            ${settingsRow('btn-player-options', '⚔️', 'Player Options', '')}
            ${settingsRow('btn-notifications', '🔔', 'Notifications', 'Choose what reaches you, and how')}
          </div>
          <div class="ui-section-label">About</div>
          <div class="settings-group">
            ${settingsRow('btn-patch-notes', '📜', 'Patch Notes', `Version ${escapeHtml(GAME_VERSION)}`)}
          </div>
          <div class="ui-section-label">Account</div>
          <div class="settings-group">
            ${settingsRow('btn-sign-out', '🚪', 'Sign Out', '', ' settings-row-danger')}
          </div>
        </div>
      </div>
    `;

    this.container.querySelector('#btn-player-options')!.addEventListener('click', () => this.openPlayerOptions());
    this.container.querySelector('#btn-notifications')!.addEventListener('click', () => this.openNotificationPreferences());
    this.container.querySelector('#btn-patch-notes')!.addEventListener('click', () => void this.openPatchNotes());

    const btnSignOut = this.container.querySelector('#btn-sign-out') as HTMLButtonElement;
    btnSignOut.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Sign out of your account?', confirmLabel: 'Sign Out', danger: true })) return;
      btnSignOut.disabled = true;
      btnSignOut.querySelector('.ui-row-title')!.textContent = 'Signing out…';
      try {
        await logout();
      } finally {
        window.location.reload();
      }
    });
  }

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
          ${this.renderAutoRetreatRow()}
        </ul>
      </div>
    `;
    document.body.appendChild(overlay);
    this.optionsOverlay = overlay;

    const close = () => this.closePlayerOptions();

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.player-options-close')!.addEventListener('click', close);
    this.optionsUnsubscribe = this.gameClient.subscribe(() => this.refreshAutoRetreatNote(overlay));

    this.wireAutoRetreat(overlay);

    bringToFront(overlay, close);
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
    if (this.notifPrefsOverlay) {
      bringToFront(this.notifPrefsOverlay);
      return;
    }

    const overlay = this.mountSheet('Notifications', 'notif-prefs-modal', '<div class="notif-prefs-body"></div>', () => this.closeNotificationPreferences());
    this.notifPrefsOverlay = overlay;
    renderNotificationPreferences(overlay.querySelector('.notif-prefs-body') as HTMLElement, this.gameClient);
  }

  private closeNotificationPreferences(): void {
    if (!this.notifPrefsOverlay) return;
    release(this.notifPrefsOverlay);
    this.notifPrefsOverlay.remove();
    this.notifPrefsOverlay = null;
  }

  private async openPatchNotes(): Promise<void> {
    if (this.patchNotesOverlay) {
      bringToFront(this.patchNotesOverlay);
      return;
    }
    if (this.patchNotesLoading) return;

    this.patchNotesLoading = true;
    const body = await this.patchNotesHtml();
    if (!this.patchNotesLoading) return;
    this.patchNotesLoading = false;
    this.patchNotesOverlay = this.mountSheet('Patch Notes', 'patch-notes-modal', body, () => this.closePatchNotes());
  }

  private async patchNotesHtml(): Promise<string> {
    try {
      const { PATCH_NOTES } = await import('./PatchNotes');
      const entries = PATCH_NOTES.map(p => `
        <div class="patch-note-entry">
          <div class="patch-note-version">${escapeHtml(p.version)}</div>
          <ul class="patch-note-items">
            ${p.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}
          </ul>
        </div>
      `).join('');
      return `<div class="patch-notes-list">${entries}</div>`;
    } catch {
      return '<div class="ui-empty">The patch notes could not be loaded. Check your connection and try again.</div>';
    }
  }

  private closePatchNotes(): void {
    if (!this.patchNotesOverlay) return;
    release(this.patchNotesOverlay);
    this.patchNotesOverlay.remove();
    this.patchNotesOverlay = null;
  }

  private mountSheet(title: string, modalClass: string, bodyHtml: string, close: () => void): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal ${modalClass}" role="dialog" aria-label="${escapeHtml(title)}">
        <div class="player-options-header">
          <span class="player-options-title">${escapeHtml(title)}</span>
          <button type="button" class="player-options-close" aria-label="Close">×</button>
        </div>
        ${bodyHtml}
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.player-options-close')!.addEventListener('click', close);
    bringToFront(overlay, close);
    wireFocusOnInteract(overlay);
    return overlay;
  }

  private paintRows(): void {
    const state = this.gameClient.lastState;
    const pct = state?.character?.combatPrefs?.autoRetreatBelowPct ?? DEFAULT_COMBAT_PREFS.autoRetreatBelowPct;
    const options = this.container.querySelector('#btn-player-options .ui-row-sub');
    if (options) setHtml(options, escapeHtml(autoRetreatLine(pct)));
    const account = this.container.querySelector('#btn-sign-out .ui-row-sub');
    if (account) setHtml(account, state?.username ? `Signed in as ${escapeHtml(state.username)}` : 'Leave this device');
  }

  onActivate(): void {
    this.paintRows();
    this.rowsUnsubscribe?.();
    this.rowsUnsubscribe = this.gameClient.subscribe(() => {
      deferWhilePressed(this.container, () => this.paintRows());
    });
  }

  onDeactivate(): void {
    this.rowsUnsubscribe?.();
    this.rowsUnsubscribe = undefined;
    this.closeNotificationPreferences();
    this.patchNotesLoading = false;
    this.closePatchNotes();
    this.closePlayerOptions();
  }
}
