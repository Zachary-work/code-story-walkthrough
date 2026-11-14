const LOYALTY_RATES = { STANDARD: 0, GOLD: 0.05 };

function applyDiscount(ctx, subtotal) {
  let discount = subtotal * LOYALTY_RATES[ctx.customer.tier];
  const promo = ctx.promo;
  if (promo) {
    discount += subtotal * (promo.percentOff / 100);
  }
  return Math.min(discount, subtotal);
}

module.exports = { applyDiscount };
