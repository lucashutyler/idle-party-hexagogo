import { OFFLINE_NOTICE, type GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { ShopDefinition, ItemDefinition, HenchmanOffer, HiredHenchman } from '@idle-party-rpg/shared';
import {
  getUnequippedCount,
  listUnequippedEntries,
  getOwnedItemIds,
  getEquippedItemIds,
  canClassEquipItem,
  MAX_PARTY_SIZE,
  MAX_HENCHMEN_PER_PARTY,
  MAX_STACK,
} from '@idle-party-rpg/shared';
import { renderItemIcon, escapeHtml } from './ItemIcon';
import { renderItemPopupContent } from './ItemPopup';
import { renderEquipCompareBlock } from './EquipCompare';
import { renderTrackedImg } from './assets';
import { deferWhilePressed } from './render';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';

type ShopView =
  | { kind: 'grid' }
  | { kind: 'buy'; itemId: string; price: number; qty: number }
  | { kind: 'sell'; itemId: string; qty: number }
  | { kind: 'replace'; henchmanId: string };

/** Buy requests still awaiting answers. A success shows up as the item's stack growing; a refusal as an error. */
interface PendingBuy {
  itemId: string;
  name: string;
  price: number;
  qty: number;
  startCount: number;
  refused: number;
  refusal: string | null;
}

export class ShopPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  /** `hire` only exists while the room's shop offers henchmen. */
  private mode: 'buy' | 'sell' | 'hire' = 'buy';
  private view: ShopView = { kind: 'grid' };
  private notice: string | null = null;
  private noticeTimer: number | null = null;
  private unsubscribeState: (() => void) | null = null;
  /** Henchman id of a hire awaiting a server answer, so only its refusal shows. */
  private pendingHireId: string | null = null;
  private pendingBuy: PendingBuy | null = null;
  private unsubscribeError: (() => void) | null = null;
  /** Inputs of the most recent render; a push with the same inputs only patches gold in place. */
  private lastRenderKey = '';
  /** Which list the current DOM shows, so a re-render of the same list keeps its scroll position. */
  private renderedPlace = '';

  constructor(gameClient: GameClient, worldCache: WorldCache) {
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.overlay = document.createElement('div');
    this.overlay.className = 'shop-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    document.body.appendChild(this.overlay);
    wireFocusOnInteract(this.overlay);
  }

  show(state: ServerStateMessage): void {
    const shop = state.shopDefinition;
    if (!shop) return;
    const hasOffers = (state.henchmanOffers?.length ?? 0) > 0;
    this.mode = shop.inventory.length === 0 && hasOffers ? 'hire' : 'buy';
    this.view = { kind: 'grid' };
    this.notice = null;
    this.lastRenderKey = '';
    this.renderCurrentView(state);
    this.overlay.style.display = 'flex';
    bringToFront(this.overlay);

    this.unsubscribeState?.();
    this.unsubscribeState = this.gameClient.subscribe(() => {
      // A state tick means the hire landed — a refusal arrives as an error first.
      this.pendingHireId = null;
      this.settleBuy();
      deferWhilePressed(this.overlay, () => this.refresh());
    });

    this.unsubscribeError?.();
    this.unsubscribeError = this.gameClient.onServerError((message, code) => {
      if (!this.isOpen() || code) return;
      if (this.pendingHireId) {
        this.pendingHireId = null;
        this.setNotice(message);
      } else if (this.pendingBuy) {
        this.pendingBuy.refused++;
        if (!this.pendingBuy.refusal) this.pendingBuy.refusal = message;
        this.settleBuy();
      } else {
        return;
      }
      deferWhilePressed(this.overlay, () => this.refresh());
    });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    release(this.overlay);
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
    this.lastRenderKey = '';
    this.renderedPlace = '';
    this.pendingHireId = null;
    this.pendingBuy = null;
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.notice = null;
  }

  private static hiredHenchmen(state: ServerStateMessage): HiredHenchman[] {
    return state.social?.party?.henchmen ?? [];
  }

  /** Whether one more henchman fits without anyone leaving. */
  private static hasRoomForHire(state: ServerStateMessage): boolean {
    const hired = ShopPopup.hiredHenchmen(state).length;
    const members = state.social?.party?.members.length ?? 1;
    return hired < MAX_HENCHMEN_PER_PARTY && members + hired < MAX_PARTY_SIZE;
  }

  /** "Knight only" when `className` can't equip this gear; null when it can, or when it isn't gear at all. */
  private static restrictionLabel(def: ItemDefinition, className: string): string | null {
    if (!def.equipSlot || canClassEquipItem(def, className)) return null;
    return `${(def.classRestriction ?? []).join(' / ')} only`;
  }

  private static affordableCount(gold: number, price: number): number {
    return price > 0 ? Math.min(MAX_STACK, Math.floor(gold / price)) : MAX_STACK;
  }

  private isOpen(): boolean {
    return this.overlay.style.display !== 'none';
  }

  private refresh(): void {
    if (!this.isOpen()) return;
    const state = this.gameClient.lastState;
    if (!state?.shopDefinition) {
      this.hide();
      return;
    }
    this.renderCurrentView(state);
  }

  /** The only way a click re-renders: drop the render key and paint from the latest state. */
  private rerender(): void {
    this.lastRenderKey = '';
    this.refresh();
  }

  private renderCurrentView(state: ServerStateMessage): void {
    const shop = state.shopDefinition;
    if (!shop) return;

    const offers = state.henchmanOffers ?? [];
    if (this.mode === 'hire' && offers.length === 0) this.mode = 'buy';
    this.dropStaleView(state, offers);

    const key = this.renderKey(state, shop, offers);
    if (key === this.lastRenderKey) {
      this.patchGold(state);
      return;
    }
    this.lastRenderKey = key;

    const place = this.place();
    const scroll = place === this.renderedPlace ? this.readScroll() : null;

    const view = this.view;
    if (view.kind === 'grid') {
      this.renderGrid(state, shop);
    } else if (view.kind === 'buy') {
      this.renderBuyDetail(view, state, shop);
    } else if (view.kind === 'sell') {
      this.renderSellDetail(view, this.computeSellable(state, view.itemId), state, shop);
    } else {
      this.renderReplaceConfirm(view.henchmanId, state);
    }

    this.renderedPlace = place;
    if (scroll) this.writeScroll(scroll);
  }

  /** Falls back to the grid when the open detail no longer applies to the latest state. */
  private dropStaleView(state: ServerStateMessage, offers: HenchmanOffer[]): void {
    const view = this.view;
    const itemDefs = state.itemDefinitions ?? {};
    const stale =
      (view.kind === 'buy' && !itemDefs[view.itemId])
      || (view.kind === 'sell' && (!itemDefs[view.itemId] || this.computeSellable(state, view.itemId) <= 0))
      || (view.kind === 'replace'
        && (ShopPopup.hiredHenchmen(state).length === 0 || !offers.some(o => o.henchmanId === view.henchmanId)));
    if (stale) this.view = { kind: 'grid' };
  }

  private renderKey(state: ServerStateMessage, shop: ShopDefinition, offers: HenchmanOffer[]): string {
    const char = state.character;
    const view = this.view;
    return JSON.stringify({
      view: view.kind === 'buy' ? { kind: view.kind, itemId: view.itemId, price: view.price }
        : view.kind === 'sell' ? { kind: view.kind, itemId: view.itemId }
          : view,
      mode: this.mode,
      notice: this.notice,
      shopId: shop.id,
      shopInv: shop.inventory,
      offers,
      hired: ShopPopup.hiredHenchmen(state).map(h => `${h.instanceId}:${h.name ?? ''}`),
      room: ShopPopup.hasRoomForHire(state),
      cls: char?.className ?? '',
      afford: view.kind === 'buy' ? ShopPopup.affordableCount(char?.gold ?? 0, view.price) : null,
      eq: view.kind === 'buy' ? char?.equipment ?? {} : null,
      inv: this.mode === 'sell' || view.kind === 'sell' ? char?.inventory ?? {} : null,
      sets: view.kind === 'buy' || view.kind === 'sell' ? ShopPopup.setProgress(view.itemId, state) : null,
    });
  }

  /** Owned and equipped pieces of the sets `itemId` belongs to: all a detail view shows of the rest of the inventory. */
  private static setProgress(itemId: string, state: ServerStateMessage): { owned: string[]; equipped: string[] } {
    const char = state.character;
    if (!char) return { owned: [], equipped: [] };
    const pieces = new Set(Object.values(state.setDefinitions ?? {})
      .filter(set => set.itemIds.includes(itemId))
      .flatMap(set => set.itemIds));
    const inSet = (ids: Set<string>) => [...ids].filter(id => pieces.has(id)).sort();
    return {
      owned: inSet(getOwnedItemIds(char.inventory, char.equipment)),
      equipped: inSet(getEquippedItemIds(char.equipment)),
    };
  }

  /** Gold changes on most victories; only its text and the grid's price colors depend on it. */
  private patchGold(state: ServerStateMessage): void {
    const gold = state.character?.gold ?? 0;
    const goldEl = this.overlay.querySelector('.shop-gold');
    if (goldEl) goldEl.textContent = `${gold} gold`;
    for (const square of this.overlay.querySelectorAll<HTMLElement>('.shop-items-grid [data-price]')) {
      square.querySelector('.shop-item-price')?.classList.toggle('unaffordable', Number(square.dataset.price) > gold);
    }
  }

  private place(): string {
    const view = this.view;
    const itemId = view.kind === 'buy' || view.kind === 'sell' ? view.itemId : '';
    return `${this.mode}|${view.kind}|${itemId}`;
  }

  private readScroll(): { list: number; popup: number } {
    return {
      list: this.overlay.querySelector('.shop-items-grid, .shop-hire-list')?.scrollTop ?? 0,
      popup: this.overlay.querySelector('.shop-popup')?.scrollTop ?? 0,
    };
  }

  private writeScroll(scroll: { list: number; popup: number }): void {
    const list = this.overlay.querySelector('.shop-items-grid, .shop-hire-list');
    if (list) list.scrollTop = scroll.list;
    const popup = this.overlay.querySelector('.shop-popup');
    if (popup) popup.scrollTop = scroll.popup;
  }

  private computeSellable(state: ServerStateMessage, itemId: string): number {
    const char = state.character;
    if (!char) return 0;
    return getUnequippedCount(itemId, char.inventory);
  }

  private setNotice(message: string): void {
    this.notice = message;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.notice = null;
      this.noticeTimer = null;
      deferWhilePressed(this.overlay, () => this.refresh());
    }, 3500);
  }

  /** Reports the pending buy once every request is answered — never before the server has said yes. */
  private settleBuy(): void {
    const pending = this.pendingBuy;
    const char = this.gameClient.lastState?.character;
    if (!pending || !char) return;
    const bought = Math.max(0, (char.inventory[pending.itemId] ?? 0) - pending.startCount);
    if (bought + pending.refused < pending.qty) return;
    this.pendingBuy = null;
    const noun = bought === 1 ? pending.name : `${bought} ${pending.name}`;
    const success = bought > 0 ? `You bought ${noun} for ${bought * pending.price} gold.` : '';
    if (!pending.refusal) this.setNotice(success);
    else this.setNotice(success ? `${pending.refusal}. ${success}` : pending.refusal);
  }

  /** Render the main grid view (buy / sell item list, or the hire list). */
  private renderGrid(state: ServerStateMessage, shop: ShopDefinition): void {
    const char = state.character;
    if (!char) return;
    const itemDefs = state.itemDefinitions ?? {};
    const offers = state.henchmanOffers ?? [];

    const buyActive = this.mode === 'buy' ? ' active' : '';
    const sellActive = this.mode === 'sell' ? ' active' : '';
    const hireActive = this.mode === 'hire' ? ' active' : '';

    const listHtml = this.mode === 'hire'
      ? `<div class="shop-hire-list" style="max-height:45vh;overflow-y:auto;">${this.renderHireList(offers, state)}</div>`
      : `<div class="shop-items-grid">${this.mode === 'buy'
          ? this.renderBuyItems(shop, itemDefs, char.className, char.gold)
          : this.renderSellItems(char.inventory, itemDefs)}</div>`;

    const hireToggle = offers.length > 0
      ? `<button class="shop-toggle-btn${hireActive}" data-mode="hire">Hire</button>`
      : '';

    const noticeHtml = this.notice ? `<div class="shop-notice">${escapeHtml(this.notice)}</div>` : '';

    this.overlay.innerHTML = `
      <div class="shop-popup">
        <div class="shop-header">
          <span class="shop-title">${escapeHtml(shop.name)}</span>
          <span class="shop-gold">${char.gold} gold</span>
        </div>
        ${noticeHtml}
        <div class="shop-toggle">
          <button class="shop-toggle-btn${buyActive}" data-mode="buy">Buy</button>
          <button class="shop-toggle-btn${sellActive}" data-mode="sell">Sell</button>
          ${hireToggle}
        </div>
        ${listHtml}
        <div style="margin-top:12px;text-align:center;">
          <button class="item-popup-btn item-popup-btn-secondary shop-close-btn">Close</button>
        </div>
      </div>
    `;

    for (const btn of this.overlay.querySelectorAll<HTMLElement>('.shop-toggle-btn')) {
      btn.addEventListener('click', () => {
        this.mode = btn.dataset.mode as 'buy' | 'sell' | 'hire';
        this.view = { kind: 'grid' };
        this.rerender();
      });
    }

    for (const btn of this.overlay.querySelectorAll<HTMLElement>('.shop-hire-btn')) {
      btn.addEventListener('click', () => {
        const henchmanId = btn.dataset.henchmanId;
        if (!henchmanId) return;
        if (!ShopPopup.hasRoomForHire(state) && ShopPopup.hiredHenchmen(state).length > 0) {
          this.view = { kind: 'replace', henchmanId };
          this.rerender();
          return;
        }
        this.pendingHireId = henchmanId;
        this.gameClient.sendHireHenchman(henchmanId);
      });
    }

    for (const el of this.overlay.querySelectorAll<HTMLElement>('.shop-item-square')) {
      el.addEventListener('click', () => {
        const itemId = el.dataset.itemId;
        if (!itemId) return;
        this.view = this.mode === 'buy'
          ? { kind: 'buy', itemId, price: parseInt(el.dataset.price ?? '0', 10), qty: 1 }
          : { kind: 'sell', itemId, qty: 1 };
        this.rerender();
      });
    }

    this.overlay.querySelector('.shop-close-btn')?.addEventListener('click', () => this.hide());
  }

  private renderBuyItems(shop: ShopDefinition, itemDefs: Record<string, ItemDefinition>, className: string, gold: number): string {
    return shop.inventory.map(si => {
      const price = `<span class="shop-item-price${si.price > gold ? ' unaffordable' : ''}">${si.price}g</span>`;
      const def = itemDefs[si.itemId];
      if (!def) {
        const name = si.itemId;
        return `<div class="item-square shop-item-square" data-item-id="${escapeHtml(si.itemId)}" data-price="${si.price}" style="background:#e8e8e840;" data-tooltip="${escapeHtml(name)}">
          <span class="item-square-initials">${escapeHtml(name.split(' ').map(w => w[0]).join('').slice(0, 2))}</span>
          ${price}
        </div>`;
      }
      const restriction = ShopPopup.restrictionLabel(def, className);
      const html = renderItemIcon(si.itemId, def, {
        extraClass: 'shop-item-square',
        dataAttrs: { 'item-id': si.itemId, price: String(si.price) },
        tooltip: restriction ? `${def.name} (${restriction})` : undefined,
      });
      const badge = restriction ? '<span class="shop-item-unusable" aria-hidden="true"></span>' : '';
      return html.replace(/<\/div>$/, `${badge}${price}</div>`);
    }).join('');
  }

  private renderSellItems(inventory: Record<string, number>, itemDefs: Record<string, ItemDefinition>): string {
    // Sellable = every unequipped copy. `inventory` already excludes equipped copies
    // (`equipItem` removes from inventory on equip), so do NOT subtract equipped counts.
    const entries = listUnequippedEntries(inventory);

    if (entries.length === 0) {
      return '<div style="color:#888;text-align:center;padding:16px;">No items to sell</div>';
    }

    return entries.map(([itemId, qty]) => {
      const def = itemDefs[itemId];
      if (!def) {
        return `<div class="item-square shop-item-square" data-item-id="${escapeHtml(itemId)}" data-qty="${qty}" style="background:#e8e8e840;" data-tooltip="${escapeHtml(itemId)}">
          <span class="item-square-initials">${escapeHtml(itemId.split(' ').map(w => w[0]).join('').slice(0, 2))}</span>
          <span class="shop-item-price">1g</span>
        </div>`;
      }
      const value = def.value ?? 1;
      const html = renderItemIcon(itemId, def, {
        qty,
        extraClass: 'shop-item-square',
        dataAttrs: { 'item-id': itemId, qty: String(qty) },
      });
      return html.replace(/<\/div>$/, `<span class="shop-item-price">${value}g</span></div>`);
    }).join('');
  }

  /** Ask which hired henchman makes room for a new one. */
  private renderReplaceConfirm(henchmanId: string, state: ServerStateMessage): void {
    const offer = (state.henchmanOffers ?? []).find(o => o.henchmanId === henchmanId);
    if (!offer) return;

    const choices = ShopPopup.hiredHenchmen(state)
      .filter(h => h.henchmanId !== henchmanId)
      .map(h => `
        <button class="item-popup-btn item-popup-btn-primary shop-replace-confirm" data-instance-id="${escapeHtml(h.instanceId)}" style="display:block;width:100%;margin:4px 0;">
          Replace ${escapeHtml(h.name ?? 'henchman')}${h.level !== undefined ? ` · Lv ${h.level}` : ''}
        </button>`)
      .join('');

    this.overlay.innerHTML = `
      <div class="shop-popup">
        <div class="shop-header"><span class="shop-title">Make room for ${escapeHtml(offer.name)}?</span></div>
        <div class="shop-hire-row" style="display:flex;align-items:center;gap:8px;padding:8px 0;text-align:left;">
          <div class="shop-hire-portrait" style="position:relative;flex:0 0 auto;width:44px;height:44px;border-radius:4px;overflow:hidden;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
            ${ShopPopup.henchmanPortrait(offer)}
          </div>
          <div class="shop-hire-info" style="flex:1;min-width:0;">
            <div class="shop-hire-name" style="font-size:15px;">${escapeHtml(offer.name)}</div>
            <div class="shop-hire-stats" style="font-size:12px;color:#ccc;">Lv ${offer.level} · ${offer.maxHp} HP · ${offer.baseDamage} DMG</div>
          </div>
        </div>
        <div style="font-size:13px;color:#ccc;line-height:1.5;padding:4px 0 8px;">
          Your party has no room. Choose who leaves; ${escapeHtml(offer.name)} takes their place in your formation.
        </div>
        ${choices}
        <div style="display:flex;gap:8px;justify-content:center;margin-top:8px;">
          <button class="item-popup-btn item-popup-btn-secondary shop-replace-cancel">Cancel</button>
        </div>
      </div>
    `;

    for (const btn of this.overlay.querySelectorAll<HTMLElement>('.shop-replace-confirm')) {
      btn.addEventListener('click', () => {
        const instanceId = btn.dataset.instanceId;
        if (!instanceId) return;
        this.pendingHireId = henchmanId;
        this.gameClient.sendHireHenchman(henchmanId, instanceId);
        this.view = { kind: 'grid' };
        this.rerender();
      });
    }
    this.overlay.querySelector('.shop-replace-cancel')?.addEventListener('click', () => {
      this.view = { kind: 'grid' };
      this.rerender();
    });
  }

  /** Render the hire list. The combat archetype (className) is deliberately not shown. */
  private renderHireList(offers: HenchmanOffer[], state: ServerStateMessage): string {
    const hired = ShopPopup.hiredHenchmen(state);
    const hiredIds = new Set(hired.map(h => h.henchmanId));
    const hasRoom = ShopPopup.hasRoomForHire(state);
    const partyFull = !hasRoom && hired.length === 0;
    if (offers.length === 0) {
      return '<div style="color:#888;text-align:center;padding:16px;">Nobody here is looking for work</div>';
    }

    return offers.map(o => {
      const description = o.description?.trim();
      const descriptionHtml = description
        ? `<div class="shop-hire-desc" style="font-size:12px;color:#999;line-height:1.4;">${escapeHtml(description)}</div>`
        : '';
      return `
        <div class="shop-hire-row" style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.1);text-align:left;">
          <div class="shop-hire-portrait" style="position:relative;flex:0 0 auto;width:44px;height:44px;border-radius:4px;overflow:hidden;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;">
            ${ShopPopup.henchmanPortrait(o)}
          </div>
          <div class="shop-hire-info" style="flex:1;min-width:0;">
            <div class="shop-hire-name" style="font-size:15px;">${escapeHtml(o.name)}</div>
            ${descriptionHtml}
            <div class="shop-hire-stats" style="font-size:12px;color:#ccc;">Lv ${o.level} · ${o.maxHp} HP · ${o.baseDamage} DMG</div>
          </div>
          ${hiredIds.has(o.henchmanId)
            ? '<button class="item-popup-btn item-popup-btn-secondary" disabled>In party</button>'
            : partyFull
              ? '<button class="item-popup-btn item-popup-btn-secondary" disabled title="Your party is full of players">Party full</button>'
              : `<button class="item-popup-btn item-popup-btn-primary shop-hire-btn" data-henchman-id="${escapeHtml(o.henchmanId)}">${hasRoom ? 'Hire' : 'Replace'}</button>`}
        </div>
      `;
    }).join('');
  }

  /** Photo layered over an emoji fallback, so a missing or broken image still renders a portrait. */
  private static henchmanPortrait(offer: HenchmanOffer): string {
    const emoji = `<span class="shop-hire-emoji" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:24px;">${escapeHtml(offer.emoji)}</span>`;
    if (!offer.artworkUrl) return emoji;
    return emoji + renderTrackedImg(offer.artworkUrl, { className: 'shop-hire-img', alt: offer.name, lazy: true });
  }

  /** Render a buy detail view inside the shop popup container. */
  private renderBuyDetail(
    view: { itemId: string; price: number; qty: number },
    state: ServerStateMessage,
    shop: ShopDefinition,
  ): void {
    const char = state.character;
    const itemDefs = state.itemDefinitions ?? {};
    const def = itemDefs[view.itemId];
    if (!char || !def) return;
    const { itemId, price } = view;

    const affordable = ShopPopup.affordableCount(char.gold, price);
    const canAfford = affordable >= 1;
    const maxQty = Math.max(1, affordable);
    let qty = Math.min(view.qty, maxQty);
    view.qty = qty;
    const noticeHtml = this.notice ? `<div class="shop-notice">${escapeHtml(this.notice)}</div>` : '';

    const restriction = ShopPopup.restrictionLabel(def, char.className);
    const unusableNote = restriction
      ? `<div class="shop-unusable-note">${escapeHtml(restriction)} — you can still buy it.</div>`
      : '';
    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs: state.setDefinitions ?? {},
      ownedItemIds: getOwnedItemIds(char.inventory, char.equipment),
      equippedItemIds: getEquippedItemIds(char.equipment),
      className: char.className,
      skills: this.worldCache.getSkillContent().skills,
      extraHtml: unusableNote + renderEquipCompareBlock(def, char.equipment, itemDefs),
    });
    const disabled = canAfford ? '' : ' disabled';

    this.overlay.innerHTML = `
      <div class="shop-popup shop-detail-view">
        <div class="shop-header">
          <span class="shop-title">${escapeHtml(shop.name)}</span>
          <span class="shop-gold">${char.gold} gold</span>
        </div>
        ${noticeHtml}
        <div class="shop-detail-content">${popupContent}</div>
        <div class="shop-detail-controls">
          <div class="shop-qty-row">
            <button class="shop-qty-btn shop-qty-minus"${disabled}>-</button>
            <span class="shop-qty-value">${qty}</span>
            <button class="shop-qty-btn shop-qty-plus"${disabled}>+</button>
            <button class="shop-qty-btn shop-qty-all"${disabled}>Max</button>
          </div>
          <div class="shop-detail-total">Total: ${qty * price} gold</div>
          <div class="shop-detail-actions">
            <button class="item-popup-btn item-popup-btn-primary shop-action-confirm"${disabled}>${canAfford ? 'Buy' : 'Not enough gold'}</button>
            <button class="item-popup-btn item-popup-btn-secondary shop-detail-back">Back</button>
          </div>
        </div>
      </div>
    `;

    const updateQty = () => {
      view.qty = qty;
      const qtyEl = this.overlay.querySelector('.shop-qty-value');
      const totalEl = this.overlay.querySelector('.shop-detail-total');
      if (qtyEl) qtyEl.textContent = String(qty);
      if (totalEl) totalEl.textContent = `Total: ${qty * price} gold`;
    };

    this.overlay.querySelector('.shop-qty-minus')?.addEventListener('click', () => {
      qty = Math.max(1, qty - 1);
      updateQty();
    });
    this.overlay.querySelector('.shop-qty-plus')?.addEventListener('click', () => {
      qty = Math.min(maxQty, qty + 1);
      updateQty();
    });
    this.overlay.querySelector('.shop-qty-all')?.addEventListener('click', () => {
      qty = maxQty;
      updateQty();
    });
    this.overlay.querySelector('.shop-action-confirm')?.addEventListener('click', () => {
      if (!canAfford) return;
      const inventory = this.gameClient.lastState?.character?.inventory ?? char.inventory;
      const startCount = inventory[itemId] ?? 0;
      if (!this.gameClient.sendShopBuy(itemId)) {
        this.setNotice(OFFLINE_NOTICE);
        this.rerender();
        return;
      }
      this.pendingBuy = { itemId, name: def.name, price, qty, startCount, refused: 0, refusal: null };
      for (let i = 1; i < qty; i++) {
        this.gameClient.sendShopBuy(itemId);
      }
      this.view = { kind: 'grid' };
      this.rerender();
    });
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
      this.view = { kind: 'grid' };
      this.rerender();
    });
  }

  /** Render a sell detail view inside the shop popup container. */
  private renderSellDetail(
    view: { itemId: string; qty: number },
    max: number,
    state: ServerStateMessage,
    shop: ShopDefinition,
  ): void {
    const char = state.character;
    const itemDefs = state.itemDefinitions ?? {};
    const def = itemDefs[view.itemId];
    if (!char || !def) return;
    const { itemId } = view;
    const value = def.value ?? 1;

    let qty = Math.min(view.qty, max);
    view.qty = qty;
    const noticeHtml = this.notice ? `<div class="shop-notice">${escapeHtml(this.notice)}</div>` : '';

    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs: state.setDefinitions ?? {},
      ownedItemIds: getOwnedItemIds(char.inventory, char.equipment),
      equippedItemIds: getEquippedItemIds(char.equipment),
      className: char.className,
      skills: this.worldCache.getSkillContent().skills,
    });

    this.overlay.innerHTML = `
      <div class="shop-popup shop-detail-view">
        <div class="shop-header">
          <span class="shop-title">${escapeHtml(shop.name)}</span>
          <span class="shop-gold">${char.gold} gold</span>
        </div>
        ${noticeHtml}
        <div class="shop-detail-content">${popupContent}</div>
        <div class="shop-detail-controls">
          <div class="shop-qty-row">
            <button class="shop-qty-btn shop-qty-minus">-</button>
            <span class="shop-qty-value">${qty}</span>
            <button class="shop-qty-btn shop-qty-plus">+</button>
            <button class="shop-qty-btn shop-qty-all">All</button>
          </div>
          <div class="shop-detail-total">Available: ${max} · Total: ${qty * value} gold</div>
          <div class="shop-detail-actions">
            <button class="item-popup-btn item-popup-btn-primary shop-action-confirm">Sell</button>
            <button class="item-popup-btn item-popup-btn-secondary shop-detail-back">Back</button>
          </div>
        </div>
      </div>
    `;

    const updateQty = () => {
      view.qty = qty;
      const qtyEl = this.overlay.querySelector('.shop-qty-value');
      const totalEl = this.overlay.querySelector('.shop-detail-total');
      if (qtyEl) qtyEl.textContent = String(qty);
      if (totalEl) totalEl.textContent = `Available: ${max} · Total: ${qty * value} gold`;
    };

    this.overlay.querySelector('.shop-qty-minus')?.addEventListener('click', () => {
      qty = Math.max(1, qty - 1);
      updateQty();
    });
    this.overlay.querySelector('.shop-qty-plus')?.addEventListener('click', () => {
      qty = Math.min(max, qty + 1);
      updateQty();
    });
    this.overlay.querySelector('.shop-qty-all')?.addEventListener('click', () => {
      qty = max;
      updateQty();
    });
    this.overlay.querySelector('.shop-action-confirm')?.addEventListener('click', () => {
      this.gameClient.sendShopSell(itemId, qty);
      const noun = qty === 1 ? def.name : `${qty} ${def.name}`;
      this.setNotice(`You sold ${noun} for ${qty * value} gold.`);
      this.view = { kind: 'grid' };
      this.rerender();
    });
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
      this.view = { kind: 'grid' };
      this.rerender();
    });
  }
}
