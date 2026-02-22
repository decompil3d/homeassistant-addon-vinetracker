const Graceful = require('node-graceful').default;
Graceful.captureExceptions = true;
Graceful.captureRejections = true;
Graceful.exitOnDouble = false;

Graceful.on('exit', (signal, details) => {
  if (details) {
    console.error('Exit reason:', details);
  }
});

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite')

const express = require('express');
const Handlebars = require('handlebars');
const morgan = require('morgan');
const path = require('path');
const fileUpload = require('express-fileupload');
const { xlsxParse } = require('./xlsx');

const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'numeric',
  day: 'numeric',
  year: '2-digit'
});
/**
 * Render a date
 * @param {Date} dt Date object
 * @returns {string} rendered date
 */
function renderDate(dt) {
  if (!dt) return '';
  return shortDateFormatter.format(dt);
}
Handlebars.registerHelper('date', renderDate);

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});
/**
 * Render a currency number
 * @param {number} num Number to render
 * @returns {string} rendered as currency
 */
function renderCurrency(num) {
  return currencyFormatter.format(num);
}
Handlebars.registerHelper('currency', renderCurrency);

/**
 * Multiply two numbers
 * @param {number} num1 First factor
 * @param {number | null} num2 Second factor, defaults to 1
 * @returns {string} Product of the factors, rendered as currency
 */
function multiply(num1, num2) {
  return renderCurrency(num1 * (num2 ?? 1));
}
Handlebars.registerHelper('multiply', multiply);

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
/** @type {ReturnType<Handlebars.compile>} */
let homeTemplate;
/** @type {ReturnType<Handlebars.compile>} */
let overviewTemplate;
/** @type {ReturnType<Handlebars.compile>} */
let taxReportTemplate;
app.get('/', (req, res) => {
  if (!homeTemplate) {
    const homeHtml = fs.readFileSync(path.join(__dirname, 'home.hbs'), 'utf-8');
    homeTemplate = Handlebars.compile(homeHtml);
  }
  res.send(homeTemplate({
    ingress: req.get('x-ingress-path') || '',
    lowReasons: [
      'Damaged/defective',
      'Disposed of',
      'Consumed for review',
      'Did not receive'
    ],
    highReasons: [
      'Brand name'
    ]
  }));
});
app.get('/overview', (req, res) => {
  if (!overviewTemplate) {
    const overviewHtml = fs.readFileSync(path.join(__dirname, 'overview.hbs'), 'utf-8');
    overviewTemplate = Handlebars.compile(overviewHtml);
  }
  res.send(overviewTemplate({ ingress: req.get('x-ingress-path') || '' }));
});
app.get('/tax-report{/:year}', (req, res) => {
  if (!taxReportTemplate) {
    const taxReportHtml = fs.readFileSync(path.join(__dirname, 'tax-report.hbs'), 'utf-8');
    taxReportTemplate = Handlebars.compile(taxReportHtml);
  }

  const strYear = req.params.year;
  const currentYear = new Date().getFullYear();
  const year = strYear ? parseInt(strYear) : currentYear;
  if (isNaN(year) || year < 2000 || year > 3000) {
    const error = `Invalid year '${strYear}'`;
  }
  const rawOrders = getOrders({ year, cancelled: false, byDelivered: true });
  const orders = rawOrders.map(o => ({
    ...o,
    etvReason: o.etvReason ?? (o.etvFactor === 0.2 ? 'Thrift shop value' : null)
  }));

  res.send(taxReportTemplate({ ingress: req.get('x-ingress-path') || '', orders, year }));
});
app.get('/orders', async (req, res) => {
  try {
    /** @type {GetOrdersOptions} */
    const variables = {
      cancelled: req.query['filter'] === 'cancelled',
      nonAdjustedOnly: req.query['filter'] === 'adjusted',
      limit: safeParseInt(req.query['limit']),
      offset: safeParseInt(req.query['offset']),
      search: safeQsString(req.query['s']),
      sort: safeQsString(req.query['sort']),
      dir: safeQsString(req.query['dir']),
    };
    const total = getOrders({
      ...variables,
      limit: undefined,
      offset: undefined,
      countOnly: true
    });
    const orders = getOrders(variables);
    res.json({ orders, total });
  } catch (err) {
    const msg = typeof err === 'object' && err && 'message' in err && err.message;
    console.error(msg);
    res.status(500).json({ error: msg });
    return;
  }
});
app.get('/report-data/:year', async (req, res) => {
  const strYear = req.params.year;
  const year = parseInt(strYear);
  if (isNaN(year) || year < 2000 || year > 3000) {
    const error = `Invalid year '${strYear}'`;
  }
  const ordersForYear = getOrders({ year, cancelled: false, byDelivered: true });
  const totalEtv = ordersForYear.reduce((sum, o) => sum + o.etv, 0);
  const totalAdjustedEtv = ordersForYear.reduce((sum, o) => sum + (o.etvFactor !== null ? o.etv * o.etvFactor : o.etv), 0);
  
  /** @type {Map<string, number>} */
  const initialCount = new Map();
  /** @type {Map<string, number>} */
  const initialETV = new Map();
  res.json({
    year,
    totalEtv,
    totalAdjustedEtv,
    orderCount: ordersForYear.length,
    monthly: getMonthlyBreakdown(ordersForYear),
    orderCountByDate: Object.fromEntries(ordersForYear.reduce((acc, o) => {
      const key = o.orderedAt.toISOString().split('T')[0];
      const count = acc.get(key) ?? 0;
      acc.set(key, count + 1);
      
      return acc;
    }, initialCount).entries()),
    orderETVByDate: Object.fromEntries(ordersForYear.reduce((acc, o) => {
      const key = o.orderedAt.toISOString().split('T')[0];
      const prev = acc.get(key) ?? 0;
      acc.set(key, prev + o.etv);
      
      return acc;
    }, initialETV).entries()),
  });
});

