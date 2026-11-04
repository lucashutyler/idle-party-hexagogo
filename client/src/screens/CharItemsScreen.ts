import type { GameClient } from '../network/GameClient';
import { confirmDialog } from '../ui/ConfirmDialog';
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
  CLASS_DEFINITIONS,
  CLASS_GLYPHS,
  getSkillsForClass,
  getOwnedItemIds,
  getEquippedItemIds,
  canClassEquipItem,
  getItemEffectText,
} from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import type { WorldCache } from '../network/WorldCache';
import {
  RARITY_ORDER,
  SLOT_LABELS,
  renderItemIcon,
  renderItemCell,
  renderEmptySlotIcon,
  RARITY_COLORS,
  escapeHtml,
  wireRoleButtons,
  writeItemSquareQty,
} from '../ui/ItemIcon';
import { ITEM_POPUP_CLOSE_HTML, renderItemPopupContent } from '../ui/ItemPopup';
import { renderEquipCompareBlock } from '../ui/EquipCompare';
import { artworkUrl, renderTrackedImg } from '../ui/assets';
import { bringToFront, registerDismiss, release } from '../ui/ModalStack';
import { renderSkillCardMeta } from '../ui/SkillCardChip';
import { BestiaryCard, BestiaryModal } from '../ui/BestiaryModal';
import { deferWhilePressed, setHtml } from '../ui/render';
import { renderSegments, wireSegments } from '../ui/Segments';

/** First row of the gear grid. */
const LEFT_SLOTS: EquipSlot[] = ['head', 'shoulders', 'chest', 'gloves', 'foot', 'mainhand'];

/** Second row of the gear grid. */
const RIGHT_SLOTS: EquipSlot[] = ['back', 'necklace', 'bracers', 'ring', 'relic', 'offhand'];

/** Bag items an equipment slot accepts. */
const SLOT_ACCEPTS: Partial<Record<EquipSlot, EquipSlot[]>> = {
  mainhand: ['mainhand', 'twohanded'],
};

type SortMode = 'rarity' | 'type' | 'newest';

type HeroTab = 'gear' | 'skills' | 'stats';

const HERO_TABS: readonly HeroTab[] = ['gear', 'skills', 'stats'];
const HERO_TAB_KEY = 'heroTab';

function isHeroTab(value: string | null): value is HeroTab {
  return HERO_TABS.includes(value as HeroTab);
}

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

