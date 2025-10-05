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
const morgan = require('morgan');
const path = require('path');
const fileUpload = require('express-fileupload');
const { xlsxParse } = require('./xlsx');

const dbBasePath = process.env.DB_BASE_PATH || __dirname;
const db = new DatabaseSync(path.join(dbBasePath, 'vinetracker.db'), {
  open: false,
});
const app = express();
app.use(morgan('combined'));
app.use((req, res, next) => {
  if (!req.ip?.endsWith('172.30.32.2') && req.ip !== '::1' && req.ip !== '127.0.0.1') {
    const error = `Forbidden ingress IP '${req.ip}'. Must call from 172.30.32.2, 127.0.0.1, or ::1 (localhost)`;
    console.error(error);
    res.status(403).json({ error });
  } else {
    next();
  }
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'home.html'));
});
app.get('/report', (req, res) => {
  res.sendFile(path.join(__dirname, 'report.html'));
});
app.get('/orders', async (req, res) => {
  try {
    const orders = await getOrders();
    res.json({ orders });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
    return;
  }
});
app.get('/report-data/:year', async (req, res) => {
  const strYear = req.params.year;
  const year = parseInt(strYear);
  if (isNaN(year) || year < 2000 || year > 3000) {
    const error = `Invalid year '${strYear}'`;
  }
  const ordersForYear = getOrders().filter(o => o.orderedAt.getFullYear() === year && !o.cancelled);
  const totalEtv = ordersForYear.reduce((sum, o) => sum + o.etv, 0);
  const totalAdjustedEtv = ordersForYear.reduce((sum, o) => sum + (o.etvFactor !== null ? o.etv * o.etvFactor : o.etv), 0);
  
  res.json({
    year,
    totalEtv,
    totalAdjustedEtv,
    orderCount: ordersForYear.length,
    monthly: getMonthlyBreakdown(ordersForYear)
  });
});

function getMonthlyBreakdown(orders) {
  const monthly = [];
  for (let month = 0; month < 12; month++) {
    const ordersForMonth = orders.filter(o => o.orderedAt.getMonth() === month);
    const totalEtv = ordersForMonth.reduce((sum, o) => sum + o.etv, 0);
    const totalAdjustedEtv = ordersForMonth.reduce((sum, o) => sum + (o.etvFactor !== null ? o.etv * o.etvFactor : o.etv), 0);
    monthly.push({
      month: month + 1,
      orderCount: ordersForMonth.length,
      totalEtv,
      totalAdjustedEtv
    });
  }
  return monthly;
}

app.post('/orders/:number/etv', express.json(), async (req, res) => {
  const number = req.params.number;
  const { etvFactor } = req.body;
  if (typeof etvFactor !== 'number' || etvFactor < 0 || etvFactor > 1) {
    const error = 'Invalid etvFactor. Must be a number between 0 and 1';
    console.error(error);
    res.status(400).json({ error });
    return;
  }
  try {
    setETVFactorForOrder(number, etvFactor);
    res.json({ success: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
    return;
  }
});

app.post('/upload', fileUpload(), async (req, res) => {
  if (!req.files || !req.files.file) {
    const error = 'Missing file upload';
    console.error(error);
    res.status(400).json({ error });
    return;
  }
  if (Array.isArray(req.files.file)) {
    const error = 'Multiple files uploaded. Please upload only one file at a time.';
    console.error(error);
    res.status(400).json({ error });
    return;
  }
  if (req.files.file.mimetype !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const error = `Invalid file type '${req.files.file.mimetype}'. Please upload an Excel .xlsx file.`;
    console.error(error);
    res.status(400).json({ error });
    return;
  }
  const lines = await xlsxParse(req.files.file.data);
  let inserted = 0;
  let failed = 0;
  const cancellations = [];
  for (const line of lines) {
    if (!line) return;
    const { number, asin, product, type, orderedAtStr, deliveredAtStr, etvStr, etvFactor } = line;
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
      etvFactor: etvFactor ?? null
    });
    inserted++;
  }

  // Handle cancellations
  for (const number of cancellations) {
    const stmt = db.prepare(`UPDATE orders SET cancelled = 1 WHERE number = ?`);
    stmt.run(number);
  }

  console.log(`Upload complete. Inserted: ${inserted}, Failed: ${failed}, Cancellations: ${cancellations.length}`);
  res.json({ inserted, failed, cancellations: cancellations.length });
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
    etvFactor REAL,
    cancelled INTEGER DEFAULT 0
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
 * @prop {number | null} etvFactor Residual percent of ETV at transfer to personal use
 * @prop {boolean} [cancelled] Whether the order was cancelled
 */

/**
 * Fetch orders from SQL
 * @returns {Order[]} List of orders
 */
function getOrders() {
  const orders = db.prepare('SELECT * FROM orders ORDER BY orderedAt ASC').all();
  return orders.map(toOrder);
}

/**
 * Insert an order into the database if it doesn't already exist
 * @param {Order} order
 */
function maybeInsertOrder(order) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO orders (number, asin, product, orderedAt, deliveredAt, etv, etvFactor, cancelled)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)`);
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
    etvFactor: row.etvFactor,
    cancelled: row.cancelled === 1,
  };
}
