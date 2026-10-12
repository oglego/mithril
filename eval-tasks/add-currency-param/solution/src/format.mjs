const SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };

export function formatPrice(amount, currency = "USD") {
  const symbol = SYMBOLS[currency];
  if (symbol === undefined) throw new Error(`Unsupported currency: ${currency}`);
  return symbol + amount.toFixed(2);
}
