const { applyDiscount } = require('./discountCalculator');

const TAX_RATE = 0.08;

function price(ctx) {
  const subtotal = ctx.cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  // Order matters: discounts first, then tax on what is left.
  const discount = applyDiscount(ctx, subtotal);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * TAX_RATE * 100) / 100;
  return { subtotal, discount, tax, total: taxable + tax };
}

module.exports = { price };
