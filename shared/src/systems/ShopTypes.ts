// --- Types ---

export interface ShopItem {
  itemId: string;
  /** Gold cost to buy this item. */
  price: number;
}

export interface ShopDefinition {
  id: string;
  name: string;
  /** Items available for purchase in this shop. */
  inventory: ShopItem[];
  /** Henchmen offered for hire, by `HenchmanDefinition.id`. Hires are free — no price pairs with these. */
  henchmanIds?: string[];
}

/** What a room's shop offers, without its stock — enough to label explored rooms on the map. */
export interface ShopSummary {
  id: string;
  name: string;
  sellsItems: boolean;
  hiresHenchmen: boolean;
}

export function toShopSummary(shop: ShopDefinition): ShopSummary {
  return {
    id: shop.id,
    name: shop.name,
    sellsItems: (shop.inventory?.length ?? 0) > 0,
    hiresHenchmen: (shop.henchmanIds?.length ?? 0) > 0,
  };
}
