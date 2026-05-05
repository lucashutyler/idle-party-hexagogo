import type { GameClient } from '../network/GameClient';
import type {
  ServerStateMessage,
  ServerEquipBlockedMessage,
  MailboxEntry,
  TradeState,
  ClassName,
  EquipSlot,
  ItemDefinition,
  SetDefinition,
  SkillDefinition,
} from '@idle-party-rpg/shared';
import {
  computeEquipmentBonuses,
  classIconHtml,
  SKILL_SLOTS,
  CLASS_DEFINITIONS,
  getSkillById,
  getOwnedItemIds,
  getEquippedItemIds,
} from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import { RARITY_ORDER, SLOT_LABELS, renderItemIcon, renderEmptySlotIcon, RARITY_COLORS } from '../ui/ItemIcon';
import { renderItemPopupContent } from '../ui/ItemPopup';
import { renderAssetImg } from '../ui/assets';
import { bringToFront, release } from '../ui/ModalStack';

/** Left column slots (top to bottom). Mainhand sits at the bottom of the
 *  left column with a small visual gap (no separate row anymore). */
const LEFT_SLOTS: EquipSlot[] = ['head', 'shoulders', 'chest', 'gloves', 'foot', 'mainhand'];

/** Right column slots (top to bottom). Offhand mirrors mainhand on the right. */
const RIGHT_SLOTS: EquipSlot[] = ['back', 'necklace', 'bracers', 'ring', 'relic', 'offhand'];

type SortMode = 'rarity' | 'type' | 'newest';

/** Display order within the inventory when sorting by type (and matching header buckets). */
const SLOT_ORDER: Record<string, number> = {
  head: 0, shoulders: 1, chest: 2, bracers: 3, gloves: 4,
  mainhand: 5, offhand: 6, twohanded: 7, foot: 8,
  ring: 9, necklace: 10, back: 11, relic: 12,
};

/** Rarity buckets in display order (best first). */
const RARITY_BUCKET_ORDER = ['heirloom', 'legendary', 'epic', 'rare', 'uncommon', 'common', 'janky'];

/** Tooltip descriptions for the condensed stat-card abbreviations. */
const STAT_TOOLTIPS: Record<string, { full: string; desc: string }> = {
  ATK: { full: 'Attack', desc: 'Damage you deal per attack (base + equipment).' },
  DR: { full: 'Damage Reduction', desc: 'Reduces incoming physical damage (per hit).' },
  MR: { full: 'Magic Resistance', desc: 'Reduces incoming magical damage. Holy damage is unaffected.' },
  HP: { full: 'Hit Points', desc: 'Maximum health pool.' },
};

function injectCharItemsStyles(): void {
  if (document.getElementById('charitems-screen-styles')) return;
  const style = document.createElement('style');
  style.id = 'charitems-screen-styles';
  style.textContent = `
    .charitems-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
      overflow-y: auto;
    }

    .charitems-hero {
      background: var(--bg-panel);
      border: 2px solid var(--border-pixel);
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .charitems-hero-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      align-items: start;
    }

    /* Class portrait now lives in the equipment-panel center slot
       (grid area .items-equip-figure, formerly the silhouette). */
    .charitems-portrait {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
      overflow: hidden;
    }
    .charitems-portrait img {
      max-width: 100%;
      max-height: 100%;
      width: auto;
      height: 100%;
      object-fit: contain;
      image-rendering: pixelated;
    }

    .charitems-skills-strip {
      display: flex;
      gap: 6px;
      justify-content: center;
      flex-wrap: wrap;
      padding-top: 4px;
      border-top: 1px dashed var(--border-pixel);
    }
    .charitems-skill-slot {
      flex: 1 1 80px;
      min-width: 76px;
      max-width: 120px;
      padding: 6px 4px;
      background: var(--bg-input);
      border: 2px solid var(--border-pixel);
      cursor: pointer;
      text-align: center;
      display: flex;
      flex-direction: column;
      gap: 2px;
      -webkit-tap-highlight-color: transparent;
    }
    .charitems-skill-slot.locked {
      cursor: not-allowed;
      opacity: 0.45;
    }
    .charitems-skill-slot.empty {
      background: rgba(0,0,0,0.2);
    }
    .charitems-skill-slot.filled.passive { border-color: #5c8a5c; }
    .charitems-skill-slot.filled.active { border-color: #c89b3c; }
    .charitems-skill-slot-name {
      font-size: 8px;
      color: var(--text-primary);
      line-height: 1.1;
      word-break: break-word;
    }
    .charitems-skill-slot-meta {
      font-size: 6px;
      color: var(--text-dim);
      text-transform: uppercase;
    }

    .charitems-skill-popup-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .charitems-skill-popup {
      background: #1a1a2e;
      border: 2px solid #444;
      border-radius: 6px;
      padding: 14px;
      width: 90%;
      max-width: 360px;
      max-height: 80vh;
      overflow-y: auto;
      color: #e8e8e8;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .charitems-skill-popup-title {
      font-size: 11px;
      color: var(--accent-gold);
      margin-bottom: 4px;
    }
    .charitems-skill-popup-empty {
      font-size: 9px;
      color: var(--text-dim);
      font-style: italic;
      text-align: center;
      padding: 8px 0;
    }
    .charitems-skill-row {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 8px;
      border: 1px solid #333;
      background: #0f0f1c;
      cursor: pointer;
      border-radius: 4px;
    }
    .charitems-skill-row:hover {
      border-color: var(--accent-gold);
    }
    .charitems-skill-row.passive { border-left: 4px solid #5c8a5c; }
    .charitems-skill-row.active { border-left: 4px solid #c89b3c; }
    .charitems-skill-row-name {
      font-size: 10px;
      color: #f5f5f5;
    }
    .charitems-skill-row-meta {
      font-size: 7px;
      color: #888;
      text-transform: uppercase;
    }
    .charitems-skill-row-desc {
      font-size: 8px;
      color: #bbb;
      line-height: 1.3;
    }
    .charitems-skill-popup-actions {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      margin-top: 6px;
    }
    .charitems-skill-popup-btn {
      padding: 6px 10px;
      background: #2a2a40;
      border: 1px solid #555;
      color: #e8e8e8;
      cursor: pointer;
      font-family: inherit;
      font-size: 9px;
      border-radius: 4px;
    }
    .charitems-skill-popup-btn:hover { background: #3a3a55; }
    .charitems-skill-popup-btn.danger { border-color: #a33; color: #f88; }

    .charitems-stat-card {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      background: var(--bg-panel);
      border: 2px solid var(--border-pixel);
      padding: 10px;
    }
    .charitems-stat {
      flex: 1 1 64px;
      min-width: 64px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    .charitems-stat-label {
      font-size: 8px;
      color: var(--text-secondary);
      cursor: help;
      text-decoration: underline dotted;
      letter-spacing: 1px;
    }
    .charitems-stat-value {
      font-size: 10px;
      color: var(--text-primary);
    }
    .charitems-stat-tooltip {
      position: fixed;
      background: #222;
      color: #e8e8e8;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 9px;
      max-width: 220px;
      line-height: 1.4;
      z-index: 2000;
      border: 1px solid #555;
      pointer-events: none;
    }
    .charitems-stat-tooltip-title {
      color: var(--accent-gold);
      font-size: 10px;
      margin-bottom: 4px;
    }

    .charitems-meta-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 9px;
      color: var(--text-secondary);
    }
    .charitems-meta-row strong { color: var(--text-primary); }

    .charitems-xp-bar-wrap {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .charitems-xp-bar {
      height: 8px;
      background: var(--bg-input);
      border: 1px solid var(--border-pixel);
      overflow: hidden;
    }
    .charitems-xp-fill {
      height: 100%;
      background: var(--accent-gold);
    }
    .charitems-xp-rate-row {
      display: flex;
      gap: 6px;
      align-items: center;
      font-size: 7px;
      color: var(--text-dim);
    }
    .charitems-xp-rate-reset {
      cursor: pointer;
      color: var(--accent-gold);
    }

    .charitems-passive-info {
      background: var(--bg-panel);
      border: 1px dashed var(--border-pixel);
      padding: 8px;
      font-size: 8px;
      color: var(--text-secondary);
      line-height: 1.4;
    }

    .charitems-inv-group-header {
      grid-column: 1 / -1;
      font-size: 8px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-secondary);
      margin-top: 4px;
      padding: 4px 0 2px;
      border-bottom: 1px dashed var(--border-pixel);
    }

    @media (min-width: 1000px) {
      .charitems-hero-grid {
        gap: 16px;
      }
    }
  `;
  document.head.appendChild(style);
}

