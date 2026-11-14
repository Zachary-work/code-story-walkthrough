const carts = require('./carts');
const promos = require('./promos');
const { price } = require('./pricingEngine');

function buildQuote(request) {
  const cart = carts.getById(request.cartId);
  let ctx = { cart, customer: cart.customer };
  if (request.promoCode) {
    ctx = { ...ctx, promo: promos.findActive(request.promoCode) };
  }
  return price(ctx);
}

module.exports = { buildQuote };
