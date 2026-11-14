const { buildQuote } = require('./checkoutService');

// POST /api/checkout/quote
function quote(req, res) {
  const result = buildQuote(req.body);
  res.json(result);
}

module.exports = { quote };
