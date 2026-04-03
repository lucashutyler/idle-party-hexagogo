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
}
