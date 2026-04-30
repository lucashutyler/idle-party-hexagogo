import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { ShopDefinition, ItemDefinition, SetDefinition } from '@idle-party-rpg/shared';
import { getUnequippedCount, listUnequippedEntries } from '@idle-party-rpg/shared';
import { renderItemIcon, escapeHtml } from './ItemIcon';
import { renderItemPopupContent } from './ItemPopup';

export class ShopPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private mode: 'buy' | 'sell' = 'buy';
  /** View context — what's open inside the shop popup right now. */
  private view: { kind: 'grid' } | { kind: 'buy'; itemId: string; price: number; qty: number } | { kind: 'sell'; itemId: string; qty: number } = { kind: 'grid' };
  private notice: string | null = null;
  private noticeTimer: number | null = null;
  private unsubscribeState: (() => void) | null = null;

  constructor(gameClient: GameClient) {
    this.gameClient = gameClient;
    this.overlay = document.createElement('div');
    this.overlay.className = 'shop-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    document.body.appendChild(this.overlay);
  }

  show(state: ServerStateMessage): void {
    const shop = state.shopDefinition;
    if (!shop) return;
    this.mode = 'buy';
    this.view = { kind: 'grid' };
    this.notice = null;
    this.renderCurrentView(state);
    this.overlay.style.display = 'flex';

    // Subscribe to state updates so the popup reflects post-action state (sold qty, gold, etc.)
    this.unsubscribeState?.();
    this.unsubscribeState = this.gameClient.subscribe(s => {
      if (this.overlay.style.display === 'none') return;
      if (!s.shopDefinition) { this.hide(); return; }
      this.renderCurrentView(s);
    });
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
    this.unsubscribeState?.();
    this.unsubscribeState = null;
    if (this.noticeTimer !== null) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.notice = null;
  }

  private renderCurrentView(state: ServerStateMessage): void {
    const shop = state.shopDefinition;
    if (!shop) return;
    if (this.view.kind === 'grid') {
      this.renderGrid(state, shop);
    } else if (this.view.kind === 'buy') {
      this.renderBuyDetail(this.view.itemId, this.view.price, state.itemDefinitions ?? {}, state.setDefinitions ?? {}, state, shop);
    } else if (this.view.kind === 'sell') {
      // Recompute max from current inventory minus equipped
      const max = this.computeSellable(state, this.view.itemId);
      if (max <= 0) {
        this.view = { kind: 'grid' };
        this.renderGrid(state, shop);
        return;
      }
      this.renderSellDetail(this.view.itemId, max, state.itemDefinitions ?? {}, state.setDefinitions ?? {}, state, shop);
    }
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
      const state = this.gameClient.lastState;
      if (state && this.overlay.style.display !== 'none') this.renderCurrentView(state);
    }, 3500);
  }

  /** Render the main grid view (buy or sell item list). */
  private renderGrid(state: ServerStateMessage, shop: ShopDefinition): void {
    const char = state.character;
    if (!char) return;
    const itemDefs = state.itemDefinitions ?? {};
    const setDefs = state.setDefinitions ?? {};

    const buyActive = this.mode === 'buy' ? ' active' : '';
    const sellActive = this.mode === 'sell' ? ' active' : '';

    let itemsHtml = '';
    if (this.mode === 'buy') {
      itemsHtml = this.renderBuyItems(shop, itemDefs, setDefs);
    } else {
      itemsHtml = this.renderSellItems(char.inventory, char.equipment, itemDefs, setDefs);
    }

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
        </div>
        <div class="shop-items-grid">${itemsHtml}</div>
        <div style="margin-top:12px;text-align:center;">
          <button class="item-popup-btn item-popup-btn-secondary shop-close-btn">Close</button>
        </div>
      </div>
    `;

    // Wire toggle
    for (const btn of this.overlay.querySelectorAll('.shop-toggle-btn')) {
      btn.addEventListener('click', () => {
        this.mode = (btn as HTMLElement).dataset.mode as 'buy' | 'sell';
        this.view = { kind: 'grid' };
        this.renderGrid(state, shop);
      });
    }

    // Wire item clicks
    for (const el of this.overlay.querySelectorAll('.shop-item-square')) {
      el.addEventListener('click', () => {
        const itemId = (el as HTMLElement).dataset.itemId;
        if (!itemId) return;
        if (this.mode === 'buy') {
          const price = parseInt((el as HTMLElement).dataset.price ?? '0', 10);
          this.view = { kind: 'buy', itemId, price, qty: 1 };
          this.renderBuyDetail(itemId, price, itemDefs, setDefs, state, shop);
        } else {
          const max = parseInt((el as HTMLElement).dataset.qty ?? '1', 10);
          this.view = { kind: 'sell', itemId, qty: 1 };
          this.renderSellDetail(itemId, max, itemDefs, setDefs, state, shop);
        }
      });
    }

    this.overlay.querySelector('.shop-close-btn')?.addEventListener('click', () => this.hide());
  }

  private renderBuyItems(shop: ShopDefinition, itemDefs: Record<string, ItemDefinition>, _setDefs: Record<string, SetDefinition>): string {
    return shop.inventory.map(si => {
      const def = itemDefs[si.itemId];
      if (!def) {
        const name = si.itemId;
        return `<div class="item-square shop-item-square" data-item-id="${si.itemId}" data-price="${si.price}" style="background:#e8e8e840;" data-tooltip="${escapeHtml(name)}">
          <span class="item-square-initials">${name.split(' ').map(w => w[0]).join('').slice(0, 2)}</span>
          <span class="shop-item-price">${si.price}g</span>
        </div>`;
      }
      const html = renderItemIcon(si.itemId, def, {
        extraClass: 'shop-item-square',
        dataAttrs: { 'item-id': si.itemId, price: String(si.price) },
      });
      return html.replace(/<\/div>$/, `<span class="shop-item-price">${si.price}g</span></div>`);
    }).join('');
  }

  private renderSellItems(
    inventory: Record<string, number>,
    _equipment: Record<string, string | null>,
    itemDefs: Record<string, ItemDefinition>,
    _setDefs: Record<string, SetDefinition>,
  ): string {
    // Sellable = every unequipped copy. `inventory` already excludes equipped copies
    // (`equipItem` removes from inventory on equip), so do NOT subtract equipped counts.
    const entries = listUnequippedEntries(inventory);

    if (entries.length === 0) {
      return '<div style="color:#888;text-align:center;padding:16px;">No items to sell</div>';
    }

    return entries.map(([itemId, qty]) => {
      const def = itemDefs[itemId];
      if (!def) {
        return `<div class="item-square shop-item-square" data-item-id="${itemId}" data-qty="${qty}" style="background:#e8e8e840;" data-tooltip="${escapeHtml(itemId)}">
          <span class="item-square-initials">${itemId.split(' ').map(w => w[0]).join('').slice(0, 2)}</span>
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

  /** Render a buy detail view inside the shop popup container. */
  private renderBuyDetail(
    itemId: string, price: number,
    itemDefs: Record<string, ItemDefinition>,
    setDefs: Record<string, SetDefinition>,
    state: ServerStateMessage, shop: ShopDefinition,
  ): void {
    const def = itemDefs[itemId];
    if (!def) return;

    const maxAffordable = Math.max(1, Math.floor((state.character?.gold ?? 0) / price));
    if (this.view.kind !== 'buy') this.view = { kind: 'buy', itemId, price, qty: 1 };
    let qty = Math.min(this.view.qty, maxAffordable);
    this.view.qty = qty;
    const noticeHtml = this.notice ? `<div class="shop-notice">${escapeHtml(this.notice)}</div>` : '';

    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs,
      className: state.character?.className ?? null,
    });

    this.overlay.innerHTML = `
      <div class="shop-popup shop-detail-view">
        <div class="shop-header">
          <span class="shop-title">${escapeHtml(shop.name)}</span>
          <span class="shop-gold">${state.character?.gold ?? 0} gold</span>
        </div>
        ${noticeHtml}
        <div class="shop-detail-content">${popupContent}</div>
        <div class="shop-detail-controls">
          <div class="shop-qty-row">
            <button class="shop-qty-btn shop-qty-minus">-</button>
            <span class="shop-qty-value">${qty}</span>
            <button class="shop-qty-btn shop-qty-plus">+</button>
            <button class="shop-qty-btn shop-qty-all">Max</button>
          </div>
          <div class="shop-detail-total">Total: ${qty * price} gold</div>
          <div class="shop-detail-actions">
            <button class="item-popup-btn item-popup-btn-primary shop-action-confirm">Buy</button>
            <button class="item-popup-btn item-popup-btn-secondary shop-detail-back">Back</button>
          </div>
        </div>
      </div>
    `;

    const updateQty = () => {
      if (this.view.kind === 'buy') this.view.qty = qty;
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
      qty = Math.min(maxAffordable, qty + 1);
      updateQty();
    });
    this.overlay.querySelector('.shop-qty-all')?.addEventListener('click', () => {
      qty = maxAffordable;
      updateQty();
    });
    this.overlay.querySelector('.shop-action-confirm')?.addEventListener('click', () => {
      for (let i = 0; i < qty; i++) {
        this.gameClient.sendShopBuy(itemId);
      }
      const noun = qty === 1 ? def.name : `${qty} ${def.name}`;
      this.setNotice(`You bought ${noun} for ${qty * price} gold.`);
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
  }

  /** Render a sell detail view inside the shop popup container. */
  private renderSellDetail(
    itemId: string, max: number,
    itemDefs: Record<string, ItemDefinition>,
    setDefs: Record<string, SetDefinition>,
    state: ServerStateMessage, shop: ShopDefinition,
  ): void {
    const def = itemDefs[itemId];
    if (!def) return;
    const value = def.value ?? 1;

    if (this.view.kind !== 'sell') this.view = { kind: 'sell', itemId, qty: 1 };
    let qty = Math.min(this.view.qty, max);
    this.view.qty = qty;
    const noticeHtml = this.notice ? `<div class="shop-notice">${escapeHtml(this.notice)}</div>` : '';

    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs,
      className: state.character?.className ?? null,
    });

    this.overlay.innerHTML = `
      <div class="shop-popup shop-detail-view">
        <div class="shop-header">
          <span class="shop-title">${escapeHtml(shop.name)}</span>
          <span class="shop-gold">${state.character?.gold ?? 0} gold</span>
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
      if (this.view.kind === 'sell') this.view.qty = qty;
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
      const itemName = def.name;
      const noun = qty === 1 ? itemName : `${qty} ${itemName}`;
      this.setNotice(`You sold ${noun} for ${qty * value} gold.`);
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
      this.view = { kind: 'grid' };
      this.renderGrid(state, shop);
    });
  }

}