function injectItemsStyles(): void {
  if (document.getElementById('items-screen-styles')) return;
  const style = document.createElement('style');
  style.id = 'items-screen-styles';
  style.textContent = `
    .item-square {
      position: relative;
      aspect-ratio: 1;
      border-radius: 4px;
      cursor: pointer;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid rgba(180,180,180,0.25);
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.3);
      box-sizing: border-box;
      min-width: 0;
    }
    .item-square-img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      position: absolute;
      top: 0;
      left: 0;
    }
    /* isolation: isolate on the parent square keeps the inner z-indexed
       overlays (initials, qty, dogear, set indicator) inside their own
       stacking context so they cannot bleed up over the chat popout. */
    .item-square { isolation: isolate; }
    .item-square-initials {
      font-size: 14px;
      font-weight: bold;
      color: rgba(255,255,255,0.85);
      text-shadow: 1px 1px 2px rgba(0,0,0,0.8);
      z-index: 1;
      pointer-events: none;
      text-align: center;
      line-height: 1;
    }
    .item-dogear {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 18px;
      height: 18px;
      background: rgba(240,240,240,0.85);
      border-top-left-radius: 4px;
      border-top: 1px solid rgba(0,0,0,0.2);
      border-left: 1px solid rgba(0,0,0,0.2);
      pointer-events: none;
      z-index: 3;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .item-dogear-icon {
      font-size: 11px;
      line-height: 1;
      pointer-events: none;
    }
    .item-square-empty {
      cursor: default;
    }
    .item-square-empty .item-dogear {
      width: 16px;
      height: 16px;
    }
    .item-square-empty .item-dogear-icon {
      font-size: 10px;
    }
    .item-square-qty {
      position: absolute;
      top: 1px;
      right: 2px;
      font-size: 8px;
      color: #fff;
      background: rgba(0,0,0,0.6);
      padding: 0 2px;
      border-radius: 2px;
      pointer-events: none;
      z-index: 2;
      line-height: 1.2;
    }
    .item-square-set {
      position: absolute;
      top: 1px;
      left: 2px;
      font-size: 8px;
      color: #e9bc18;
      pointer-events: none;
      z-index: 2;
      line-height: 1;
    }

    @keyframes item-border-epic {
      0%, 100% { border-color: rgba(180,180,180,0.4); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.3), 0 0 4px rgba(238,102,227,0.3); }
      50% { border-color: rgba(200,200,200,0.5); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.3), 0 0 8px rgba(238,102,227,0.6), inset 0 0 4px rgba(238,102,227,0.15); }
    }
    @keyframes item-border-legendary {
      0%, 100% { border-color: rgba(180,180,180,0.4); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.3), 0 0 4px rgba(146,51,223,0.3); }
      33% { border-color: rgba(200,200,200,0.5); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.3), 0 0 8px rgba(199,125,255,0.6), inset 0 0 4px rgba(199,125,255,0.15); }
      66% { border-color: rgba(210,210,210,0.5); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.3), 0 0 12px rgba(224,170,255,0.7), inset 0 0 6px rgba(224,170,255,0.2); }
    }
    @keyframes item-border-heirloom {
      0%, 100% { border-color: rgba(180,180,180,0.4); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.3), 0 0 4px rgba(233,188,24,0.3); }
      50% { border-color: rgba(200,200,200,0.5); box-shadow: inset 0 0 0 1px rgba(0,0,0,0.3), 0 0 10px rgba(255,241,118,0.6), inset 0 0 5px rgba(255,241,118,0.15); }
    }
    .item-rarity-epic { animation: item-border-epic 2s ease-in-out infinite; }
    .item-rarity-legendary { animation: item-border-legendary 3s ease-in-out infinite; }
    .item-rarity-heirloom { animation: item-border-heirloom 2.5s ease-in-out infinite; }

    .item-popup-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    .item-popup {
      background: #1a1a2e;
      border: 2px solid #444;
      border-radius: 8px;
      padding: 16px;
      max-width: 320px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      color: #e8e8e8;
    }
    .item-popup-artwork {
      width: 80px;
      height: 80px;
      margin: 0 auto 12px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }
    .item-popup-artwork img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .item-popup-artwork .item-popup-initials {
      font-size: 28px;
      font-weight: bold;
      color: rgba(255,255,255,0.85);
      text-shadow: 1px 1px 3px rgba(0,0,0,0.8);
    }
    .item-popup-name { text-align: center; font-size: 16px; font-weight: bold; margin-bottom: 8px; }
    .item-popup-stats { font-size: 12px; margin-bottom: 8px; line-height: 1.6; }
    .item-popup-stats div { display: flex; justify-content: space-between; }
    .item-popup-stats .stat-label { color: #999; }
    .item-popup-set-section { border-top: 1px solid #333; padding-top: 8px; margin-top: 8px; font-size: 12px; }
    .item-popup-set-name { font-weight: bold; color: #e9bc18; margin-bottom: 4px; }
    .item-popup-set-pieces { margin-bottom: 4px; }
    .item-popup-set-piece { color: #888; margin-left: 8px; }
    .item-popup-set-piece.owned { color: #ccc; }
    .item-popup-set-piece.equipped { color: #66bb6a; }
    .item-popup-set-bonus { color: #aaa; font-style: italic; }
    .item-popup-set-breakpoints { margin-top: 4px; }
    .item-popup-set-bp { color: #666; font-size: 11px; line-height: 1.4; }
    .item-popup-set-bp.unlocked { color: #aaa; }
    .item-popup-set-bp.active { color: #66bb6a; font-weight: bold; }
    .item-popup-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: center; }
    .item-popup-actions button {
      padding: 6px 16px; border-radius: 4px; border: 1px solid #555;
      background: #2a2a40; color: #e8e8e8; cursor: pointer; font-family: inherit; font-size: 12px;
    }
    .item-popup-actions button:hover { background: #3a3a55; }
    .item-popup-actions button.danger { border-color: #a33; color: #f88; }
    .item-popup-actions button.danger:hover { background: #4a2020; }
    .item-popup-actions button[disabled],
    .item-popup-actions button[disabled]:hover {
      background: #1a1a28;
      color: #555;
      border-color: #2a2a3a;
      cursor: not-allowed;
      opacity: 0.7;
    }

    .items-search-sort {
      display: flex; gap: 6px; margin-bottom: 8px; align-items: center;
    }
    .items-search-sort input {
      flex: 1; min-width: 0; padding: 4px 8px; border-radius: 4px;
      border: 1px solid #555; background: #1a1a2e; color: #e8e8e8;
      font-family: inherit; font-size: 11px;
    }
    .items-search-sort select {
      padding: 4px 6px; border-radius: 4px; border: 1px solid #555;
      background: #1a1a2e; color: #e8e8e8; font-family: inherit; font-size: 11px;
    }

    .items-inv-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
      gap: 4px;
    }

    .items-equip-slot-square { width: 44px; height: 44px; }

    @media (min-width: 768px) {
      .items-inv-grid {
        grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
        gap: 6px;
      }
      .items-equip-slot-square { width: 52px; height: 52px; }
      .item-square-initials { font-size: 16px; }
      .item-dogear { width: 22px; height: 22px; }
      .item-dogear-icon { font-size: 13px; }
      .item-square-qty { font-size: 9px; }
      .item-popup { max-width: 380px; }
    }

    .items-section-count { color: #888; font-size: 10px; margin-left: 4px; }
    .items-mailbox, .items-trades { margin-top: 8px; }
    .mailbox-list, .trade-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .mailbox-row, .trade-row {
      display: flex; gap: 6px; align-items: center; padding: 6px 8px;
      border: 1px solid #444; border-radius: 4px; background: #1a1a2e; font-size: 11px;
    }
    .trade-row-attention { border-color: #d4af37; box-shadow: 0 0 4px rgba(212,175,55,0.3); }
    .mailbox-info, .trade-row-main { flex: 1; min-width: 0; }
    .mailbox-from { color: #aaa; font-size: 10px; }
    .mailbox-note { color: #d77; font-style: italic; margin-left: 4px; }
    .mailbox-item { margin-top: 2px; }
    .mailbox-item-qty { color: #888; margin-left: 4px; }
    .mailbox-warn { color: #d77; font-size: 10px; margin-top: 2px; }
    .mailbox-actions, .trade-row-actions {
      display: flex; flex-direction: column; gap: 4px; flex-shrink: 0;
    }
    .mailbox-actions button, .trade-row-actions button {
      padding: 3px 8px; font-size: 10px; min-width: 60px;
    }
    .trade-row-partner { font-weight: bold; }
    .trade-row-status { color: #aaa; font-size: 10px; }
    .trade-row-attention .trade-row-status { color: #d4af37; }
    .trade-row-offers { display: flex; flex-direction: column; gap: 2px; margin-top: 4px; }
    .trade-row-side { font-size: 10px; }
    .trade-row-label { color: #666; margin-right: 4px; }
    .trade-row-empty { color: #555; font-style: italic; }
    .trade-row-item { display: inline-block; }
  `;
  document.head.appendChild(style);
}

