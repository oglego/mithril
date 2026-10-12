import { load, equal, ensure, pass } from "../_lib.mjs";

const { formatPrice } = await load("src/format.mjs");
equal(formatPrice(5), "$5.00", "default currency");
equal(formatPrice(5, "USD"), "$5.00", "explicit USD");
equal(formatPrice(5, "EUR"), "€5.00", "EUR");
equal(formatPrice(1234.5, "GBP"), "£1234.50", "GBP");
let threw = false;
try {
  formatPrice(5, "XYZ");
} catch {
  threw = true;
}
ensure(threw, "an unsupported currency must throw");

const { receipt } = await load("src/receipt.mjs");
equal(receipt([{ name: "tea", price: 2.5 }]), "tea: $2.50", "existing caller");
pass();