/**
 * @typedef {object} MonthlyBreakdown
 * @prop {number} month
 * @prop {number} orderCount
 * @prop {number} totalEtv
 * @prop {number} totalAdjustedEtv
 */
/**
 * Get the list of orders grouped by month
 * @param {Order[]} orders Orders for the year
 * @returns {MonthlyBreakdown[]}
 */
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
  if (etvFactor !== null && (typeof etvFactor !== 'number' || etvFactor < 0)) {
    const error = 'Invalid etvFactor. Must be a number greater than or equal to 0, or null';
    console.error(error);
    res.status(400).json({ error });
    return;
  }
  try {
    setETVFactorForOrder(number, etvFactor);
    res.json({ success: true });
  } catch (err) {
    const msg = typeof err === 'object' && err && 'message' in err && err.message;
    console.error(msg);
    res.status(500).json({ error: msg });
    return;
  }
});

app.post('/orders/:number/etv-reason', express.json(), async (req, res) => {
  const number = req.params.number;
  const { reason } = req.body;
  if (typeof reason !== 'string' || reason.length > 255) {
    const error = 'Invalid reason. Must be a string up to 255 characters';
    console.error(error);
    res.status(400).json({ error });
    return;
  }
  try {
    setETVReasonForOrder(number, reason);
    res.json({ success: true });
  } catch (err) {
    const msg = typeof err === 'object' && err && 'message' in err && err.message;
    console.error(msg);
    res.status(500).json({ error: msg });
    return;
  }
});

