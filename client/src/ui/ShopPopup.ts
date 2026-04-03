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
    this.render(state, shop);
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.overlay.innerHTML = '';
  }

  private render(state: ServerStateMessage, shop: ShopDefinition): void {
    const char = state.character;
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
        this.render(state, shop);
      });
    }

    // Wire item clicks
    for (const el of this.overlay.querySelectorAll('.shop-item-square')) {
      el.addEventListener('click', () => {
        const itemId = (el as HTMLElement).dataset.itemId;
        if (!itemId) return;
        if (this.mode === 'buy') {
          const price = parseInt((el as HTMLElement).dataset.price ?? '0', 10);
          this.showBuyPopup(itemId, price, itemDefs, setDefs, state, shop);
        } else {
          const max = parseInt((el as HTMLElement).dataset.qty ?? '1', 10);
          this.showSellPopup(itemId, max, itemDefs, setDefs, state, shop);
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
      // renderItemIcon produces the outer div; we need to inject shop-specific data attrs and the price overlay.
      // Use renderItemIcon with extra class and data attrs, then append the price span.
      const html = renderItemIcon(si.itemId, def, {
        extraClass: 'shop-item-square',
        dataAttrs: { 'item-id': si.itemId, price: String(si.price) },
      });
      // Inject price badge before closing </div>
      return html.replace(/<\/div>$/, `<span class="shop-item-price">${si.price}g</span></div>`);
    }).join('');
  }

  private renderSellItems(
    inventory: Record<string, number>,
    equipment: Record<string, string | null>,
    itemDefs: Record<string, ItemDefinition>,
    _setDefs: Record<string, SetDefinition>,
  ): string {
    // Only show unequipped inventory items
    const equippedIds = new Set(Object.values(equipment).filter(Boolean));
    const entries = Object.entries(inventory).filter(([id, count]) => count > 0 && !equippedIds.has(id));

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
      // Inject price badge before closing </div>
      return html.replace(/<\/div>$/, `<span class="shop-item-price">${value}g</span></div>`);
    }).join('');
  }

  private showBuyPopup(
    itemId: string, price: number,
    itemDefs: Record<string, ItemDefinition>,
    setDefs: Record<string, SetDefinition>,
    state: ServerStateMessage, shop: ShopDefinition,
  ): void {
    const def = itemDefs[itemId];
    if (!def) return;

    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs,
      actionsHtml: `
        <div style="margin-top:12px;font-size:14px;color:#ffd700;">Price: ${price} gold</div>
        <button class="item-popup-btn item-popup-btn-primary shop-buy-confirm">Buy</button>
        <button class="item-popup-btn item-popup-btn-secondary shop-detail-back">Back</button>
      `,
    });

    this.overlay.innerHTML = `<div class="item-popup">${popupContent}</div>`;

    this.overlay.querySelector('.shop-buy-confirm')?.addEventListener('click', () => {
      this.gameClient.sendShopBuy(itemId);
      this.render(state, shop);
    });
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
      this.render(state, shop);
    });
  }

  private showSellPopup(
    itemId: string, max: number,
    itemDefs: Record<string, ItemDefinition>,
    setDefs: Record<string, SetDefinition>,
    state: ServerStateMessage, shop: ShopDefinition,
  ): void {
    const def = itemDefs[itemId];
    if (!def) return;
    const value = def.value ?? 1;

    let qty = 1;

    const renderQty = () => {
      const qtyEl = this.overlay.querySelector('.shop-qty-value');
      const totalEl = this.overlay.querySelector('.shop-sell-total');
      if (qtyEl) qtyEl.textContent = String(qty);
      if (totalEl) totalEl.textContent = `Total: ${qty * value} gold`;
    };

    const popupContent = renderItemPopupContent(def, {
      itemDefs,
      setDefs,
      actionsHtml: `
        <div class="shop-sell-controls">
          <button class="shop-qty-btn shop-qty-minus">-</button>
          <span class="shop-qty-value">1</span>
          <button class="shop-qty-btn shop-qty-plus">+</button>
          <button class="shop-qty-btn shop-qty-all">All</button>
        </div>
        <div class="shop-sell-total" style="color:#ffd700;margin-top:4px;">Total: ${value} gold</div>
        <button class="item-popup-btn item-popup-btn-primary shop-sell-confirm">Sell</button>
        <button class="item-popup-btn item-popup-btn-secondary shop-detail-back">Back</button>
      `,
    });

    this.overlay.innerHTML = `<div class="item-popup">${popupContent}</div>`;

    this.overlay.querySelector('.shop-qty-minus')?.addEventListener('click', () => {
      qty = Math.max(1, qty - 1);
      renderQty();
    });
    this.overlay.querySelector('.shop-qty-plus')?.addEventListener('click', () => {
      qty = Math.min(max, qty + 1);
      renderQty();
    });
    this.overlay.querySelector('.shop-qty-all')?.addEventListener('click', () => {
      qty = max;
      renderQty();
    });
    this.overlay.querySelector('.shop-sell-confirm')?.addEventListener('click', () => {
      this.gameClient.sendShopSell(itemId, qty);
      this.render(state, shop);
    });
    this.overlay.querySelector('.shop-detail-back')?.addEventListener('click', () => {
      this.render(state, shop);
    });
  }

}