export class CharItemsScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  // Hero section refs
  private portraitEl!: HTMLElement;
  private equipLeftCol!: HTMLElement;
  private equipRightCol!: HTMLElement;
  private skillStripEl!: HTMLElement;

  // Stat & meta refs
  private statCardEl!: HTMLElement;
  private metaRowEl!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpLabelEl!: HTMLElement;
  private xpRateEl!: HTMLElement;
  private xpRateFromEl!: HTMLElement;
  private classPassiveEl!: HTMLElement;

  // Inventory refs
  private inventoryGrid!: HTMLElement;
  private mailboxContainer!: HTMLElement;
  private tradesContainer!: HTMLElement;
  private modalOverlay!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private sortSelect!: HTMLSelectElement;

  private unsubscribe?: () => void;
  private unsubEquipBlocked?: () => void;

  /** Cached item definitions. */
  private itemDefs: Record<string, ItemDefinition> = {};
  private setDefs: Record<string, SetDefinition> = {};

  /** Cached character state. */
  private lastEquipment: Record<string, string | null> = {};
  private lastInventory: Record<string, number> = {};
  private lastClassName = '';
  private lastMailbox: MailboxEntry[] = [];
  private lastProposedTrades: TradeState[] = [];
  private lastUsername = '';

  /** Change-detection keys. */
  private lastEquipKey = '';
  private lastInvKey = '';
  private lastSkillKey = '';
  private lastMailboxKey = '';
  private lastTradesKey = '';
  private lastHeroKey = '';
  private lastStatKey = '';

  /** Search/sort filter state. */
  private searchFilter = '';
  /** Default to type; will be overridden by the per-user persisted choice
   *  after the first state lands (when we know the username). */
  private sortMode: SortMode = 'type';
  private sortPrefLoaded = false;

  private skillPopupOpen = false;
  private onOpenTrade?: (tradeId: string) => void;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;

    injectCharItemsStyles();
    injectItemsStyles();
    this.buildDOM();
  }

  setOnOpenTrade(cb: (tradeId: string) => void): void {
    this.onOpenTrade = cb;
  }

  onActivate(): void {
    this.isActive = true;

    this.unsubscribe = this.gameClient.subscribe((state) => {
      if (this.isActive) this.updateFromState(state);
    });

    this.unsubEquipBlocked = this.gameClient.onEquipBlocked((msg) => {
      if (this.isActive) this.showEquipBlockedModal(msg);
    });

    const state = this.gameClient.lastState;
    if (state) this.updateFromState(state);
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubEquipBlocked?.();
    this.unsubEquipBlocked = undefined;
    this.hideModal();
    this.closeSkillPopup();
    this.removeStatTooltip();
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="charitems-content">
        <div class="charitems-hero">
          <div class="charitems-hero-grid">
            <div class="items-equip-panel">
              <div class="items-equip-col items-equip-left"></div>
              <div class="items-equip-figure charitems-portrait"></div>
              <div class="items-equip-col items-equip-right"></div>
            </div>
          </div>
          <div class="charitems-skills-strip"></div>
        </div>

        <div class="charitems-stat-card"></div>

        <div class="charitems-meta-row"></div>
        <div class="charitems-xp-bar-wrap">
          <div class="character-xp-label">
            <span>XP</span>
            <span class="charitems-xp-numbers">0 / 100</span>
          </div>
          <div class="charitems-xp-bar">
            <div class="charitems-xp-fill" style="width: 0%"></div>
          </div>
          <div class="charitems-xp-rate-row">
            <span>XP Rate</span>
            <span class="charitems-xp-rate-value">0/hr</span>
            <span class="charitems-xp-rate-reset" title="Reset XP rate counter">&#x21bb;</span>
            <span class="charitems-xp-rate-from"></span>
          </div>
        </div>

        <div class="charitems-passive-info"></div>

        <div class="items-mailbox"></div>
        <div class="items-trades"></div>

        <div class="items-section-label">Inventory</div>
        <div class="items-search-sort">
          <input type="text" class="items-search-input" placeholder="Search items..." />
          <select class="items-sort-select">
            <option value="type">Type</option>
            <option value="rarity">Rarity</option>
            <option value="newest">Newest</option>
          </select>
        </div>
        <div class="items-inv-grid"></div>
      </div>
      <div class="items-modal-overlay" style="display:none"></div>
    `;

    this.portraitEl = this.container.querySelector('.charitems-portrait')!;
    const slotsContainer = this.container.querySelector('.items-equip-panel')!;
    this.equipLeftCol = slotsContainer.querySelector('.items-equip-left')!;
    this.equipRightCol = slotsContainer.querySelector('.items-equip-right')!;

    this.skillStripEl = this.container.querySelector('.charitems-skills-strip')!;
    this.statCardEl = this.container.querySelector('.charitems-stat-card')!;
    this.metaRowEl = this.container.querySelector('.charitems-meta-row')!;
    this.xpFill = this.container.querySelector('.charitems-xp-fill')!;
    this.xpLabelEl = this.container.querySelector('.charitems-xp-numbers')!;
    this.xpRateEl = this.container.querySelector('.charitems-xp-rate-value')!;
    this.xpRateFromEl = this.container.querySelector('.charitems-xp-rate-from')!;
    this.classPassiveEl = this.container.querySelector('.charitems-passive-info')!;

    this.inventoryGrid = this.container.querySelector('.items-inv-grid')!;
    this.mailboxContainer = this.container.querySelector('.items-mailbox')!;
    this.tradesContainer = this.container.querySelector('.items-trades')!;
    this.modalOverlay = this.container.querySelector('.items-modal-overlay')!;
    this.searchInput = this.container.querySelector('.items-search-input')!;
    this.sortSelect = this.container.querySelector('.items-sort-select')!;

    // XP rate reset
    this.container.querySelector('.charitems-xp-rate-reset')!.addEventListener('click', () => {
      if (!confirm('Reset XP rate counter?')) return;
      this.gameClient.resetXpRate();
    });

    // Mailbox / trades click delegation
    this.mailboxContainer.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-mb-action]') as HTMLButtonElement | null;
      if (!btn) return;
      const action = btn.getAttribute('data-mb-action');
      const id = btn.getAttribute('data-entry-id');
      if (!id) return;
      if (action === 'accept') this.gameClient.sendAcceptGift(id);
      if (action === 'deny') this.gameClient.sendDenyGift(id);
    });
    this.tradesContainer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const cancelBtn = target.closest('button[data-trade-cancel]') as HTMLButtonElement | null;
      if (cancelBtn) {
        const id = cancelBtn.getAttribute('data-trade-cancel');
        if (id) this.gameClient.sendCancelTrade(id);
        return;
      }
      const row = target.closest('[data-trade-id]') as HTMLElement | null;
      if (row) {
        const id = row.getAttribute('data-trade-id');
        if (id && this.onOpenTrade) this.onOpenTrade(id);
      }
    });

    this.modalOverlay.addEventListener('click', (e) => {
      if (e.target === this.modalOverlay) this.hideModal();
    });

    // Search/sort
    this.searchInput.addEventListener('input', () => {
      this.searchFilter = this.searchInput.value.toLowerCase();
      this.renderInventory();
    });
    this.sortSelect.addEventListener('change', () => {
      this.sortMode = this.sortSelect.value as SortMode;
      this.persistSortPref();
      this.renderInventory();
    });

    // Equipment slot delegation
    slotsContainer.addEventListener('click', (e) => {
      const slotEl = (e.target as HTMLElement).closest('.items-equip-slot-square[data-slot]') as HTMLElement | null;
      if (!slotEl) return;
      const slot = slotEl.getAttribute('data-slot') as EquipSlot;
      const itemId = slotEl.getAttribute('data-item-id');
      if (slot && itemId) {
        this.showItemPopup(itemId, 'equipped', slot);
      } else if (slot) {
        this.showSlotTooltip(slotEl, slot);
      }
    });

    // Inventory grid click delegation
    this.inventoryGrid.addEventListener('click', (e) => {
      const square = (e.target as HTMLElement).closest('.item-square[data-item]') as HTMLElement | null;
      if (!square) return;
      const itemId = square.getAttribute('data-item');
      if (itemId) {
        this.showItemPopup(itemId, 'inventory', undefined);
      }
    });

    // Skill slot click delegation
    this.skillStripEl.addEventListener('click', (e) => {
      const slot = (e.target as HTMLElement).closest('.charitems-skill-slot[data-slot-index]') as HTMLElement | null;
      if (!slot) return;
      if (slot.classList.contains('locked')) return;
      const idx = parseInt(slot.getAttribute('data-slot-index')!, 10);
      this.openSkillPopup(idx);
    });

    // Stat card tooltip — click to show, click anywhere else to dismiss
    this.statCardEl.addEventListener('click', (e) => {
      const labelEl = (e.target as HTMLElement).closest('.charitems-stat-label[data-tooltip]') as HTMLElement | null;
      if (!labelEl) return;
      e.stopPropagation();
      this.showStatTooltip(labelEl);
    });
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    this.itemDefs = state.itemDefinitions ?? {};
    this.setDefs = state.setDefinitions ?? {};
    this.lastEquipment = { ...char.equipment };
    this.lastInventory = { ...char.inventory };
    this.lastClassName = char.className;
    this.lastMailbox = state.social?.mailbox ?? [];
    this.lastProposedTrades = state.social?.proposedTrades ?? [];
    this.lastUsername = state.username ?? '';

    // Once we know who's logged in, restore their persisted sort choice.
    if (!this.sortPrefLoaded && this.lastUsername) {
      this.sortPrefLoaded = true;
      const saved = this.loadSortPref();
      if (saved && saved !== this.sortMode) {
        this.sortMode = saved;
        this.sortSelect.value = saved;
      }
    }

    // Hero portrait + class info — only re-render when className changes
    const heroKey = char.className;
    if (heroKey !== this.lastHeroKey) {
      this.lastHeroKey = heroKey;
      this.renderPortrait(char.className);
      this.renderClassPassive(char.className);
    }

    // Equipment / inventory key — re-render when items actually change
    const equipKey = JSON.stringify(char.equipment);
    if (equipKey !== this.lastEquipKey) {
      this.lastEquipKey = equipKey;
      this.renderEquipment(char);
    }

    const invKey = JSON.stringify(char.inventory);
    if (invKey !== this.lastInvKey) {
      this.lastInvKey = invKey;
      this.renderInventory();
    }

    // Skill loadout — re-render when skill state changes
    const skillKey = JSON.stringify(char.skillLoadout) + char.level;
    if (!this.skillPopupOpen && skillKey !== this.lastSkillKey) {
      this.lastSkillKey = skillKey;
      this.renderSkillStrip(state);
    }

    // Stat card — re-render when stats change
    const statKey = JSON.stringify({
      d: char.baseDamage,
      hp: char.maxHp,
      eq: char.equipment,
      lvl: char.level,
      gold: char.gold,
      xp: char.xp,
      xpNext: char.xpForNextLevel,
    });
    if (statKey !== this.lastStatKey) {
      this.lastStatKey = statKey;
      this.renderStatCard(state);
      this.renderMetaRow(char.className, char.level, char.gold);
      this.renderXpBar(char.xp, char.xpForNextLevel);
    }

    // XP rate — every tick (cheap)
    this.renderXpRate(char.xpRate);

    // Mailbox & trades — re-render on change
    const mailboxKey = JSON.stringify(this.lastMailbox.map(e => [e.id, e.itemId, e.quantity, e.fromUsername, e.returned ?? false]));
    if (mailboxKey !== this.lastMailboxKey) {
      this.lastMailboxKey = mailboxKey;
      this.renderMailbox();
    }

    const tradesKey = JSON.stringify(this.lastProposedTrades.map(t => [t.id, t.status, t.lastUpdatedBy, t.initiator.items.length, t.target?.items.length ?? 0]));
    if (tradesKey !== this.lastTradesKey) {
      this.lastTradesKey = tradesKey;
      this.renderProposedTrades();
    }
  }

  // ── Hero / portrait ──────────────────────────────────────────

  private renderPortrait(className: string): void {
    // TODO: drop-in `class-artwork/Knight.png` etc. when art exists; placeholder shows class name + icon for now.
    this.portraitEl.innerHTML = renderAssetImg('class', className, {
      label: className,
      width: 360,
      height: 440,
      alt: `${className} portrait`,
    });
  }

  private renderClassPassive(className: string): void {
    const def = CLASS_DEFINITIONS[className as ClassName];
    if (!def) {
      this.classPassiveEl.textContent = '';
      return;
    }
    this.classPassiveEl.innerHTML = `
      <strong>${this.escapeHtml(def.displayName)}</strong> &middot; <em>${this.escapeHtml(def.damageType)}</em><br>
      ${this.escapeHtml(def.description)}
    `;
  }

  // ── Equipment slots ─────────────────────────────────────────

  private renderEquipment(char: { equipment: Record<string, string | null>; className: string }): void {
    const renderSlotSquare = (slot: EquipSlot) => {
      const itemId = char.equipment[slot];
      const def = itemId ? this.itemDefs[itemId] : null;
      const dataAttrs: Record<string, string> = { slot, 'item-id': itemId ?? '' };
      if (def && itemId) {
        return renderItemIcon(itemId, def, {
          showSlotIcon: true,
          slotOverride: slot,
          showSetIndicator: true,
          setDefs: this.setDefs,
          extraClass: 'items-equip-slot-square',
          dataAttrs,
        });
      }
      return renderEmptySlotIcon(slot, { extraClass: 'items-equip-slot-square', dataAttrs });
    };

    // Mainhand/offhand are now the last items in LEFT_SLOTS / RIGHT_SLOTS;
    // the standalone bottom row is gone.
    this.equipLeftCol.innerHTML = LEFT_SLOTS.map(renderSlotSquare).join('');
    this.equipRightCol.innerHTML = RIGHT_SLOTS.map(renderSlotSquare).join('');
  }

  // ── Skill loadout strip ─────────────────────────────────────

  private renderSkillStrip(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    const slots = SKILL_SLOTS;
    let html = '';
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const isUnlocked = char.level >= slot.unlocksAtLevel;
      const equippedId = char.skillLoadout.equippedSkills[i] ?? null;
      const skill = equippedId ? getSkillById(equippedId) : null;

      if (!isUnlocked) {
        html += `<div class="charitems-skill-slot locked">
          <span class="charitems-skill-slot-name">Lv ${slot.unlocksAtLevel}</span>
          <span class="charitems-skill-slot-meta">${slot.type}</span>
        </div>`;
      } else if (skill) {
        html += `<div class="charitems-skill-slot filled ${skill.type}" data-slot-index="${i}">
          <span class="charitems-skill-slot-name">${this.escapeHtml(skill.name)}</span>
          <span class="charitems-skill-slot-meta">${skill.type}${skill.cooldown ? ` &middot; CD${skill.cooldown}` : ''}</span>
        </div>`;
      } else {
        html += `<div class="charitems-skill-slot empty" data-slot-index="${i}">
          <span class="charitems-skill-slot-name">+ ${slot.type}</span>
          <span class="charitems-skill-slot-meta">slot ${i + 1}</span>
        </div>`;
      }
    }
    this.skillStripEl.innerHTML = html;
  }

  private openSkillPopup(slotIndex: number): void {
    this.closeSkillPopup();

    const state = this.gameClient.lastState;
    if (!state?.character) return;
    const char = state.character;
    const slot = SKILL_SLOTS[slotIndex];
    if (!slot) return;

    const equippedId = char.skillLoadout.equippedSkills[slotIndex] ?? null;
    const equippedNow = equippedId ? getSkillById(equippedId) : null;

    const equippedIds = new Set(char.skillLoadout.equippedSkills.filter(Boolean) as string[]);
    const candidates: SkillDefinition[] = [];
    for (const id of char.skillLoadout.unlockedSkills) {
      const skill = getSkillById(id);
      if (!skill) continue;
      if (skill.type !== slot.type) continue;
      // Allow showing the currently-equipped skill so it's visible (but disabled — clicking does nothing)
      if (equippedIds.has(id) && id !== equippedId) continue;
      candidates.push(skill);
    }

    // Sort by treeOrder (level acquired)
    candidates.sort((a, b) => a.treeOrder - b.treeOrder);

    const overlay = document.createElement('div');
    overlay.className = 'charitems-skill-popup-overlay';

    let rowsHtml = '';
    if (candidates.length === 0) {
      rowsHtml = `<div class="charitems-skill-popup-empty">No other ${slot.type} skills available.</div>`;
    } else {
      rowsHtml = candidates.map(s => {
        const isCurrent = s.id === equippedId;
        return `<div class="charitems-skill-row ${s.type}" data-skill-id="${s.id}" ${isCurrent ? 'data-current="1"' : ''}>
          <div class="charitems-skill-row-name">${this.escapeHtml(s.name)}${isCurrent ? ' &middot; equipped' : ''}</div>
          <div class="charitems-skill-row-meta">${s.type}${s.cooldown ? ` &middot; CD ${s.cooldown}` : ''}</div>
          <div class="charitems-skill-row-desc">${this.escapeHtml(s.description)}</div>
        </div>`;
      }).join('');
    }

    overlay.innerHTML = `
      <div class="charitems-skill-popup">
        <div class="charitems-skill-popup-title">Slot ${slotIndex + 1} &middot; ${slot.type} (Lv ${slot.unlocksAtLevel}+)</div>
        ${equippedNow ? `<div style="font-size:9px;color:var(--text-secondary)">Currently: <strong>${this.escapeHtml(equippedNow.name)}</strong></div>` : ''}
        <div style="display:flex;flex-direction:column;gap:6px;">${rowsHtml}</div>
        <div class="charitems-skill-popup-actions">
          <button class="charitems-skill-popup-btn cancel-btn">Cancel</button>
          ${equippedNow ? `<button class="charitems-skill-popup-btn danger clear-btn">Clear slot</button>` : ''}
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    bringToFront(overlay);
    this.skillPopupOpen = true;

    const close = () => this.closeSkillPopup();

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.cancel-btn')?.addEventListener('click', close);
    overlay.querySelector('.clear-btn')?.addEventListener('click', () => {
      this.gameClient.sendUnequipSkill(slotIndex);
      close();
    });

    overlay.querySelectorAll<HTMLElement>('.charitems-skill-row').forEach(row => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-skill-id');
        const isCurrent = row.getAttribute('data-current') === '1';
        if (!id || isCurrent) return;
        this.gameClient.sendEquipSkill(id, slotIndex);
        close();
      });
    });
  }

  private closeSkillPopup(): void {
    document.querySelectorAll<HTMLElement>('.charitems-skill-popup-overlay').forEach(el => {
      release(el);
      el.remove();
    });
    this.skillPopupOpen = false;
  }

  // ── Stat card / meta / XP ───────────────────────────────────

  private renderStatCard(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;
    const bonuses = computeEquipmentBonuses(char.equipment, this.itemDefs, char.level);

    const baseAtk = char.baseDamage;
    const atkLow = baseAtk + bonuses.bonusAttackMin;
    const atkHigh = baseAtk + bonuses.bonusAttackMax;
    const atkVal = atkLow === atkHigh ? `${atkLow}` : `${atkLow}-${atkHigh}`;
    const atkType = char.damageType ? ` ${char.damageType}` : '';

    const drVal = bonuses.damageReductionMax > 0
      ? (bonuses.damageReductionMin === bonuses.damageReductionMax
          ? `${bonuses.damageReductionMax}`
          : `${bonuses.damageReductionMin}-${bonuses.damageReductionMax}`)
      : '0';
    const mrVal = bonuses.magicReductionMax > 0
      ? (bonuses.magicReductionMin === bonuses.magicReductionMax
          ? `${bonuses.magicReductionMax}`
          : `${bonuses.magicReductionMin}-${bonuses.magicReductionMax}`)
      : '0';

    this.statCardEl.innerHTML = `
      <div class="charitems-stat">
        <span class="charitems-stat-label" data-tooltip="ATK">ATK</span>
        <span class="charitems-stat-value">${atkVal}${atkType}</span>
      </div>
      <div class="charitems-stat">
        <span class="charitems-stat-label" data-tooltip="DR">DR</span>
        <span class="charitems-stat-value">${drVal}</span>
      </div>
      <div class="charitems-stat">
        <span class="charitems-stat-label" data-tooltip="MR">MR</span>
        <span class="charitems-stat-value">${mrVal}</span>
      </div>
      <div class="charitems-stat">
        <span class="charitems-stat-label" data-tooltip="HP">HP</span>
        <span class="charitems-stat-value">${char.maxHp}</span>
      </div>
    `;
  }

  private renderMetaRow(className: string, level: number, gold: number): void {
    this.metaRowEl.innerHTML = `
      <span><strong>${classIconHtml(className)} ${this.escapeHtml(className)}</strong></span>
      <span>Lv <strong>${level}</strong></span>
      <span>Gold <strong>${gold.toLocaleString()}</strong></span>
    `;
  }

  private renderXpBar(xp: number, xpForNextLevel: number): void {
    this.xpLabelEl.textContent = `${xp.toLocaleString()} / ${xpForNextLevel.toLocaleString()}`;
    const pct = xpForNextLevel > 0 ? (xp / xpForNextLevel) * 100 : 0;
    this.xpFill.style.width = `${pct}%`;
  }

  private renderXpRate(xpRate: { startTime: number; totalXp: number }): void {
    const elapsedHours = (Date.now() - xpRate.startTime) / 3_600_000;
    const rate = elapsedHours > 0 ? xpRate.totalXp / elapsedHours : 0;
    this.xpRateEl.textContent = CharItemsScreen.formatXpRate(rate);
    this.xpRateFromEl.textContent = `from ${CharItemsScreen.formatDateTime(xpRate.startTime)}`;
  }

  private static formatXpRate(rate: number): string {
    if (rate < 1000) return `${Math.round(rate)}/hr`;
    if (rate < 1_000_000) return `${(rate / 1_000).toFixed(1)}k/hr`;
    if (rate < 1_000_000_000) return `${(rate / 1_000_000).toFixed(1)}m/hr`;
    if (rate < 1_000_000_000_000) return `${(rate / 1_000_000_000).toFixed(1)}b/hr`;
    if (rate < 1_000_000_000_000_000) return `${(rate / 1_000_000_000_000).toFixed(1)}t/hr`;
    return '?/hr';
  }

  private static formatDateTime(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    const mon = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    return `${mon}/${day} ${h}:${m}`;
  }

  // ── Stat tooltip ────────────────────────────────────────────

  private showStatTooltip(anchor: HTMLElement): void {
    this.removeStatTooltip();
    const key = anchor.getAttribute('data-tooltip') ?? '';
    const info = STAT_TOOLTIPS[key];
    if (!info) return;

    const tooltip = document.createElement('div');
    tooltip.className = 'charitems-stat-tooltip';
    tooltip.innerHTML = `
      <div class="charitems-stat-tooltip-title">${this.escapeHtml(info.full)}</div>
      <div>${this.escapeHtml(info.desc)}</div>
    `;
    document.body.appendChild(tooltip);

    const rect = anchor.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, rect.left + rect.width / 2 - tooltip.offsetWidth / 2)}px`;
    tooltip.style.top = `${rect.bottom + 6}px`;

    const dismiss = () => {
      this.removeStatTooltip();
      document.removeEventListener('click', dismiss);
    };
    setTimeout(() => document.addEventListener('click', dismiss), 0);
  }

  private removeStatTooltip(): void {
    document.querySelectorAll('.charitems-stat-tooltip').forEach(el => el.remove());
  }

  // ── Inventory ───────────────────────────────────────────────

  private renderInventory(): void {
    const entries = Object.entries(this.lastInventory).filter(([, count]) => count > 0);
    if (entries.length === 0) {
      this.inventoryGrid.innerHTML = '<div class="items-empty" style="grid-column:1/-1">No items yet</div>';
      return;
    }

    let filtered = entries;
    if (this.searchFilter) {
      filtered = filtered.filter(([id]) => {
        const def = this.itemDefs[id];
        return def && def.name.toLowerCase().includes(this.searchFilter);
      });
    }

    filtered = [...filtered];
    const rarityRank = (id: string): number =>
      RARITY_ORDER[this.itemDefs[id]?.rarity ?? 'common'] ?? 5;
    const slotRank = (id: string): number => {
      const slot = this.itemDefs[id]?.equipSlot;
      return slot ? (SLOT_ORDER[slot] ?? 99) : 100;
    };

    if (this.sortMode === 'rarity') {
      filtered.sort(([aId], [bId]) => rarityRank(aId) - rarityRank(bId));
    } else if (this.sortMode === 'type') {
      // Type bucket first, then rarity within each type bucket so the
      // best-of-each-slot floats to the top of its group.
      filtered.sort(([aId], [bId]) => {
        const slotDelta = slotRank(aId) - slotRank(bId);
        if (slotDelta !== 0) return slotDelta;
        return rarityRank(aId) - rarityRank(bId);
      });
    }
    // 'newest' keeps original order

    if (filtered.length === 0) {
      this.inventoryGrid.innerHTML = '<div class="items-empty" style="grid-column:1/-1">No matches</div>';
      return;
    }

    if (this.sortMode === 'rarity' || this.sortMode === 'type') {
      // Group with headers
      this.inventoryGrid.innerHTML = this.renderGroupedInventory(filtered);
    } else {
      this.inventoryGrid.innerHTML = filtered.map(([itemId, count]) => this.renderInventoryEntry(itemId, count)).join('');
    }
  }

  private renderInventoryEntry(itemId: string, count: number): string {
    const def = this.itemDefs[itemId];
    if (!def) return '';
    return renderItemIcon(itemId, def, {
      qty: count,
      showSlotIcon: true,
      showSetIndicator: true,
      setDefs: this.setDefs,
      dataAttrs: { item: itemId },
    });
  }

  private renderGroupedInventory(entries: [string, number][]): string {
    const buckets = new Map<string, [string, number][]>();
    for (const [id, count] of entries) {
      const def = this.itemDefs[id];
      const key = this.getBucketKey(def);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push([id, count]);
    }

    const orderedKeys = this.sortMode === 'rarity'
      ? RARITY_BUCKET_ORDER.filter(k => buckets.has(k))
      : [...buckets.keys()].sort((a, b) => (SLOT_ORDER[a] ?? 99) - (SLOT_ORDER[b] ?? 99));

    let html = '';
    for (const key of orderedKeys) {
      const items = buckets.get(key);
      if (!items) continue;
      html += `<div class="charitems-inv-group-header">${this.escapeHtml(this.formatBucketLabel(key))}</div>`;
      html += items.map(([id, count]) => this.renderInventoryEntry(id, count)).join('');
    }
    return html;
  }

  private getBucketKey(def: ItemDefinition | undefined): string {
    if (this.sortMode === 'rarity') return def?.rarity ?? 'common';
    return def?.equipSlot ?? 'material';
  }

  private formatBucketLabel(key: string): string {
    if (this.sortMode === 'rarity') {
      return key.charAt(0).toUpperCase() + key.slice(1);
    }
    if (key === 'material') return 'Materials';
    return SLOT_LABELS[key] ?? (key.charAt(0).toUpperCase() + key.slice(1));
  }

  // ── Mailbox / trades ───────────────────────────────────────

  private renderMailbox(): void {
    if (this.lastMailbox.length === 0) {
      this.mailboxContainer.innerHTML = '';
      return;
    }
    const rows = this.lastMailbox.map(entry => {
      const def = this.itemDefs[entry.itemId];
      const color = def ? (RARITY_COLORS[def.rarity] ?? '#e8e8e8') : '#e8e8e8';
      const name = def?.name ?? entry.itemId;
      const fullCount = (this.lastInventory[entry.itemId] ?? 0) + entry.quantity;
      const willOverflow = fullCount > 99;
      const note = entry.returned ? '<span class="mailbox-note">(returned)</span>' : '';
      const overflow = willOverflow
        ? `<div class="mailbox-warn">Inventory full — would exceed 99 (${this.lastInventory[entry.itemId] ?? 0} + ${entry.quantity})</div>`
        : '';
      return `<div class="mailbox-row">
        <div class="mailbox-info">
          <div class="mailbox-from">From <strong>${this.escapeHtml(entry.fromUsername)}</strong> ${note}</div>
          <div class="mailbox-item">
            <span class="mailbox-item-name" style="color:${color}">${this.escapeHtml(name)}</span>
            <span class="mailbox-item-qty">×${entry.quantity}</span>
          </div>
          ${overflow}
        </div>
        <div class="mailbox-actions">
          <button class="social-action-btn add-friend" data-mb-action="accept" data-entry-id="${this.escapeHtml(entry.id)}"${willOverflow ? ' disabled' : ''}>Accept</button>
          <button class="social-action-btn remove-friend" data-mb-action="deny" data-entry-id="${this.escapeHtml(entry.id)}">Decline</button>
        </div>
      </div>`;
    }).join('');
    this.mailboxContainer.innerHTML = `
      <div class="items-section-label">Mailbox <span class="items-section-count">(${this.lastMailbox.length})</span></div>
      <div class="mailbox-list">${rows}</div>
    `;
  }

  private renderProposedTrades(): void {
    if (this.lastProposedTrades.length === 0) {
      this.tradesContainer.innerHTML = '';
      return;
    }
    const rows = this.lastProposedTrades.map(t => {
      const partner = t.initiator.username === this.lastUsername
        ? (t.target?.username ?? '')
        : t.initiator.username;
      const waitingOnMe = t.lastUpdatedBy !== this.lastUsername;
      const status = waitingOnMe
        ? (t.status === 'countered' ? 'Confirm or counter' : 'Awaiting your response')
        : (t.status === 'countered' ? 'Waiting for partner to confirm' : 'Waiting for partner');
      const myItems = t.initiator.username === this.lastUsername
        ? t.initiator.items
        : (t.target?.items ?? []);
      const theirItems = t.initiator.username === this.lastUsername
        ? (t.target?.items ?? [])
        : t.initiator.items;
      const summarize = (items: { itemId: string; quantity: number }[]) =>
        items.length === 0
          ? '<span class="trade-row-empty">— nothing —</span>'
          : items.map(({ itemId, quantity }) => {
              const def = this.itemDefs[itemId];
              const color = def ? (RARITY_COLORS[def.rarity] ?? '#e8e8e8') : '#e8e8e8';
              return `<span class="trade-row-item" style="color:${color}">${this.escapeHtml(def?.name ?? itemId)} ×${quantity}</span>`;
            }).join(', ');
      return `<div class="trade-row${waitingOnMe ? ' trade-row-attention' : ''}" data-trade-id="${this.escapeHtml(t.id)}">
        <div class="trade-row-main">
          <div class="trade-row-partner">${this.escapeHtml(partner)}</div>
          <div class="trade-row-status">${this.escapeHtml(status)}</div>
          <div class="trade-row-offers">
            <div class="trade-row-side"><span class="trade-row-label">You:</span> ${summarize(myItems)}</div>
            <div class="trade-row-side"><span class="trade-row-label">Them:</span> ${summarize(theirItems)}</div>
          </div>
        </div>
        <div class="trade-row-actions">
          <button class="social-action-btn add-friend" data-trade-id="${this.escapeHtml(t.id)}">Open</button>
          <button class="social-action-btn remove-friend" data-trade-cancel="${this.escapeHtml(t.id)}">Cancel</button>
        </div>
      </div>`;
    }).join('');
    this.tradesContainer.innerHTML = `
      <div class="items-section-label">Proposed Trades <span class="items-section-count">(${this.lastProposedTrades.length})</span></div>
      <div class="trade-list">${rows}</div>
    `;
  }

  // ── Item popups (preserved from ItemsScreen) ───────────────

  private showItemPopup(itemId: string, context: 'equipped' | 'inventory', equippedSlot?: EquipSlot): void {
    const def = this.itemDefs[itemId];
    if (!def) return;

    const ownedItemIds = getOwnedItemIds(this.lastInventory, this.lastEquipment);
    const equippedItemIds = getEquippedItemIds(this.lastEquipment);

    const count = this.lastInventory[itemId] ?? 0;
    let actionsHtml = '';
    if (context === 'equipped' && equippedSlot) {
      actionsHtml = `<button class="popup-action-unequip" data-slot="${equippedSlot}">Unequip</button>`;
    } else if (context === 'inventory') {
      if (def.equipSlot) {
        // If a copy of this exact item is already in the slot, show
        // "Equipped" disabled instead of an Equip button — clicking would be
        // a no-op and the player should know it's already on.
        const alreadyEquipped = this.lastEquipment[def.equipSlot] === itemId;
        if (alreadyEquipped) {
          actionsHtml += `<button class="popup-action-equip" data-item="${itemId}" disabled aria-disabled="true">Equipped</button>`;
        } else {
          actionsHtml += `<button class="popup-action-equip" data-item="${itemId}">Equip</button>`;
        }
      }
      actionsHtml += `<button class="popup-action-destroy danger" data-item="${itemId}" data-max="${count}">Destroy</button>`;
    }

    // Inline equip-compare block when viewing an inventory item that would
    // replace something already equipped — saves the player from having to
    // click Equip just to see the swap diff.
    let extraHtml = '';
    if (context === 'inventory' && def.equipSlot) {
      const currentId = this.lastEquipment[def.equipSlot];
      if (currentId && currentId !== itemId) {
        const oldDef = this.itemDefs[currentId];
        if (oldDef) extraHtml = this.buildEquipCompareBlock(def, oldDef);
      }
    }

    const popupContent = renderItemPopupContent(def, {
      itemDefs: this.itemDefs,
      setDefs: this.setDefs,
      ownedItemIds,
      equippedItemIds,
      className: this.lastClassName || null,
      actionsHtml,
      extraHtml,
    });

    this.modalOverlay.innerHTML = `
      <div class="item-popup-overlay">
        <div class="item-popup">${popupContent}</div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';
    bringToFront(this.modalOverlay);

    const overlay = this.modalOverlay.querySelector('.item-popup-overlay') as HTMLElement;
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) this.hideModal();
    });

    const unequipBtn = this.modalOverlay.querySelector('.popup-action-unequip') as HTMLElement | null;
    if (unequipBtn) {
      unequipBtn.addEventListener('click', () => {
        const slot = unequipBtn.getAttribute('data-slot');
        if (slot) this.gameClient.sendUnequipItem(slot);
        this.hideModal();
      });
    }

    const equipBtn = this.modalOverlay.querySelector('.popup-action-equip') as HTMLElement | null;
    if (equipBtn) {
      equipBtn.addEventListener('click', () => {
        const id = equipBtn.getAttribute('data-item');
        if (!id) { this.hideModal(); return; }
        const eDef = this.itemDefs[id];
        const restrict = eDef?.classRestriction;
        // Class-restricted item the player can't use → keep the popup open
        // and pulse-highlight the class line so they catch the red text.
        if (restrict && restrict.length > 0 && this.lastClassName && !restrict.includes(this.lastClassName)) {
          this.pulseClassRestriction();
          return;
        }
        // Inline compare in the popup already shows the swap diff, so
        // clicking Equip just commits — no second confirmation popup.
        this.gameClient.sendEquipItem(id);
        this.hideModal();
      });
    }

    const destroyBtn = this.modalOverlay.querySelector('.popup-action-destroy') as HTMLElement | null;
    if (destroyBtn) {
      destroyBtn.addEventListener('click', () => {
        const id = destroyBtn.getAttribute('data-item')!;
        const max = parseInt(destroyBtn.getAttribute('data-max') ?? '1', 10);
        const dDef = this.itemDefs[id];
        if (max === 1) {
          this.showConfirmModal(
            `Destroy ${dDef?.name ?? 'item'}?`,
            'This item will be permanently lost.',
            () => { this.gameClient.sendDestroyItems(id, 1); this.hideModal(); }
          );
        } else {
          this.showDestroyCountModal(id, dDef?.name ?? 'item', max);
        }
      });
    }
  }

  private showConfirmModal(title: string, message: string, onConfirm: () => void): void {
    this.modalOverlay.innerHTML = `
      <div class="item-popup-overlay">
        <div class="item-popup">
          <div class="item-popup-name">${title}</div>
          <div class="item-popup-stats" style="text-align:center">${message}</div>
          <div class="item-popup-actions">
            <button class="items-modal-confirm danger">Destroy</button>
            <button class="items-modal-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';
    bringToFront(this.modalOverlay);

    const overlay = this.modalOverlay.querySelector('.item-popup-overlay') as HTMLElement;
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) this.hideModal(); });
    this.modalOverlay.querySelector('.items-modal-confirm')!.addEventListener('click', onConfirm);
    this.modalOverlay.querySelector('.items-modal-cancel')!.addEventListener('click', () => this.hideModal());
  }

  private showDestroyCountModal(itemId: string, itemName: string, max: number): void {
    this.modalOverlay.innerHTML = `
      <div class="item-popup-overlay">
        <div class="item-popup">
          <div class="item-popup-name">Destroy ${itemName}</div>
          <div class="item-popup-stats" style="text-align:center">How many? (1-${max})</div>
          <div class="items-modal-count-row" style="display:flex;gap:8px;justify-content:center;align-items:center;margin:8px 0">
            <button class="items-modal-minus" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e8e8e8;cursor:pointer;font-family:inherit">-</button>
            <span class="items-modal-count-value" style="min-width:24px;text-align:center">1</span>
            <button class="items-modal-plus" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e8e8e8;cursor:pointer;font-family:inherit">+</button>
            <button class="items-modal-max" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#2a2a40;color:#e8e8e8;cursor:pointer;font-family:inherit">Max</button>
          </div>
          <div class="item-popup-actions">
            <button class="items-modal-confirm danger">Destroy</button>
            <button class="items-modal-cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';
    bringToFront(this.modalOverlay);

    const overlay = this.modalOverlay.querySelector('.item-popup-overlay') as HTMLElement;
    overlay?.addEventListener('click', (e) => { if (e.target === overlay) this.hideModal(); });

    const countEl = this.modalOverlay.querySelector('.items-modal-count-value') as HTMLElement;
    let count = 1;
    const updateCount = (n: number) => {
      count = Math.max(1, Math.min(max, n));
      countEl.textContent = String(count);
    };

    this.modalOverlay.querySelector('.items-modal-minus')!.addEventListener('click', () => updateCount(count - 1));
    this.modalOverlay.querySelector('.items-modal-plus')!.addEventListener('click', () => updateCount(count + 1));
    this.modalOverlay.querySelector('.items-modal-max')!.addEventListener('click', () => updateCount(max));
    this.modalOverlay.querySelector('.items-modal-confirm')!.addEventListener('click', () => {
      this.gameClient.sendDestroyItems(itemId, count);
      this.hideModal();
    });
    this.modalOverlay.querySelector('.items-modal-cancel')!.addEventListener('click', () => this.hideModal());
  }

  private showEquipBlockedModal(msg: ServerEquipBlockedMessage): void {
    const newDef = this.itemDefs[msg.itemId];
    const oldDef = this.itemDefs[msg.blockedByItemId];
    const newName = newDef?.name ?? 'item';
    const oldName = oldDef?.name ?? 'item';

    this.showConfirmModal(
      'Inventory full!',
      `Destroy equipped ${oldName} to equip ${newName}?`,
      () => {
        this.gameClient.sendEquipItemForceDestroy(msg.itemId);
        this.hideModal();
      }
    );
  }

  private showSlotTooltip(anchor: HTMLElement, slot: EquipSlot): void {
    document.querySelector('.items-slot-tooltip')?.remove();
    const label = SLOT_LABELS[slot] ?? slot;
    const tooltip = document.createElement('div');
    tooltip.className = 'items-slot-tooltip';
    tooltip.textContent = label;
    tooltip.style.cssText = 'position:fixed;background:#222;color:#e8e8e8;padding:4px 10px;border-radius:4px;font-size:11px;z-index:1000;pointer-events:none;border:1px solid #555;white-space:nowrap;';
    document.body.appendChild(tooltip);
    const rect = anchor.getBoundingClientRect();
    tooltip.style.left = `${rect.left + rect.width / 2 - tooltip.offsetWidth / 2}px`;
    tooltip.style.top = `${rect.bottom + 4}px`;
    setTimeout(() => tooltip.remove(), 1500);
  }

  private hideModal(): void {
    this.modalOverlay.style.display = 'none';
    this.modalOverlay.innerHTML = '';
    release(this.modalOverlay);
  }

  /** localStorage key for the inventory sort choice — keyed per username so
   *  alts on the same browser keep their own preference. */
  private sortPrefKey(): string | null {
    return this.lastUsername ? `inventorySort:${this.lastUsername}` : null;
  }
  private loadSortPref(): SortMode | null {
    const key = this.sortPrefKey();
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      if (raw === 'rarity' || raw === 'type' || raw === 'newest') return raw;
    } catch { /* ignore */ }
    return null;
  }
  private persistSortPref(): void {
    const key = this.sortPrefKey();
    if (!key) return;
    try { localStorage.setItem(key, this.sortMode); } catch { /* ignore */ }
  }

  /**
   * Build the inline equip-comparison HTML block. Rendered inside the item
   * popup whenever the viewed inventory item would replace something already
   * equipped — players see the diff up-front instead of having to click
   * Equip just to preview the swap.
   *
   * Layout: header line "Replaces: <oldName>" + a 4-col grid (label / new /
   * arrow / current). Stats shown for both items unconditionally; arrows
   * only appear when both items contribute to the same stat.
   */
  private buildEquipCompareBlock(newDef: ItemDefinition, oldDef: ItemDefinition): string {
    type StatKey = 'atk' | 'dr' | 'mr';
    const stats: { key: StatKey; label: string }[] = [
      { key: 'atk', label: 'ATK' },
      { key: 'dr', label: 'DR' },
      { key: 'mr', label: 'MR' },
    ];
    const itemStat = (def: ItemDefinition, key: StatKey): string | null => {
      if (key === 'atk') {
        const lo = def.bonusAttackMin ?? 0;
        const hi = def.bonusAttackMax ?? 0;
        if (lo === 0 && hi === 0) return null;
        return lo === hi ? `+${lo}` : `+${lo}-${hi}`;
      }
      if (key === 'dr') {
        const lo = def.damageReductionMin ?? 0;
        const hi = def.damageReductionMax ?? 0;
        if (lo === 0 && hi === 0) return null;
        return lo === hi ? `${lo}` : `${lo}-${hi}`;
      }
      const lo = def.magicReductionMin ?? 0;
      const hi = def.magicReductionMax ?? 0;
      if (lo === 0 && hi === 0) return null;
      return lo === hi ? `${lo}` : `${lo}-${hi}`;
    };
    const mid = (def: ItemDefinition, key: StatKey): number => {
      if (key === 'atk') return ((def.bonusAttackMin ?? 0) + (def.bonusAttackMax ?? 0)) / 2;
      if (key === 'dr') return ((def.damageReductionMin ?? 0) + (def.damageReductionMax ?? 0)) / 2;
      return ((def.magicReductionMin ?? 0) + (def.magicReductionMax ?? 0)) / 2;
    };

    const rows = stats.map(({ key, label }) => {
      const newV = itemStat(newDef, key);
      const oldV = itemStat(oldDef, key);
      if (newV === null && oldV === null) return '';
      let arrow = '';
      if (newV !== null && oldV !== null) {
        const dn = mid(newDef, key);
        const dc = mid(oldDef, key);
        if (dn > dc) arrow = '<span class="compare-up">↑</span>';
        else if (dn < dc) arrow = '<span class="compare-down">↓</span>';
        else arrow = '<span class="compare-eq">=</span>';
      }
      return `
        <div class="compare-row">
          <div class="compare-cell-label">${label}</div>
          <div class="compare-cell-new">${newV ?? '<span class="compare-dash">—</span>'}</div>
          <div class="compare-cell-arrow">${arrow}</div>
          <div class="compare-cell-old">${oldV ?? '<span class="compare-dash">—</span>'}</div>
        </div>
      `;
    }).join('');

    const oldColor = (RARITY_COLORS[oldDef.rarity ?? 'common']) ?? '#e8e8e8';

    return `
      <div class="item-popup-compare">
        <div class="compare-block-header">
          <span class="compare-block-label">Replaces equipped</span>
          <span class="compare-block-old-name" style="color:${oldColor}">${this.escapeHtml(oldDef.name)}</span>
        </div>
        <div class="compare-block-subhead">
          <span class="compare-cell-label">Stat</span>
          <span class="compare-side-label">This</span>
          <span></span>
          <span class="compare-side-label">Equipped</span>
        </div>
        <div class="compare-grid">${rows || '<div class="compare-dash" style="text-align:center;grid-column:1/-1">No combat stats</div>'}</div>
      </div>
    `;
  }

  /**
   * Pulse-highlight the class-restriction line in the open item popup so
   * the player notices the red class text. The popup itself stays open;
   * just the class row gets a brief attention animation.
   */
  private pulseClassRestriction(): void {
    const row = this.modalOverlay.querySelector('[data-class-restriction]') as HTMLElement | null;
    if (!row) return;
    row.classList.remove('class-restriction-pulse');
    // Force reflow so re-adding the class restarts the animation if the
    // user clicks Equip multiple times in a row.
    void row.offsetWidth;
    row.classList.add('class-restriction-pulse');
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
