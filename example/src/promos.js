const PROMOS = { SPRING15: { code: 'SPRING15', percentOff: 15, expires: '2099-01-01' } };

function findActive(code) {
  const promo = PROMOS[code];
  if (!promo || new Date(promo.expires) < new Date()) {
    throw new Error(`Promo code ${code} is not valid`);
  }
  return promo;
}

module.exports = { findActive };