app.post('/orders/:number/notes', express.json(), async (req, res) => {
  const number = req.params.number;
  const { notes } = req.body;
  if (typeof notes !== 'string' || notes.length > 2000) {
    const error = 'Invalid notes. Must be a string up to 2000 characters';
    console.error(error);
    res.status(400).json({ error });
    return;
  }
  try {
    setNotesForOrder(number, notes);
    res.json({ success: true });
  } catch (err) {
    const msg = typeof err === 'object' && err && 'message' in err && err.message;
    console.error(msg);
    res.status(500).json({ error: msg });
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
      continue;
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
    cancelled INTEGER DEFAULT 0,
    etvReason TEXT,
    notes TEXT
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
 * @prop {string} [etvReason] Reason for ETV adjustment
 * @prop {string} [notes] Additional notes
 */

/**
 * @typedef {object} GetOrdersOptions
 * @prop {boolean} [cancelled=false] Whether to fetch only cancelled orders (true), or only not-cancelled (false)
 * @prop {boolean} [nonAdjustedOnly=false] Whether to fetch only non-adjusted orders (true), or all (false)
 * @prop {number} [limit] The max number of orders to retrieve, defaults to all orders
 * @prop {number} [offset] How many orders to offset by
 * @prop {string} [search] A keyword to search for, looks at product name, asin, order number, and order date
 * @prop {number} [year] Whether to limit results to just those ordered in a certain year
 * @prop {string} [sort] Column to sort by
 * @prop {string} [dir] Direction to sort
 * @prop {boolean} [byDelivered=false] Whether to use the delivered date for filtering by year, rather than order date
 */
/**
 * @typedef {object} GetOrdersOptionsRows
 * @prop {false} [countOnly] Whether to only return the count rather than the actual records
 */
/**
 * @typedef {object} GetOrdersOptionsCount
 * @prop {true} [countOnly] Whether to only return the count rather than the actual records
 */
/**
 * @overload
 * Fetch orders from SQL
 * @param {GetOrdersOptions & GetOrdersOptionsRows} options
 * @returns {Order[]} List of orders
 */
/**
 * @overload
 * Fetch order count from SQL
 * @param {GetOrdersOptions & GetOrdersOptionsCount} options
 * @returns {number} Count of orders
 */
/**
 * @param {GetOrdersOptions & (GetOrdersOptionsRows | GetOrdersOptionsCount)} options
 */
function getOrders({
  cancelled = false,
  nonAdjustedOnly = false,
  limit,
  offset,
  search,
  year,
  countOnly = false,
  sort,
  dir,
  byDelivered = false,
}) {
  /** @type {string | null} */
  let keyword = null;
  /** @type {string | null} */
  let startDate = null;
  /** @type {string | null} */
  let endDate = null;
  if (year) {
    const dt = new Date(year, 0, 1, 0, 0, 0, 0);
    startDate = dt.toISOString();
    dt.setMonth(11, 31)
    dt.setHours(11, 59, 59, 999);
    endDate = dt.toISOString();
  }
  if (search) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(search)) {
      const dt = new Date();
      const [strYear, strMonth, strDay] = search.split('-');
      const year = safeParseInt(strYear);
      const month = safeParseInt(strMonth);
      const day = safeParseInt(strDay);
      if (!year || !month || !day) throw new Error('Invalid date');
      dt.setFullYear(year, month - 1, day);
      dt.setHours(0, 0, 0, 0);
      startDate = dt.toISOString();
      dt.setHours(23, 59, 59, 999);
      endDate = dt.toISOString();
    } else {
      keyword = '%' + search + '%';
    }
  }
  let sortCol = 'orderedAt';
  if (!countOnly && sort && ['etv', 'etvFactor', 'adjustedEtv'].includes(sort)) {
    sortCol = sort;
  }
  const sortDir = countOnly ? 'ASC' : (dir === 'asc' ? 'ASC' : 'DESC');
  const query = db.prepare(`SELECT ${countOnly ?
    'COUNT(1) as row_count' : '*, etv * COALESCE(etvFactor, 0) AS adjustedEtv'
  } FROM orders WHERE cancelled = :cancelled${!!keyword ?
    " AND (number LIKE :keyword OR asin LIKE :keyword OR product LIKE :keyword)" : ""
  }${!!startDate ?
    ` AND ${byDelivered ? 'deliveredAt' : 'orderedAt'} >= :startDate` : ""
  }${!!endDate ?
    ` AND ${byDelivered ? 'deliveredAt' : 'orderedAt'} <= :endDate` : ""
  }${nonAdjustedOnly ?
    " AND etv != 0.0 AND (etvFactor IS NULL OR (etvFactor IS NOT NULL AND etvFactor != 0.2 AND etvFactor != 1 AND etvReason IS NULL))" : ""
  } ORDER BY ${sortCol} ${sortDir}${typeof limit === 'number' ?
    " LIMIT :limit" : ""
  }${typeof offset === 'number' ?
    " OFFSET :offset" : ""
  }`);

  const variables = onlyDefined({
    cancelled: cancelled ? 1 : 0,
    keyword: keyword,
    startDate: startDate,
    endDate: endDate,
    limit: limit,
    offset: offset
  });

  if (countOnly) {
    const result = query.get(variables);
    return result?.row_count ?? 0;
  }

  const orders = query.all(variables);
  return orders.map(toOrder);
}

/**
 * Return an object that only contains the keys of input that were defined
 * @param {Record<string, NonNullable<any> | undefined | null>} input 
 * @returns {Record<string, NonNullable<any>>}
 */
function onlyDefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => value !== undefined && value !== null));
}

/**
 * Insert an order into the database if it doesn't already exist
 * @param {Order} order
 */
function maybeInsertOrder(order) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO orders (number, asin, product, orderedAt, deliveredAt, etv, etvFactor, cancelled, etvReason)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`);
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
 * @param {number | null} etvFactor
 */
function setETVFactorForOrder(number, etvFactor) {
  const stmt = db.prepare(`UPDATE orders SET etvFactor = ? WHERE number = ?`);
  stmt.run(etvFactor, number);
}

/**
 * Set the ETV reason for an order
 * @param {string} number
 * @param {string | null} reason
 */
function setETVReasonForOrder(number, reason) {
  if (reason === '') {
    reason = null;
  }
  const stmt = db.prepare(`UPDATE orders SET etvReason = ? WHERE number = ?`);
  stmt.run(reason, number);
}

/**
 * Set the notes for an order
 * @param {string} number
 * @param {string} notes
 */
function setNotesForOrder(number, notes) {
  const stmt = db.prepare(`UPDATE orders SET notes = ? WHERE number = ?`);
  stmt.run(notes, number);
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
    etvReason: row.etvReason
  };
}

/**
 * Parse an int from a query string value, or return undefined
 * @param {string | qs.ParsedQs | (string | qs.ParsedQs)[] | undefined} value The query string value to parse
 * @returns {number | undefined} The parsed integer, or undefined
 */
function safeParseInt(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return undefined;
  if (typeof value !== 'string') return undefined;
  const num = parseInt(value, 10);
  if (Number.isNaN(num)) return undefined;
  return num;
}

/**
 * Parse a single string from a query string value, or return undefined
 * @param {string | qs.ParsedQs | (string | qs.ParsedQs)[] | undefined} value The value to parse
 * @returns {string | undefined} The string value or undefined
 */
function safeQsString(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return undefined;
  if (typeof value !== 'string') return undefined;
  return value;
}