export class CharItemsScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private isActive = false;

  private contentEl!: HTMLElement;
  private segmentsEl!: HTMLElement;
  private tab: HeroTab = 'gear';
  private tabScrollTop: Record<HeroTab, number> = { gear: 0, skills: 0, stats: 0 };
  private skillsNeedAttention = false;

  private portraitEl!: HTMLElement;
  private bannerTitleEl!: HTMLElement;
  private equipLeftCol!: HTMLElement;
  private equipRightCol!: HTMLElement;
  private skillStripEl!: HTMLElement;

  private statCardEl!: HTMLElement;
  private statListEl!: HTMLElement;
  private metaRowEl!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpLabelEl!: HTMLElement;
  private xpRateEl!: HTMLElement;
  private xpRateFromEl!: HTMLElement;
  private summaryXpLabelEl!: HTMLElement;
  private summaryXpFill!: HTMLElement;
  private summarySkillsEl!: HTMLElement;
  private classPassiveEl!: HTMLElement;
  private bestiaryCard!: BestiaryCard;
  private bestiaryModal: BestiaryModal;

  private inventoryGrid!: HTMLElement;
  private inventoryCountEl!: HTMLElement;
  private mailboxContainer!: HTMLElement;
  private tradesContainer!: HTMLElement;
  private sentTradesContainer!: HTMLElement;
  private modalOverlay!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private sortSelect!: HTMLSelectElement;

  private unsubscribe?: () => void;
  private unsubEquipBlocked?: () => void;
  private unsubBestiary?: () => void;

  private itemDefs: Record<string, ItemDefinition> = {};
  private setDefs: Record<string, SetDefinition> = {};

  private lastEquipment: Record<string, string | null> = {};
  private lastInventory: Record<string, number> = {};
  private lastClassName = '';
  private lastMailbox: MailboxEntry[] = [];
  private lastProposedTrades: TradeState[] = [];
  private lastUsername = '';

  private lastEquipKey = '';
  private lastInvKey = '';
  private renderedInvOrderKey = '';
  private renderedInvCounts: Record<string, number> = {};
  private invCountsPatched = false;
  private lastSkillKey = '';
  private lastMailboxKey = '';
  private lastTradesKey = '';
  private lastHeroKey = '';
  private lastStatKey = '';

  private searchFilter = '';
  private sortMode: SortMode = 'type';
  private sortPrefLoaded = false;

  private skillPopupOpen = false;
  private statTooltipTeardown?: () => void;
  private onOpenTrade?: (tradeId: string) => void;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.bestiaryModal = new BestiaryModal(gameClient);

    this.buildDOM();
  }

  setOnOpenTrade(cb: (tradeId: string) => void): void {
    this.onOpenTrade = cb;
  }

  setSubTab(sub: string): void {
    if (isHeroTab(sub)) this.selectTab(sub);
  }

  onActivate(): void {
    this.isActive = true;

    this.unsubscribe = this.gameClient.subscribe(() => {
      deferWhilePressed(this.container, () => {
        const state = this.gameClient.lastState;
        if (this.isActive && state) this.updateFromState(state);
      });
    });

    this.unsubEquipBlocked = this.gameClient.onEquipBlocked((msg) => {
      if (this.isActive) this.showEquipBlockedModal(msg);
    });

    this.unsubBestiary = this.gameClient.onBestiary(() => {
      deferWhilePressed(this.container, () => {
        const current = this.gameClient.lastState;
        if (this.isActive && current) this.updateFromState(current);
      });
    });
    if (this.gameClient.lastState?.character?.mastery) this.gameClient.requestBestiary();

    const state = this.gameClient.lastState;
    if (state) this.updateFromState(state);
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubEquipBlocked?.();
    this.unsubEquipBlocked = undefined;
    this.unsubBestiary?.();
    this.unsubBestiary = undefined;
    this.bestiaryModal.close();
    this.hideModal();
    this.closeSkillPopup();
    this.removeStatTooltip();
  }

  private buildDOM(): void {
    const savedTab = sessionStorage.getItem(HERO_TAB_KEY);
    if (isHeroTab(savedTab)) this.tab = savedTab;

    this.container.innerHTML = `
      <div class="charitems-content" data-hero-tab="${this.tab}">
        <div class="hero-segments"></div>

        <div class="hero-pane hero-pane-gear" data-pane="gear">
          <div class="items-mailbox"></div>
          <div class="items-trades"></div>

          <div class="hero-loadout">
            <div class="hero-banner">
              <div class="charitems-portrait hero-portrait"></div>
              <div class="hero-banner-main">
                <div class="hero-banner-title"></div>
                <div class="charitems-stat-card"></div>
              </div>
            </div>
            <div class="items-equip-panel">
              <div class="items-equip-col items-equip-left"></div>
              <div class="items-equip-col items-equip-right"></div>
            </div>
            <div class="hero-summary">
              <div class="hero-summary-xp">
                <div class="character-xp-label"><span>XP</span><span class="hero-summary-xp-numbers"></span></div>
                <div class="charitems-xp-bar"><div class="charitems-xp-fill"></div></div>
              </div>
              <div class="hero-summary-skills"></div>
              <div class="hero-summary-links">
                <button type="button" class="hero-summary-link" data-nav="items:skills">All skills</button>
                <button type="button" class="hero-summary-link" data-nav="items:stats">All stats</button>
              </div>
            </div>
          </div>

          <div class="hero-inventory">
            <div class="items-search-sort">
              <div class="items-section-label">Inventory <span class="items-section-count"></span></div>
              <input type="text" class="items-search-input" placeholder="Search..." aria-label="Search items" enterkeyhint="search" />
              <select class="items-sort-select" aria-label="Sort items">
                <option value="type">Type</option>
                <option value="rarity">Rarity</option>
                <option value="newest">Newest</option>
              </select>
            </div>
            <div class="items-inv-grid"></div>
          </div>

          <div class="items-trades-sent"></div>
        </div>

        <div class="hero-pane hero-pane-skills" data-pane="skills">
          <div class="charitems-skills-strip"></div>
        </div>

        <div class="hero-pane hero-pane-stats" data-pane="stats">
          <div class="hero-stats-col">
            <div class="charitems-meta-row"></div>
            <div class="charitems-xp-bar-wrap">
              <div class="character-xp-label">
                <span>XP</span>
                <span class="charitems-xp-numbers">0 / 100</span>
              </div>
              <div class="charitems-xp-bar">
                <div class="charitems-xp-fill"></div>
              </div>
              <div class="charitems-xp-rate-row">
                <span>XP Rate</span>
                <span class="charitems-xp-rate-value">0/hr</span>
                <span class="charitems-xp-rate-from"></span>
                <button type="button" class="charitems-xp-rate-reset" aria-label="Reset XP rate counter">&#x21bb;</button>
              </div>
            </div>
            <div class="hero-stat-list"></div>
            <div class="charitems-passive-info"></div>
          </div>
          <div class="charitems-bestiary"></div>
        </div>
      </div>
      <div class="items-modal-overlay" style="display:none"></div>
    `;

    this.contentEl = this.container.querySelector('.charitems-content')!;
    this.segmentsEl = this.container.querySelector('.hero-segments')!;
    wireSegments(this.segmentsEl, (id) => {
      if (isHeroTab(id)) this.selectTab(id);
    });
    this.renderSegmentBar();
    wireRoleButtons(this.contentEl);

    this.portraitEl = this.container.querySelector('.charitems-portrait')!;
    this.bannerTitleEl = this.container.querySelector('.hero-banner-title')!;
    const slotsContainer = this.container.querySelector('.items-equip-panel')!;
    this.equipLeftCol = slotsContainer.querySelector('.items-equip-left')!;
    this.equipRightCol = slotsContainer.querySelector('.items-equip-right')!;

    this.skillStripEl = this.container.querySelector('.charitems-skills-strip')!;
    this.statCardEl = this.container.querySelector('.charitems-stat-card')!;
    this.statListEl = this.container.querySelector('.hero-stat-list')!;
    this.metaRowEl = this.container.querySelector('.charitems-meta-row')!;
    this.xpFill = this.container.querySelector('.hero-pane-stats .charitems-xp-fill')!;
    this.summaryXpLabelEl = this.container.querySelector('.hero-summary-xp-numbers')!;
    this.summaryXpFill = this.container.querySelector('.hero-summary .charitems-xp-fill')!;
    this.summarySkillsEl = this.container.querySelector('.hero-summary-skills')!;
    this.xpLabelEl = this.container.querySelector('.charitems-xp-numbers')!;
    this.xpRateEl = this.container.querySelector('.charitems-xp-rate-value')!;
    this.xpRateFromEl = this.container.querySelector('.charitems-xp-rate-from')!;
    this.classPassiveEl = this.container.querySelector('.charitems-passive-info')!;
    const bestiaryEl = this.container.querySelector<HTMLElement>('.charitems-bestiary')!;
    this.bestiaryCard = new BestiaryCard(bestiaryEl);
    bestiaryEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.bestiary-view-all')) this.bestiaryModal.open();
    });

    this.inventoryGrid = this.container.querySelector('.items-inv-grid')!;
    this.inventoryCountEl = this.container.querySelector('.hero-inventory .items-section-count')!;
    this.mailboxContainer = this.container.querySelector('.items-mailbox')!;
    this.tradesContainer = this.container.querySelector('.items-trades')!;
    this.sentTradesContainer = this.container.querySelector('.items-trades-sent')!;
    this.modalOverlay = this.container.querySelector('.items-modal-overlay')!;
    this.searchInput = this.container.querySelector('.items-search-input')!;
    this.sortSelect = this.container.querySelector('.items-sort-select')!;

    this.container.querySelector('.charitems-xp-rate-reset')!.addEventListener('click', async () => {
      if (!await confirmDialog({ title: 'Reset XP rate counter?', confirmLabel: 'Reset' })) return;
      this.gameClient.resetXpRate();
    });

    this.mailboxContainer.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-mb-action]') as HTMLButtonElement | null;
      if (!btn) return;
      const action = btn.getAttribute('data-mb-action');
      const id = btn.getAttribute('data-entry-id');
      if (!id) return;
      if (action === 'accept') this.gameClient.sendAcceptGift(id);
      if (action === 'deny') this.gameClient.sendDenyGift(id);
    });
    this.tradesContainer.addEventListener('click', (e) => this.onTradeClick(e));
    this.sentTradesContainer.addEventListener('click', (e) => this.onTradeClick(e));

    this.modalOverlay.addEventListener('click', (e) => this.onModalClick(e));
    wireRoleButtons(this.modalOverlay);

    this.searchInput.addEventListener('input', () => {
      this.searchFilter = this.searchInput.value.toLowerCase();
      this.renderInventory();
    });
    this.sortSelect.addEventListener('change', () => {
      this.sortMode = this.sortSelect.value as SortMode;
      this.persistSortPref();
      this.renderInventory();
    });

    slotsContainer.addEventListener('click', (e) => {
      const slotEl = (e.target as HTMLElement).closest('.items-equip-slot-square[data-slot]') as HTMLElement | null;
      if (!slotEl) return;
      const slot = slotEl.getAttribute('data-slot') as EquipSlot;
      const itemId = slotEl.getAttribute('data-item-id');
      if (slot && itemId) {
        this.showItemPopup(itemId, 'equipped', slot);
      } else if (slot) {
        this.showSlotPicker(slot);
      }
    });

    this.inventoryGrid.addEventListener('click', (e) => {
      const cell = (e.target as HTMLElement).closest('.item-cell');
      const itemId = cell?.querySelector('.item-square[data-item]')?.getAttribute('data-item');
      if (itemId) this.showItemPopup(itemId, 'inventory', undefined);
    });

    this.skillStripEl.addEventListener('click', (e) => {
      const slot = (e.target as HTMLElement).closest('.charitems-skill-slot[data-slot-index]') as HTMLElement | null;
      if (!slot) return;
      if (slot.classList.contains('locked')) return;
      const idx = parseInt(slot.getAttribute('data-slot-index')!, 10);
      this.openSkillPopup(idx);
    });

    this.statCardEl.addEventListener('click', (e) => {
      const stat = (e.target as HTMLElement).closest('.charitems-stat');
      const labelEl = stat?.querySelector<HTMLElement>('.charitems-stat-label[data-tooltip]');
      if (!labelEl) return;
      e.stopPropagation();
      this.showStatTooltip(labelEl);
    });
  }

  private selectTab(tab: HeroTab): void {
    if (tab === this.tab) return;
    this.tabScrollTop[this.tab] = this.contentEl.scrollTop;
    this.tab = tab;
    this.contentEl.dataset.heroTab = tab;
    this.contentEl.scrollTop = this.tabScrollTop[tab];
    this.renderSegmentBar();
    sessionStorage.setItem(HERO_TAB_KEY, tab);
  }

  private renderSegmentBar(): void {
    const waitingTrades = this.lastProposedTrades.filter(t => this.isWaitingOnMe(t)).length;
    setHtml(this.segmentsEl, renderSegments([
      { id: 'gear', label: 'Gear', badge: this.lastMailbox.length + waitingTrades },
      { id: 'skills', label: 'Skills', badge: this.skillsNeedAttention },
      { id: 'stats', label: 'Stats' },
    ], this.tab));
  }

  private isWaitingOnMe(trade: TradeState): boolean {
    return trade.lastUpdatedBy !== this.lastUsername;
  }

  private onTradeClick(e: Event): void {
    const target = e.target as HTMLElement;
    const cancelBtn = target.closest<HTMLButtonElement>('button[data-trade-cancel]');
    if (cancelBtn) {
      const id = cancelBtn.getAttribute('data-trade-cancel');
      if (id) void this.confirmCancelTrade(id);
      return;
    }
    const id = target.closest('[data-trade-id]')?.getAttribute('data-trade-id');
    if (id) this.onOpenTrade?.(id);
  }

  private async confirmCancelTrade(tradeId: string): Promise<void> {
    const confirmed = await confirmDialog({
      title: 'Cancel this trade?',
      body: 'The offer will be withdrawn.',
      confirmLabel: 'Cancel trade',
      cancelLabel: 'Keep trade',
      danger: true,
    });
    if (confirmed) this.gameClient.sendCancelTrade(tradeId);
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

    if (!this.sortPrefLoaded && this.lastUsername) {
      this.sortPrefLoaded = true;
      const saved = this.loadSortPref();
      if (saved && saved !== this.sortMode) {
        this.sortMode = saved;
        this.sortSelect.value = saved;
      }
    }

    const heroKey = char.className;
    if (heroKey !== this.lastHeroKey) {
      this.lastHeroKey = heroKey;
      this.renderPortrait(char.className);
      this.renderClassPassive(char.className);
    }

    const defsSize = Object.keys(this.itemDefs).length;
    const equipKey = JSON.stringify(char.equipment) + '|' + defsSize;
    if (equipKey !== this.lastEquipKey) {
      this.lastEquipKey = equipKey;
      this.renderEquipment(char);
    }

    const invKey = JSON.stringify(char.inventory) + '|' + char.className + '|' + defsSize;
    if (invKey !== this.lastInvKey) {
      this.lastInvKey = invKey;
      this.renderInventory();
    }

    const skillKey = JSON.stringify(char.skillLoadout) + '|' + char.level
      + '|' + this.worldCache.contentGeneration
      + '|' + JSON.stringify(char.grantedSkillIds ?? []);
    if (!this.skillPopupOpen && skillKey !== this.lastSkillKey) {
      this.lastSkillKey = skillKey;
      this.renderSkillStrip(state);
    }

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
      this.renderBannerTitle(char.className, char.level);
      this.renderMetaRow(char.className, char.level, char.gold);
      this.renderXpBar(char.xp, char.xpForNextLevel);
    }

    this.renderXpRate(char.xpRate);

    this.bestiaryCard.update(char.mastery, this.gameClient.lastBestiary?.entries ?? [], char.level);

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

    this.renderSegmentBar();
  }

  private renderPortrait(className: string): void {
    const img = renderTrackedImg(artworkUrl('class', className), {
      className: 'hero-portrait-img',
      alt: `${className} portrait`,
    });
    const glyph = CLASS_GLYPHS[className] ?? escapeHtml(className.charAt(0));
    this.portraitEl.innerHTML = `${img}<span class="hero-portrait-glyph" aria-hidden="true">${glyph}</span>`;
  }

  private renderClassPassive(className: string): void {
    const def = CLASS_DEFINITIONS[className as ClassName];
    if (!def) {
      this.classPassiveEl.textContent = '';
      return;
    }
    this.classPassiveEl.innerHTML = `
      <strong>${escapeHtml(def.displayName)}</strong> &middot; <em>${escapeHtml(def.damageType)}</em><br>
      ${escapeHtml(def.description)}
    `;
  }

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
          interactive: true,
        });
      }
      return renderEmptySlotIcon(slot, { extraClass: 'items-equip-slot-square', dataAttrs, interactive: true });
    };

    setHtml(this.equipLeftCol, LEFT_SLOTS.map(renderSlotSquare).join(''));
    setHtml(this.equipRightCol, RIGHT_SLOTS.map(renderSlotSquare).join(''));
  }

  private renderSkillStrip(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    const slots = this.worldCache.getSlotSchedule(char.className);
    const equipped = new Set(char.skillLoadout.equippedSkills.filter(Boolean) as string[]);
    const available = [...(char.skillLoadout.unlockedSkills ?? []), ...(char.grantedSkillIds ?? [])]
      .filter(id => !equipped.has(id))
      .map(id => this.worldCache.getSkill(id));
    let html = '';
    let attention = false;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const isUnlocked = char.level >= slot.unlocksAtLevel;
      const equippedId = char.skillLoadout.equippedSkills[i] ?? null;
      const skill = equippedId ? this.worldCache.getSkill(equippedId) : null;
      const kind = slot.type === 'active' ? 'Active' : 'Passive';

      if (!isUnlocked) {
        html += `<div class="charitems-skill-slot locked">
          <span class="charitems-skill-slot-kind">${kind}</span>
          <span class="charitems-skill-slot-name">Unlocks at Lv ${slot.unlocksAtLevel}</span>
        </div>`;
      } else if (skill) {
        html += `<div class="charitems-skill-slot filled ${skill.type}" data-slot-index="${i}" role="button" tabindex="0">
          <span class="charitems-skill-slot-name">${escapeHtml(skill.name)}</span>
          ${renderSkillCardMeta(skill)}
          <span class="charitems-skill-slot-desc">${escapeHtml(skill.description)}</span>
        </div>`;
      } else {
        const canFill = available.some(s => s?.type === slot.type);
        attention ||= canFill;
        html += `<div class="charitems-skill-slot empty${canFill ? ' can-fill' : ''}" data-slot-index="${i}" role="button" tabindex="0">
          <span class="charitems-skill-slot-kind">${kind}</span>
          <span class="charitems-skill-slot-name">${canFill ? `Choose ${slot.type === 'active' ? 'an active' : 'a passive'} skill` : 'Empty slot'}</span>
        </div>`;
      }
    }
    this.skillsNeedAttention = attention;
    setHtml(this.skillStripEl, html || '<div class="ui-empty">No skill slots yet.</div>');
    this.renderSummarySkills(char.skillLoadout.equippedSkills);
  }

  private renderSummarySkills(equippedIds: readonly (string | null)[]): void {
    const rows = equippedIds
      .map(id => (id ? this.worldCache.getSkill(id) : null))
      .filter((skill): skill is SkillDefinition => !!skill)
      .map(skill => `<li class="hero-summary-skill ${skill.type}">${escapeHtml(skill.name)}</li>`);
    setHtml(this.summarySkillsEl, rows.length > 0
      ? `<ul class="hero-summary-skill-list">${rows.join('')}</ul>`
      : '<div class="hero-summary-empty">No skills equipped</div>');
  }

  private openSkillPopup(slotIndex: number): void {
    this.closeSkillPopup();

    const state = this.gameClient.lastState;
    if (!state?.character) return;
    const char = state.character;
    const slot = this.worldCache.getSlotSchedule(char.className)[slotIndex];
    if (!slot) return;

    const equippedId = char.skillLoadout.equippedSkills[slotIndex] ?? null;
    const equippedNow = equippedId ? this.worldCache.getSkill(equippedId) : null;

    const equippedIds = new Set(char.skillLoadout.equippedSkills.filter(Boolean) as string[]);
    const unlockedIds = new Set(char.skillLoadout.unlockedSkills);
    const grantedIds = new Set(char.grantedSkillIds ?? []);
    const classSkills = getSkillsForClass(char.className as ClassName, this.worldCache.getSkillContent());

    type Candidate = { skill: SkillDefinition; locked: boolean; granted: boolean };
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const skill of classSkills) {
      if (skill.type !== slot.type) continue;
      seen.add(skill.id);
      const isUnlocked = unlockedIds.has(skill.id);
      const isGranted = grantedIds.has(skill.id);
      if (isUnlocked || isGranted) {
        if (equippedIds.has(skill.id) && skill.id !== equippedId) continue;
        candidates.push({ skill, locked: false, granted: !isUnlocked });
      } else if (skill.unlockLevel !== null) {
        candidates.push({ skill, locked: true, granted: false });
      }
    }

    const grantedExtras: SkillDefinition[] = [];
    for (const id of grantedIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const skill = this.worldCache.getSkill(id);
      if (!skill || skill.type !== slot.type) continue;
      if (equippedIds.has(id) && id !== equippedId) continue;
      grantedExtras.push(skill);
    }
    grantedExtras.sort((a, b) => a.sortOrder - b.sortOrder);
    for (const skill of grantedExtras) {
      candidates.push({ skill, locked: false, granted: true });
    }

    const overlay = document.createElement('div');
    overlay.className = 'charitems-skill-popup-overlay';

    let rowsHtml = '';
    if (candidates.length === 0) {
      rowsHtml = `<div class="charitems-skill-popup-empty">No other ${slot.type} skills available.</div>`;
    } else {
      rowsHtml = candidates.map(({ skill: s, locked, granted }) => {
        const isCurrent = s.id === equippedId;
        const classes = ['charitems-skill-row', s.type];
        if (locked) classes.push('locked');
        const attrs = locked
          ? `data-locked="1"`
          : isCurrent
            ? `data-skill-id="${escapeHtml(s.id)}" data-current="1"`
            : `data-skill-id="${escapeHtml(s.id)}" role="button" tabindex="0"`;
        const tagline = locked
          ? `<div class="charitems-skill-row-locklabel">Unlocks at Lv ${s.unlockLevel}</div>`
          : granted
            ? `<div class="charitems-skill-row-locklabel">Granted by equipment</div>`
            : '';
        return `<div class="${classes.join(' ')}" ${attrs}>
          <div class="charitems-skill-row-name">${escapeHtml(s.name)}${isCurrent ? ' &middot; equipped' : ''}</div>
          <div class="charitems-skill-row-meta">${renderSkillCardMeta(s)}</div>
          ${tagline}
          <div class="charitems-skill-row-desc">${escapeHtml(s.description)}</div>
        </div>`;
      }).join('');
    }

    overlay.innerHTML = `
      <div class="charitems-skill-popup">
        <div class="charitems-skill-popup-title">Slot ${slotIndex + 1} &middot; ${slot.type === 'active' ? 'Active' : 'Passive'} skill</div>
        ${equippedNow ? `<div class="charitems-skill-popup-current">Currently: <strong>${escapeHtml(equippedNow.name)}</strong></div>` : ''}
        <div class="charitems-skill-popup-list">${rowsHtml}</div>
        <div class="charitems-skill-popup-actions">
          <button class="charitems-skill-popup-btn cancel-btn">Cancel</button>
          ${equippedNow ? `<button class="charitems-skill-popup-btn danger clear-btn">Clear slot</button>` : ''}
        </div>
      </div>
    `;

    const close = () => this.closeSkillPopup();

    document.body.appendChild(overlay);
    bringToFront(overlay, close);
    this.skillPopupOpen = true;

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
        if (row.getAttribute('data-locked') === '1') return;
        const id = row.getAttribute('data-skill-id');
        const isCurrent = row.getAttribute('data-current') === '1';
        if (!id || isCurrent) return;
        this.gameClient.sendEquipSkill(id, slotIndex);
        close();
      });
    });
    wireRoleButtons(overlay);
    overlay.querySelector<HTMLElement>('.charitems-skill-row[role="button"]')?.focus({ preventScroll: true });
  }

  private closeSkillPopup(): void {
    document.querySelectorAll<HTMLElement>('.charitems-skill-popup-overlay').forEach(el => {
      release(el);
      el.remove();
    });
    this.skillPopupOpen = false;
  }

  private renderStatCard(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;
    const bonuses = computeEquipmentBonuses(char.equipment, this.itemDefs, char.level);

    const baseAtk = char.baseDamage;
    const atkLow = baseAtk + bonuses.bonusAttackMin;
    const atkHigh = baseAtk + bonuses.bonusAttackMax;
    const atkVal = atkLow === atkHigh ? `${atkLow}` : `${atkLow}-${atkHigh}`;
    const atkType = char.damageType ?? '';

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

    const stats = [
      { key: 'ATK', value: atkVal, sub: atkType },
      { key: 'DR', value: drVal, sub: '' },
      { key: 'MR', value: mrVal, sub: '' },
      { key: 'HP', value: String(char.maxHp), sub: '' },
    ];

    setHtml(this.statCardEl, stats.map(({ key, value }) => `
      <div class="charitems-stat">
        <span class="charitems-stat-value">${value}</span>
        <span class="charitems-stat-label" data-tooltip="${key}">${key}</span>
      </div>
    `).join(''));

    setHtml(this.statListEl, stats.map(({ key, value, sub }) => `
      <div class="hero-stat-row">
        <div class="hero-stat-row-head">
          <span class="hero-stat-row-name">${STAT_TOOLTIPS[key].full}${sub ? ` <span class="charitems-stat-sub">${escapeHtml(sub)}</span>` : ''}</span>
          <span class="hero-stat-row-value">${value}</span>
        </div>
        <div class="hero-stat-row-desc">${STAT_TOOLTIPS[key].desc}</div>
      </div>
    `).join(''));
  }

  private renderBannerTitle(className: string, level: number): void {
    setHtml(this.bannerTitleEl, `<span class="hero-banner-class">${escapeHtml(className)}</span><span class="hero-banner-level">Lv ${level}</span>`);
  }

  private renderMetaRow(className: string, level: number, gold: number): void {
    setHtml(this.metaRowEl, `
      <span><strong>${classIconHtml(className)} ${escapeHtml(className)}</strong></span>
      <span>Lv <strong>${level}</strong></span>
      <span>Gold <strong>${gold.toLocaleString()}</strong></span>
    `);
  }

  private renderXpBar(xp: number, xpForNextLevel: number): void {
    const numbers = `${xp.toLocaleString()} / ${xpForNextLevel.toLocaleString()}`;
    this.xpLabelEl.textContent = numbers;
    this.summaryXpLabelEl.textContent = numbers;
    const ratio = xpForNextLevel > 0 ? Math.min(1, xp / xpForNextLevel) : 0;
    this.xpFill.style.transform = `scaleX(${ratio})`;
    this.summaryXpFill.style.transform = `scaleX(${ratio})`;
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

  private showStatTooltip(anchor: HTMLElement): void {
    this.removeStatTooltip();
    const key = anchor.getAttribute('data-tooltip') ?? '';
    const info = STAT_TOOLTIPS[key];
    if (!info) return;

    const tooltip = document.createElement('div');
    tooltip.className = 'charitems-stat-tooltip';
    tooltip.innerHTML = `
      <div class="charitems-stat-tooltip-title">${escapeHtml(info.full)}</div>
      <div>${escapeHtml(info.desc)}</div>
    `;
    document.body.appendChild(tooltip);

    const rect = anchor.getBoundingClientRect();
    const maxLeft = window.innerWidth - tooltip.offsetWidth - 8;
    tooltip.style.left = `${Math.max(8, Math.min(maxLeft, rect.left + rect.width / 2 - tooltip.offsetWidth / 2))}px`;
    tooltip.style.top = `${rect.bottom + 6}px`;

    registerDismiss(tooltip, () => this.removeStatTooltip());
    const closeOnClick = () => this.removeStatTooltip();
    const armTimer = setTimeout(() => document.addEventListener('click', closeOnClick), 0);
    this.statTooltipTeardown = () => {
      clearTimeout(armTimer);
      document.removeEventListener('click', closeOnClick);
    };
  }

  private removeStatTooltip(): void {
    this.statTooltipTeardown?.();
    this.statTooltipTeardown = undefined;
    document.querySelectorAll<HTMLElement>('.charitems-stat-tooltip').forEach(el => {
      release(el);
      el.remove();
    });
  }

  private renderInventory(): void {
    const entries = Object.entries(this.lastInventory).filter(([, count]) => count > 0);
    this.inventoryCountEl.textContent = entries.length > 0 ? `(${entries.length})` : '';
    if (entries.length === 0) {
      this.setInventoryHtml(false, '<div class="items-empty">No items yet</div>');
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
      filtered.sort(([aId], [bId]) => {
        const slotDelta = slotRank(aId) - slotRank(bId);
        if (slotDelta !== 0) return slotDelta;
        return rarityRank(aId) - rarityRank(bId);
      });
    }

    if (filtered.length === 0) {
      this.setInventoryHtml(false, '<div class="items-empty">No matches</div>');
      return;
    }

    const grouped = this.sortMode === 'rarity' || this.sortMode === 'type';
    const orderKey = this.invOrderKey(grouped, filtered);
    if (orderKey === this.renderedInvOrderKey) {
      this.patchInventoryCounts(filtered);
      return;
    }
    this.setInventoryHtml(grouped, grouped
      ? this.renderGroupedInventory(filtered)
      : filtered.map(([itemId, count]) => this.renderInventoryEntry(itemId, count)).join(''));
    this.renderedInvOrderKey = orderKey;
    this.renderedInvCounts = Object.fromEntries(filtered);
  }

  /** Everything a bag cell's markup depends on except its count. */
  private invOrderKey(grouped: boolean, entries: [string, number][]): string {
    return JSON.stringify([grouped, this.sortMode, this.lastClassName, Object.keys(this.itemDefs).length, entries.map(([id]) => id)]);
  }

  /** A stack growing rewrites one badge, so looting doesn't rebuild the whole bag. */
  private patchInventoryCounts(entries: [string, number][]): void {
    const changed = new Map(entries.filter(([id, count]) => this.renderedInvCounts[id] !== count));
    if (changed.size === 0) return;
    this.inventoryGrid.querySelectorAll<HTMLElement>('.item-square[data-item]').forEach(square => {
      const count = changed.get(square.dataset.item ?? '');
      if (count !== undefined) writeItemSquareQty(square, count);
    });
    this.renderedInvCounts = Object.fromEntries(entries);
    this.invCountsPatched = true;
  }

  private setInventoryHtml(grouped: boolean, html: string): void {
    this.renderedInvOrderKey = '';
    this.inventoryGrid.classList.toggle('items-inv-grid-grouped', grouped);
    // setHtml skips markup it wrote last, which no longer matches the DOM once a badge was patched.
    if (this.invCountsPatched) setHtml(this.inventoryGrid, '');
    this.invCountsPatched = false;
    setHtml(this.inventoryGrid, html);
  }

  private canUse(def: ItemDefinition): boolean {
    return !this.lastClassName || canClassEquipItem(def, this.lastClassName);
  }

  private renderInventoryEntry(itemId: string, count: number): string {
    const def = this.itemDefs[itemId];
    if (!def) return '';
    return renderItemCell(itemId, def, {
      qty: count,
      showSlotIcon: true,
      showSetIndicator: true,
      setDefs: this.setDefs,
      dataAttrs: { item: itemId },
      unusable: !!def.equipSlot && !this.canUse(def),
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
      : ['gear', 'material'].filter(k => buckets.has(k));

    let html = '';
    for (const key of orderedKeys) {
      const items = buckets.get(key);
      if (!items) continue;
      html += `<div class="charitems-inv-group"><div class="charitems-inv-group-header">${escapeHtml(this.formatBucketLabel(key))}</div>`;
      html += `<div class="charitems-inv-group-items">${items.map(([id, count]) => this.renderInventoryEntry(id, count)).join('')}</div></div>`;
    }
    return html;
  }

  private getBucketKey(def: ItemDefinition | undefined): string {
    if (this.sortMode === 'rarity') return def?.rarity ?? 'common';
    return def?.equipSlot ? 'gear' : 'material';
  }

  private formatBucketLabel(key: string): string {
    if (key === 'material') return 'Materials';
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  private renderMailbox(): void {
    if (this.lastMailbox.length === 0) {
      setHtml(this.mailboxContainer, '');
      return;
    }
    const rows = this.lastMailbox.map(entry => {
      const def = this.itemDefs[entry.itemId];
      const color = def ? (RARITY_COLORS[def.rarity] ?? 'var(--text-1)') : 'var(--text-1)';
      const name = def?.name ?? entry.itemId;
      const fullCount = (this.lastInventory[entry.itemId] ?? 0) + entry.quantity;
      const willOverflow = fullCount > 99;
      const note = entry.returned ? '<span class="mailbox-note">(returned)</span>' : '';
      const overflow = willOverflow
        ? `<div class="mailbox-warn">Inventory full: would exceed 99 (${this.lastInventory[entry.itemId] ?? 0} + ${entry.quantity})</div>`
        : '';
      const icon = def ? renderItemIcon(entry.itemId, def, { extraClass: 'hero-row-icon' }) : '';
      return `<div class="mailbox-row">
        ${icon}
        <div class="mailbox-info">
          <div class="mailbox-from">From <strong>${escapeHtml(entry.fromUsername)}</strong> ${note}</div>
          <div class="mailbox-item">
            <span class="mailbox-item-name" style="color:${color}">${escapeHtml(name)}</span>
            <span class="mailbox-item-qty">×${entry.quantity}</span>
          </div>
          ${overflow}
        </div>
        <div class="mailbox-actions">
          <button class="social-action-btn add-friend" data-mb-action="accept" data-entry-id="${escapeHtml(entry.id)}"${willOverflow ? ' disabled' : ''}>Accept</button>
          <button class="social-action-btn remove-friend" data-mb-action="deny" data-entry-id="${escapeHtml(entry.id)}">Decline</button>
        </div>
      </div>`;
    }).join('');
    setHtml(this.mailboxContainer, `
      <div class="items-section-label">Mailbox <span class="items-section-count">(${this.lastMailbox.length})</span></div>
      <div class="mailbox-list">${rows}</div>
    `);
  }

  private renderProposedTrades(): void {
    const waiting = this.lastProposedTrades.filter(t => this.isWaitingOnMe(t));
    const sent = this.lastProposedTrades.filter(t => !this.isWaitingOnMe(t));
    this.renderTradeGroup(this.tradesContainer, 'Trades for you', waiting);
    this.renderTradeGroup(this.sentTradesContainer, 'Sent trades', sent);
  }

  private renderTradeGroup(container: HTMLElement, label: string, trades: TradeState[]): void {
    if (trades.length === 0) {
      setHtml(container, '');
      return;
    }
    const rows = trades.map(t => {
      const partner = t.initiator.username === this.lastUsername
        ? (t.target?.username ?? '')
        : t.initiator.username;
      const waitingOnMe = this.isWaitingOnMe(t);
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
          ? '<span class="trade-row-empty">nothing</span>'
          : items.map(({ itemId, quantity }) => {
              const def = this.itemDefs[itemId];
              const color = def ? (RARITY_COLORS[def.rarity] ?? 'var(--text-1)') : 'var(--text-1)';
              return `<span class="trade-row-item" style="color:${color}">${escapeHtml(def?.name ?? itemId)} ×${quantity}</span>`;
            }).join(', ');
      return `<div class="trade-row${waitingOnMe ? ' trade-row-attention' : ''}" data-trade-id="${escapeHtml(t.id)}">
        <div class="trade-row-main">
          <div class="trade-row-partner">${escapeHtml(partner)}</div>
          <div class="trade-row-status">${escapeHtml(status)}</div>
          <div class="trade-row-offers">
            <div class="trade-row-side"><span class="trade-row-label">You:</span> ${summarize(myItems)}</div>
            <div class="trade-row-side"><span class="trade-row-label">Them:</span> ${summarize(theirItems)}</div>
          </div>
        </div>
        <div class="trade-row-actions">
          <button class="social-action-btn add-friend" data-trade-id="${escapeHtml(t.id)}">Open</button>
          <button class="social-action-btn remove-friend" data-trade-cancel="${escapeHtml(t.id)}">Cancel</button>
        </div>
      </div>`;
    }).join('');
    setHtml(container, `
      <div class="items-section-label">${label} <span class="items-section-count">(${trades.length})</span></div>
      <div class="trade-list">${rows}</div>
    `);
  }

  private openModal(innerHtml: string, popupClass = ''): void {
    this.modalOverlay.innerHTML = `
      <div class="item-popup-overlay">
        <div class="item-popup${popupClass ? ` ${popupClass}` : ''}" role="dialog" aria-modal="true">${ITEM_POPUP_CLOSE_HTML}${innerHtml}</div>
      </div>
    `;
    this.modalOverlay.style.display = 'flex';
    bringToFront(this.modalOverlay, () => this.hideModal());
  }

  private onModalClick(e: Event): void {
    const target = e.target as HTMLElement;
    if (target.classList.contains('item-popup-overlay') || target === this.modalOverlay || target.closest('.item-popup-close')) {
      this.hideModal();
      return;
    }
    const equipId = target.closest('[data-picker-equip]')?.getAttribute('data-picker-equip');
    if (equipId) {
      this.gameClient.sendEquipItem(equipId);
      this.hideModal();
      return;
    }
    const itemId = target.closest('[data-picker-item]')?.getAttribute('data-picker-item');
    if (itemId) this.showItemPopup(itemId, 'inventory', undefined);
  }

  private bagItemsForSlot(slot: EquipSlot): string[] {
    const accepts = SLOT_ACCEPTS[slot] ?? [slot];
    return Object.entries(this.lastInventory)
      .filter(([id, count]) => {
        const equipSlot = this.itemDefs[id]?.equipSlot;
        return count > 0 && !!equipSlot && accepts.includes(equipSlot);
      })
      .map(([id]) => id)
      .sort((a, b) => {
        const usable = Number(this.canUse(this.itemDefs[b])) - Number(this.canUse(this.itemDefs[a]));
        if (usable !== 0) return usable;
        return (RARITY_ORDER[this.itemDefs[a].rarity] ?? 5) - (RARITY_ORDER[this.itemDefs[b].rarity] ?? 5);
      });
  }

  private showSlotPicker(slot: EquipSlot): void {
    const label = SLOT_LABELS[slot] ?? slot;
    const ids = this.bagItemsForSlot(slot);
    const skills = this.worldCache.getSkillContent().skills;
    const rows = ids.map(id => {
      const def = this.itemDefs[id];
      const color = RARITY_COLORS[def.rarity] ?? 'var(--text-1)';
      const usable = this.canUse(def);
      const effect = getItemEffectText(def, skills);
      const action = usable
        ? `<button type="button" class="pixel-btn popup-action-equip" data-picker-equip="${escapeHtml(id)}">Equip</button>`
        : `<span class="hero-picker-note">${escapeHtml((def.classRestriction ?? []).join(', '))} only</span>`;
      return `<div class="hero-picker-row ui-row${usable ? '' : ' item-cell-unusable'}" data-picker-item="${escapeHtml(id)}" role="button" tabindex="0">
        ${renderItemIcon(id, def, { extraClass: 'hero-row-icon' })}
        <div class="ui-row-main">
          <div class="ui-row-title" style="color:${color}">${escapeHtml(def.name)}</div>
          <div class="ui-row-sub">${escapeHtml(effect)}</div>
        </div>
        <div class="ui-row-actions">${action}</div>
      </div>`;
    }).join('');
    this.openModal(`
      <div class="item-popup-name">${escapeHtml(label)}</div>
      ${rows
        ? `<div class="hero-picker-list">${rows}</div>`
        : `<div class="ui-empty">Nothing in your bag fits this slot.</div>`}
    `, 'hero-slot-picker');
  }

  private showItemPopup(itemId: string, context: 'equipped' | 'inventory', equippedSlot?: EquipSlot): void {
    const def = this.itemDefs[itemId];
    if (!def) return;

    const ownedItemIds = getOwnedItemIds(this.lastInventory, this.lastEquipment);
    const equippedItemIds = getEquippedItemIds(this.lastEquipment);

    const count = this.lastInventory[itemId] ?? 0;
    let actionsHtml = '';
    if (context === 'equipped' && equippedSlot) {
      if (this.bagItemsForSlot(equippedSlot).length > 0) {
        actionsHtml += `<button class="popup-action-equip popup-action-change" data-slot="${equippedSlot}">Change</button>`;
      }
      actionsHtml += `<button class="popup-action-unequip" data-slot="${equippedSlot}">Unequip</button>`;
    } else if (context === 'inventory') {
      if (def.equipSlot) {
        const heldSlot = def.equipSlot === 'twohanded' ? 'mainhand' : def.equipSlot;
        const alreadyEquipped = this.lastEquipment[heldSlot] === itemId;
        if (alreadyEquipped) {
          actionsHtml += `<button class="popup-action-equip" data-item="${escapeHtml(itemId)}" disabled aria-disabled="true">Equipped</button>`;
        } else {
          const blocked = this.canUse(def) ? '' : ' popup-action-blocked';
          actionsHtml += `<button class="popup-action-equip${blocked}" data-item="${escapeHtml(itemId)}">Equip</button>`;
        }
      }
      actionsHtml += `<button class="popup-action-destroy danger" data-item="${escapeHtml(itemId)}" data-max="${count}">Destroy</button>`;
    }

    const extraHtml = context === 'inventory' ? renderEquipCompareBlock(def, this.lastEquipment, this.itemDefs) : '';

    this.openModal(renderItemPopupContent(def, {
      itemDefs: this.itemDefs,
      setDefs: this.setDefs,
      ownedItemIds,
      equippedItemIds,
      className: this.lastClassName || null,
      skills: this.worldCache.getSkillContent().skills,
      actionsHtml,
      extraHtml,
    }));

    this.modalOverlay.querySelector('.popup-action-change')?.addEventListener('click', () => {
      if (equippedSlot) this.showSlotPicker(equippedSlot);
    });

    const unequipBtn = this.modalOverlay.querySelector('.popup-action-unequip') as HTMLElement | null;
    if (unequipBtn) {
      unequipBtn.addEventListener('click', () => {
        const slot = unequipBtn.getAttribute('data-slot');
        if (slot) this.gameClient.sendUnequipItem(slot);
        this.hideModal();
      });
    }

    const equipBtn = this.modalOverlay.querySelector('.popup-action-equip:not(.popup-action-change)') as HTMLElement | null;
    if (equipBtn) {
      equipBtn.addEventListener('click', () => {
        const id = equipBtn.getAttribute('data-item');
        if (!id) { this.hideModal(); return; }
        const eDef = this.itemDefs[id];
        if (eDef && !this.canUse(eDef)) {
          this.pulseClassRestriction();
          return;
        }
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
        const backToItem = () => this.showItemPopup(id, 'inventory', undefined);
        if (max === 1) {
          this.showConfirmModal(
            `Destroy ${dDef?.name ?? 'item'}?`,
            'This item will be permanently lost.',
            () => { this.gameClient.sendDestroyItems(id, 1); this.hideModal(); },
            backToItem,
          );
        } else {
          this.showDestroyCountModal(id, dDef?.name ?? 'item', max, backToItem);
        }
      });
    }
  }

  private showConfirmModal(title: string, message: string, onConfirm: () => void, onCancel = () => this.hideModal()): void {
    this.openModal(`
      <div class="item-popup-name">${escapeHtml(title)}</div>
      <div class="item-popup-stats items-modal-prompt">${escapeHtml(message)}</div>
      <div class="item-popup-actions">
        <button class="items-modal-confirm danger">Destroy</button>
        <button class="items-modal-cancel">Cancel</button>
      </div>
    `);
    this.modalOverlay.querySelector('.items-modal-confirm')!.addEventListener('click', onConfirm);
    this.modalOverlay.querySelector('.items-modal-cancel')!.addEventListener('click', onCancel);
  }

  private showDestroyCountModal(itemId: string, itemName: string, max: number, onCancel: () => void): void {
    this.openModal(`
      <div class="item-popup-name">Destroy ${escapeHtml(itemName)}</div>
      <div class="item-popup-stats items-modal-prompt">How many? (1-${max})</div>
      <div class="items-modal-count-row">
        <button class="items-modal-btn items-modal-minus" aria-label="One fewer">-</button>
        <span class="items-modal-count-value">1</span>
        <button class="items-modal-btn items-modal-plus" aria-label="One more">+</button>
        <button class="items-modal-btn items-modal-max">Max</button>
      </div>
      <div class="item-popup-actions">
        <button class="items-modal-confirm danger">Destroy</button>
        <button class="items-modal-cancel">Cancel</button>
      </div>
    `);

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
    this.modalOverlay.querySelector('.items-modal-cancel')!.addEventListener('click', onCancel);
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

  /** Restarting needs a forced reflow, so repeated Equip presses pulse again. */
  private pulseClassRestriction(): void {
    const row = this.modalOverlay.querySelector('[data-class-restriction]') as HTMLElement | null;
    if (!row) return;
    row.classList.remove('class-restriction-pulse');
    void row.offsetWidth;
    row.classList.add('class-restriction-pulse');
  }
}
