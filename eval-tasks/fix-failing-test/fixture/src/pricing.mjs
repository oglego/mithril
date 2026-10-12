// discount is a fraction, e.g. 0.2 means 20% off.
export function applyDiscount(price, discount) {
  return price * discount;
}

export function total(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function totalWithDiscount(items, discount) {
  return applyDiscount(total(items), discount);
}
