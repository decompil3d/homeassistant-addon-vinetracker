const Graceful = require('node-graceful').default;
Graceful.captureExceptions = true;
Graceful.captureRejections = true;
Graceful.exitOnDouble = false;

Graceful.on('exit', (signal, details) => {
  if (details) {
    console.error('Exit reason:', details);
  }
});

const { DatabaseSync } = require('node:sqlite')

const express = require('express');
const fs = require('fs');
const handlebars = require('handlebars');
const path = require('path');

const templateSrc = fs.readFileSync(path.join(__dirname, 'home.hbs'), 'utf8');
const buildHome = handlebars.compile(templateSrc);

const db = new DatabaseSync(path.join(__dirname, 'vinetracker.db'), {
  open: false,
});
const app = express();
app.use((req, res, next) => {
  if (!req.ip?.endsWith('172.30.32.2') && req.ip !== '::1' && req.ip !== '127.0.0.1') {
    const error = `Forbidden ingress IP '${req.ip}'. Must call from 172.30.32.2, 127.0.0.1, or ::1 (localhost)`;
    console.error(error);
    res.status(403).json({ error });
  } else {
    next();
  }
});
app.get('/', async (req, res) => {
  try {
    const orders = await getOrders();
    // TODO: build out template
    const html = buildHome({
      orders
    });
    res.send(html);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
    return;
  }
});
app.post('/upload', express.text({ type: 'text/csv', limit: '1mb' }), async (req, res) => {
  if (!req.is('text/csv')) {
    const error = 'Invalid content type. Must be text/csv';
    console.error(error);
    res.status(400).json({ error });
    return;
  }
  const lines = req.body.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  let inserted = 0;
  let failed = 0;
  const cancellations = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 5) {
      console.warn(`Skipping invalid line: ${line}`);
      failed++;
      continue;
    }
    const [number, asin, product, type, orderedAtStr, deliveredAtStr, /* cancelledDate */, etvStr] = parts;
    if (type === 'CANCELLATION') {
      cancellations.push(number);
    }
    maybeInsertOrder({
      number,
      asin,
      product,
      orderedAt: new Date(orderedAtStr),
      deliveredAt: deliveredAtStr ? new Date(deliveredAtStr) : undefined,
      etv: parseFloat(etvStr) || 0,
      etvFactor: 0.2
    });
    inserted++;
  }
});

console.log('Starting VineTracker addon...');
app.listen(8099, () => {
  console.log('VineTracker addon is running on port 8099');

  Graceful.on('exit', function () {
    db.close();
  });

  db.open();
  db.exec(`CREATE TABLE IF NOT EXISTS orders (
    number TEXT PRIMARY KEY,
    asin TEXT,
    product TEXT,
    orderedAt TEXT,
    deliveredAt TEXT,
    etv REAL,
    etvFactor REAL
  )`);
});

/**
 * @typedef {Object} Order
 * @prop {string} number Order number
 * @prop {string} asin Product ASIN
 * @prop {string} product Product name
 * @prop {Date} orderedAt Date the order was placed
 * @prop {Date} [deliveredAt] Date the order was delivered
 * @prop {number} etv Original ETV
 * @prop {number} etvFactor Residual percent of ETV at transfer to personal use
 */

/**
 * Fetch orders from SQL
 * @returns {Order[]} List of orders
 */
function getOrders() {
  const orders = db.prepare('SELECT * FROM orders').all();
  return orders.map(toOrder);
}

/**
 * Insert an order into the database if it doesn't already exist
 * @param {Order} order
 */
function maybeInsertOrder(order) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO orders (number, asin, product, orderedAt, deliveredAt, etv, etvFactor)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  stmt.run(order.number,
    order.asin,
    order.product,
    order.orderedAt.toISOString(),
    order.deliveredAt?.toISOString() ?? null,
    order.etv,
    order.etvFactor);
}

/**
 * Set the ETV factor for an order
 * @param {string} number
 * @param {number} etvFactor
 */
function setETVFactorForOrder(number, etvFactor) {
  const stmt = db.prepare(`UPDATE orders SET etvFactor = ? WHERE number = ?`);
  stmt.run(etvFactor, number);
}

/**
 * Convert a SQL row to an Order
 * @param {Record<string, any>} row
 */
function toOrder(row) {
  return {
    number: row.number,
    asin: row.asin,
    product: row.product,
    orderedAt: new Date(row.orderedAt),
    deliveredAt: new Date(row.deliveredAt),
    etv: row.etv,
    etvFactor: row.etvFactor
  };
}
