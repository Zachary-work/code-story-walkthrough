const test = require('node:test');
const assert = require('node:assert');
const { buildQuote } = require('../src/checkoutService');
const { applyDiscount } = require('../src/discountCalculator');
const { findActive } = require('../src/promos');

test('applies promo code', () => {
  const quote = buildQuote({ cartId: 'c_8841', promoCode: 'SPRING15' });
  assert.deepStrictEqual(quote, { subtotal: 120, discount: 18, tax: 8.16, total: 110.16 });
});

test('promo percent off', () => {
  const ctx = { customer: { tier: 'STANDARD' }, promo: { code: 'SPRING15', percentOff: 15 } };
  assert.strictEqual(applyDiscount(ctx, 120), 18);
});

test('rejects unknown code', () => {
  assert.throws(() => findActive('NOPE'), /Promo code NOPE is not valid/);
});
