import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import type { ShopDefinition, ItemDefinition, SetDefinition } from '@idle-party-rpg/shared';
import { renderItemIcon, escapeHtml } from './ItemIcon';
import { renderItemPopupContent } from './ItemPopup';

export class ShopPopup {
  private overlay: HTMLElement;
  private gameClient: GameClient;
  private mode: 'buy' | 'sell' = 'buy';

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
    this.renderGrid(state, shop);
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
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

    this.overlay.innerHTML = `
      <div class="shop-popup">
        <div class="shop-header">
          <span class="shop-title">${escapeHtml(shop.name)}</span>
          <span class="shop-gold">${char.gold} gold</span>
        </div>
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
          this.renderBuyDetail(itemId, price, itemDefs, setDefs, state, shop);
        } else {
          const max = parseInt((el as HTMLElement).dataset.qty ?? '1', 10);
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
        return `<div class="item-square shop-item-square" data-item-id="${si.itemId}" data-price="${si.price}" style="background:#e8e8e840;" title="${escapeHtml(name)}">
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
    equipment: Record<string, string | null>,
    itemDefs: Record<string, ItemDefinition>,
    _setDefs: Record<string, SetDefinition>,
  ): string {
    // Count how many of each item is equipped (an item can occupy multiple slots)
    const equippedCounts: Record<string, number> = {};
    for (const itemId of Object.values(equipment)) {
      if (itemId) equippedCounts[itemId] = (equippedCounts[itemId] ?? 0) + 1;
    }

    // Show all inventory items, but reduce sellable qty by equipped count
    const entries: [string, number][] = [];
    for (const [id, count] of Object.entries(inventory)) {
      const sellable = count - (equippedCounts[id] ?? 0);
      if (sellable > 0) entries.push([id, sellable]);
    }

    if (entries.length === 0) {
      return '<div style="color:#888;text-align:center;padding:16px;">No items to sell</div>';
    }

    return entries.map(([itemId, qty]) => {
      const def = itemDefs[itemId];
      if (!def) {
        return `<div class="item-square shop-item-square" data-item-id="${itemId}" data-qty="${qty}" style="background:#e8e8e840;" title="${escapeHtml(itemId)}">
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

    let qty = 1;
    const maxAffordable = Math.max(1, Math.floor((state.character?.gold ?? 0) / price));

    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs,
    });

    this.overlay.innerHTML = `
      <div class="shop-popup shop-detail-view">
        <div class="shop-header">
          <span class="shop-title">${escapeHtml(shop.name)}</span>
          <span class="shop-gold">${state.character?.gold ?? 0} gold</span>
        </div>
        <div class="shop-detail-content">${popupContent}</div>
        <div class="shop-detail-controls">
          <div class="shop-qty-row">
            <button class="shop-qty-btn shop-qty-minus">-</button>
            <span class="shop-qty-value">1</span>
            <button class="shop-qty-btn shop-qty-plus">+</button>
            <button class="shop-qty-btn shop-qty-all">Max</button>
          </div>
          <div class="shop-detail-total">Total: ${price} gold</div>
          <div class="shop-detail-actions">
            <button class="item-popup-btn item-popup-btn-primary shop-action-confirm">Buy</button>
            <button class="item-popup-btn item-popup-btn-secondary shop-detail-back">Back</button>
          </div>
        </div>
      </div>
    `;

    const updateQty = () => {
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
      this.renderGrid(state, shop);
    });
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
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

    let qty = 1;

    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs,
    });

    this.overlay.innerHTML = `
      <div class="shop-popup shop-detail-view">
        <div class="shop-header">
          <span class="shop-title">${escapeHtml(shop.name)}</span>
          <span class="shop-gold">${state.character?.gold ?? 0} gold</span>
        </div>
        <div class="shop-detail-content">${popupContent}</div>
        <div class="shop-detail-controls">
          <div class="shop-qty-row">
            <button class="shop-qty-btn shop-qty-minus">-</button>
            <span class="shop-qty-value">1</span>
            <button class="shop-qty-btn shop-qty-plus">+</button>
            <button class="shop-qty-btn shop-qty-all">All</button>
          </div>
          <div class="shop-detail-total">Total: ${value} gold</div>
          <div class="shop-detail-actions">
            <button class="item-popup-btn item-popup-btn-primary shop-action-confirm">Sell</button>
            <button class="item-popup-btn item-popup-btn-secondary shop-detail-back">Back</button>
          </div>
        </div>
      </div>
    `;

    const updateQty = () => {
      const qtyEl = this.overlay.querySelector('.shop-qty-value');
      const totalEl = this.overlay.querySelector('.shop-detail-total');
      if (qtyEl) qtyEl.textContent = String(qty);
      if (totalEl) totalEl.textContent = `Total: ${qty * value} gold`;
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
      this.renderGrid(state, shop);
    });
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
      this.renderGrid(state, shop);
    });
  }

}
