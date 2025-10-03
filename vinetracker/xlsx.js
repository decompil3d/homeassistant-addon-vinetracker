const XLSX = require('xlsx');

async function xlsxParse(buffer) {
  // TODO: debug this
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const jsonData = XLSX.utils.sheet_to_json(worksheet, { range: 2 }); // Skip first 3 rows (0-indexed)

  return jsonData.map(row => {
    // Assuming the Excel columns are named:
    // - 'Order Number',
    // - 'ASIN',
    // - 'Product Name',
    // - 'Order Type',
    // - 'Order Date',
    // - 'Shipped Date',
    // - 'Cancelled Date',
    // - 'Estimated Tax Value'
    // - 'ETV Factor' (optional)
    const number = String(row['Order Number']).trim();
    const asin = String(row['ASIN']).trim();
    const product = String(row['Product Name']).trim();
    const type = String(row['Order Type']).trim();
    const orderedAtStr = String(row['Order Date']).trim();
    const deliveredAtStr = String(row['Shipped Date']).trim();
    const cancelledDateStr = String(row['Cancelled Date']).trim();
    const etvStr = String(row['Estimated Tax Value']).trim();
    const etvFactor = row['ETV Factor'] !== undefined ? parseFloat(String(row['ETV Factor']).trim()) : null;

    if (!number || !(/^\d/.test(number))) {
      console.warn('Skipping row with missing or invalid order number');
      return null;
    }

    return {
      number,
      asin,
      product,
      type,
      orderedAtStr,
      deliveredAtStr,
      cancelledDateStr,
      etvStr,
      etvFactor
    }
  }).filter(Boolean);
}

module.exports = {
  xlsxParse
};
