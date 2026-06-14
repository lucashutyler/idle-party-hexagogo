import type { GameClient } from '../network/GameClient';
import type { DungeonDefinition } from '@idle-party-rpg/shared';

/**
 * Confirmation popup shown when a player taps "Enter {dungeon}" in the room
 * view. Surfaces the dungeon's flavor, floor count, and entry requirements,
 * then lets the party owner/leader commit. Entry is server-authoritative —
 * if requirements aren't met, the server replies with an error toast.
 */
export class DungeonEntryPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'dungeon-entry-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    document.body.appendChild(this.overlay);
  }

  show(dungeon: DungeonDefinition, col: number, row: number): void {
    const floors = dungeon.floors.length;
    const description = dungeon.description?.trim();
    const descHtml = description
      ? `<div class="dungeon-entry-desc">"${this.escape(description)}"</div>`
      : '';

    const reqHtml = this.renderRequirements(dungeon);

    this.overlay.innerHTML = `
      <div class="dungeon-entry-modal">
        <div class="dungeon-entry-header">
          <span class="dungeon-entry-icon">🗝️</span>
          <div class="dungeon-entry-title">${this.escape(dungeon.name)}</div>
        </div>
        ${descHtml}
        <div class="dungeon-entry-meta">${floors} floor${floors === 1 ? '' : 's'} · clear the final floor to complete the run</div>
        ${reqHtml}
        <div class="dungeon-entry-warning">If your party is defeated, you'll be sent back to this entrance.</div>
        <div class="dungeon-entry-actions">
          <button class="dungeon-entry-btn dungeon-entry-enter" type="button">Enter</button>
          <button class="dungeon-entry-btn dungeon-entry-cancel" type="button">Cancel</button>
        </div>
      </div>
    `;

    this.overlay.querySelector('.dungeon-entry-cancel')?.addEventListener('click', () => this.hide());
    this.overlay.querySelector('.dungeon-entry-enter')?.addEventListener('click', () => {
      this.gameClient.sendEnterDungeon(col, row, dungeon.id);
      this.hide();
    });

    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
  }

  /** Render a bullet list of entry requirements, or nothing if unrestricted. */
  private renderRequirements(dungeon: DungeonDefinition): string {
    const req = dungeon.entryRequirements;
    if (!req) return '';
    const lines: string[] = [];

    if (req.minLevel !== undefined && req.maxLevel !== undefined) {
      lines.push(`Level ${req.minLevel}–${req.maxLevel}`);
    } else if (req.minLevel !== undefined) {
      lines.push(`Level ${req.minLevel}+`);
    } else if (req.maxLevel !== undefined) {
      lines.push(`Level ${req.maxLevel} or below`);
    }

    if (req.minPartySize !== undefined && req.maxPartySize !== undefined) {
      lines.push(`Party of ${req.minPartySize}–${req.maxPartySize}`);
    } else if (req.minPartySize !== undefined) {
      lines.push(`At least ${req.minPartySize} party member${req.minPartySize === 1 ? '' : 's'}`);
    } else if (req.maxPartySize !== undefined) {
      lines.push(`At most ${req.maxPartySize} party member${req.maxPartySize === 1 ? '' : 's'}`);
    }

    if (req.requiredClasses && req.requiredClasses.length > 0) {
      lines.push(`Classes: ${req.requiredClasses.join(', ')}`);
    }

    if (req.requiredItemId) {
      const itemName = this.gameClient.lastState?.itemDefinitions?.[req.requiredItemId]?.name ?? 'a key item';
      lines.push(req.consumeRequiredItem ? `Consumes ${this.escape(itemName)} (per member)` : `Requires ${this.escape(itemName)} (per member)`);
    }

    if (lines.length === 0) return '';
    return `
      <div class="dungeon-entry-reqs">
        <div class="dungeon-entry-reqs-title">Requirements</div>
        ${lines.map(l => `<div class="dungeon-entry-req">• ${l}</div>`).join('')}
      </div>
    `;
  }

  private escape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
