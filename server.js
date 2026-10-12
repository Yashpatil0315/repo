// Shutterhouse payment backend: Personal UPI QR (college project)
// Run: npm install && cp .env.example .env && npm start
// Then open: http://localhost:3000
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const fs      = require('fs');

// ---- UPI config (set in .env) ----
const UPI_ID   = process.env.UPI_ID   || 'yashpatil0315-1@okhdfcbank';
const UPI_NAME = process.env.UPI_NAME || 'Shutterhouse';

const catalog = Object.fromEntries(require('./catalog.json').map(p => [p.id, p]));
const COUPONS = {
  SHUTTER10:  { type: 'pct',  v: 10, max: 5000, min: 0 },
  FIRSTFRAME: { type: 'flat', v: 500, min: 10000 }
};
const FREE_SHIP = 2000, SHIP_FEE = 5;

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

// Serve the HTML frontend from this same folder
app.use(express.static(__dirname));

// ---- tiny file "database" (swap for Postgres/MongoDB in production) ----
const DB     = './orders.json';
const readDb  = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return {}; } };
const writeDb = d  => fs.writeFileSync(DB, JSON.stringify(d, null, 2));

// ---- price is ALWAYS computed server-side, never trusted from the browser ----
function priceCart(items, couponCode) {
  if (!Array.isArray(items) || !items.length) throw new Error('Cart is empty');
  let sub = 0;
  const lines = items.map(({ id, qty }) => {
    const p = catalog[id]; qty = Number(qty);
    if (!p || !Number.isInteger(qty) || qty < 1 || qty > p.stock)
      throw new Error(`Invalid item or quantity for id: ${id}`);
    sub += p.price * qty;
    return { id, qty, price: p.price };
  });
  const c = COUPONS[couponCode]; let disc = 0;
  if (c && sub >= c.min)
    disc = c.type === 'pct' ? Math.min(Math.round(sub * c.v / 100), c.max) : c.v;
  const after = sub - disc, ship = after < FREE_SHIP ? SHIP_FEE : 0;
  return { lines, total: after + ship, discount: disc };
}

// ---- Build a UPI deep-link URI (works with PhonePe, GPay, Paytm etc.) ----
function buildUpiUri(amount, orderId) {
  const note = encodeURIComponent('Shutterhouse Order ' + orderId);
  const name = encodeURIComponent(UPI_NAME);
  return `upi://pay?pa=${UPI_ID}&pn=${name}&am=${amount.toFixed(2)}&cu=INR&tn=${note}`;
}

// ---- Build a scannable QR image URL using the free qrserver.com API ----
function buildQrUrl(upiUri) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&ecc=M&data=${encodeURIComponent(upiUri)}`;
}

// -----------------------------------------------------------------------
// 1) Create an order → returns UPI URI + QR code image URL
// -----------------------------------------------------------------------
app.post('/api/orders', (req, res) => {
  try {
    const { items, coupon, customer } = req.body;
    const { lines, total, discount } = priceCart(items, coupon);

    const orderId = 'SH-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const upiUri  = buildUpiUri(total, orderId);
    const qrUrl   = buildQrUrl(upiUri);

    const db = readDb();
    db[orderId] = {
      status:    'awaiting_payment',
      lines,
      total,
      discount,
      customer:  customer || {},
      upiId:     UPI_ID,
      createdAt: new Date().toISOString()
    };
    writeDb(db);

    res.json({
      orderId,
      amount:  total,        // in INR (rupees, not paise)
      upiId:   UPI_ID,
      upiUri,                // use for deep-link button ("Pay with UPI app")
      qrUrl,                 // use as <img src="qrUrl"> for scan-to-pay
    });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// -----------------------------------------------------------------------
// 2) Customer submits their UTR after paying (12-digit UPI ref number)
//    The order is marked "pending_verification" until you confirm manually.
// -----------------------------------------------------------------------
app.post('/api/verify', (req, res) => {
  try {
    const { orderId, utrNumber } = req.body;
    if (!orderId || !utrNumber)
      return res.status(400).json({ ok: false, error: 'orderId and utrNumber are required' });

    const utr = String(utrNumber).trim();
    if (!/^\d{12}$/.test(utr))
      return res.status(400).json({ ok: false, error: 'UTR must be a 12-digit number' });

    const db = readDb();
    if (!db[orderId])
      return res.status(404).json({ ok: false, error: 'Order not found' });
    if (db[orderId].status === 'paid')
      return res.json({ ok: true, message: 'Order already confirmed' });

    db[orderId].status          = 'pending_verification';
    db[orderId].utrNumber       = utr;
    db[orderId].utrSubmittedAt  = new Date().toISOString();
    writeDb(db);

    res.json({
      ok: true,
      message: 'Payment reference received! Your order will be confirmed once we verify the payment.'
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -----------------------------------------------------------------------
// 3) Get order status (frontend can poll this)
// -----------------------------------------------------------------------
app.get('/api/orders/:id', (req, res) => {
  const db    = readDb();
  const order = db[req.params.id];
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({
    orderId:   req.params.id,
    status:    order.status,
    total:     order.total,
    createdAt: order.createdAt
  });
});

// -----------------------------------------------------------------------
// 4) Admin endpoint: manually confirm payment after checking UTR on UPI app
//    POST /api/admin/confirm  { "secret": "...", "orderId": "SH-..." }
// -----------------------------------------------------------------------
app.post('/api/admin/confirm', (req, res) => {
  const { secret, orderId } = req.body;
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Forbidden' });

  const db = readDb();
  if (!db[orderId]) return res.status(404).json({ error: 'Order not found' });

  db[orderId].status      = 'paid';
  db[orderId].confirmedAt = new Date().toISOString();
  writeDb(db);

  console.log(`✅ Order ${orderId} marked as PAID by admin`);
  res.json({ ok: true, message: `Order ${orderId} confirmed as paid.` });
});

// -----------------------------------------------------------------------
app.listen(process.env.PORT || 3001, () =>
  console.log(`✅ Shutterhouse Payments API → http://localhost:${process.env.PORT || 3001}`)
);
