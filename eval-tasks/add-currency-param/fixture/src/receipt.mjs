import { formatPrice } from "./format.mjs";

export function receipt(items) {
  return items.map((item) => `${item.name}: ${formatPrice(item.price)}`).join("\n");
}
