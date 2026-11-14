const CARTS = {
  c_8841: {
    id: 'c_8841',
    customer: { tier: 'STANDARD' },
    items: [
      { sku: 'mug', price: 20, qty: 2 },
      { sku: 'kettle', price: 80, qty: 1 }
    ]
  }
};

function getById(id) {
  return CARTS[id];
}

module.exports = { getById };
