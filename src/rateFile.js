const ExcelJS = require('exceljs');
const path = require('path');
const { pairingKey, parseMoney } = require('./comparator');

const DEFAULT_SHEET = 'PriceLoad';
const ALL_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

const columns = {
  productName: 'Product Name',
  fundProductCode: 'Fund Product Code',
  state: 'State',
  membershipType: 'Sis Membership Type',
  coverType: 'Policy Type',
  excess: 'Excess',
  monthlyPremium: 'Gross Monthly Full Premium',
  availableFrom: 'Available From',
  availableTo: 'Available To',
  futureMonthlyPremium: 'Future Gross Monthly Full Premium',
  futureAvailableFrom: 'Future Available From',
  futureAvailableTo: 'Future Available To',
  productStatus: 'Product Status',
  fundChannel: 'Fund Channel',
};
const requiredColumns = [
  columns.fundProductCode,
  columns.state,
  columns.membershipType,
  columns.coverType,
  columns.excess,
  columns.monthlyPremium,
];

// Rate file labels, compared without case, spaces or punctuation.
const membershipTypes = {
  single: 'single',
  couple: 'couple',
  family: 'family',
  singleparent: 'single-parent',
  singleparentfamily: 'single-parent',
  singleanydependants: 'single-any-dependants',
  coupleanydependants: 'couple-any-dependants',
};
const coverTypes = {
  hospital: 'hospital',
  extras: 'extras',
  ancillary: 'extras',
  combined: 'combined',
};

const squash = value =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const normalise = (lookup, value, label) => {
  const normalised = lookup[squash(value)];
  if (!normalised) throw new Error(`Unknown ${label} "${value}"`);
  return normalised;
};

// Maps a rate file membership type to the funnel's value.
const normaliseMembershipType = value => normalise(membershipTypes, value, 'membership type');
// Maps a rate file policy type to the funnel's cover type.
const normaliseCoverType = value => normalise(coverTypes, value, 'cover type');

// Expands state "All" to every state, as the rate file import does.
const normaliseStates = value => {
  const state = String(value ?? '')
    .trim()
    .toUpperCase();
  if (state === 'ALL') return ALL_STATES;
  if (!ALL_STATES.includes(state)) throw new Error(`Unknown state "${value}"`);
  return [state];
};

// Formula cells keep their value in `result`, rich text in `richText`.
const cellValue = value => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('result' in value) return value.result;
    if ('richText' in value) return value.richText.map(part => part.text).join('');
    if ('text' in value) return value.text;
  }
  return value;
};

const toCents = value => {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return Math.round(value * 100);
  const cents = parseMoney(String(value));
  if (cents === null) throw new Error(`Unreadable premium "${value}"`);
  return cents;
};

const toIsoDate = value => {
  if (value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const dayFirst = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dayFirst) {
    const [, day, month, year] = dayFirst;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  throw new Error(`Unreadable date "${value}"`);
};

const toExcess = value => {
  if (typeof value === 'number') return value;
  const cents = value === null || value === '' ? null : parseMoney(String(value));
  if (cents === null) throw new Error(`Unreadable excess "${value ?? ''}"`);
  return cents / 100;
};

const isNo = value =>
  value === false ||
  ['false', 'no', 'n', '0'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

// True for a closed product not sold through the fund channel, which no funnel shows a new customer.
const isNotSold = record =>
  squash(record[columns.productStatus]) === 'closed' && isNo(record[columns.fundChannel]);

// A full load row can hold a current and a future price; each becomes a window.
const priceWindows = record => {
  const windows = [
    {
      monthlyPremiumCents: toCents(record[columns.monthlyPremium]),
      availableFrom: toIsoDate(record[columns.availableFrom] ?? null),
      availableTo: toIsoDate(record[columns.availableTo] ?? null),
    },
    {
      monthlyPremiumCents: toCents(record[columns.futureMonthlyPremium] ?? null),
      availableFrom: toIsoDate(record[columns.futureAvailableFrom] ?? null),
      availableTo: toIsoDate(record[columns.futureAvailableTo] ?? null),
    },
  ].filter(window => window.monthlyPremiumCents !== null);
  if (!windows.length) throw new Error(`"${columns.monthlyPremium}" is blank`);
  return windows;
};

const toRows = (record, rowNumber, sourceFile) => {
  try {
    const membershipType = normaliseMembershipType(record[columns.membershipType]);
    const coverType = normaliseCoverType(record[columns.coverType]);
    const notSold = isNotSold(record);
    return normaliseStates(record[columns.state]).flatMap(state =>
      priceWindows(record).map(window => ({
        sourceFile,
        rowNumber,
        productName: record[columns.productName] ?? null,
        fundProductCode: String(record[columns.fundProductCode] ?? '').trim(),
        state,
        membershipType,
        coverType,
        excess: toExcess(record[columns.excess]),
        notSold,
        ...window,
      })),
    );
  } catch (error) {
    throw new Error(`Rate file ${sourceFile} row ${rowNumber}: ${error.message}`);
  }
};

// Reads the price sheet into one row per price, in funnel terms.
const readRateFile = async (filePath, sheetName = DEFAULT_SHEET) => {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (error) {
    throw new Error(`Could not read rate file ${filePath}: ${error.message}`);
  }
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) {
    const names = workbook.worksheets.map(worksheet => worksheet.name).join(', ');
    throw new Error(`Rate file ${filePath} has no "${sheetName}" sheet. Sheets: ${names}`);
  }

  const header = sheet
    .getRow(1)
    .values.slice(1)
    .map(value => String(cellValue(value) ?? '').trim());
  const missing = requiredColumns.filter(column => !header.includes(column));
  if (missing.length) {
    throw new Error(`Rate file sheet "${sheetName}" is missing columns: ${missing.join(', ')}`);
  }

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const values = row.values.slice(1).map(cellValue);
    if (values.every(value => value === null || value === '')) return;
    const record = Object.fromEntries(header.map((name, index) => [name, values[index] ?? null]));
    rows.push(...toRows(record, rowNumber, path.basename(filePath)));
  });
  return rows;
};

// Reads rate files in load order, e.g. a full load then its price rises.
const readRateFiles = async (filePaths, sheetName = DEFAULT_SHEET) => {
  const rows = [];
  for (const filePath of filePaths) rows.push(...(await readRateFile(filePath, sheetName)));
  return rows;
};

const isAvailableOn = (row, date) =>
  (!row.availableFrom || row.availableFrom <= date) &&
  (!row.availableTo || row.availableTo >= date);

// One row per product with no price on `date`, e.g. its window has ended.
const keysWithoutPriceOn = (rows, date) => {
  const priced = new Set(rows.filter(row => isAvailableOn(row, date)).map(pairingKey));
  const missing = new Map();
  for (const row of rows) {
    const key = pairingKey(row);
    if (!priced.has(key) && !missing.has(key)) missing.set(key, row);
  }
  return [...missing.values()];
};

// Per product, the latest-starting price available on `date`; ties go to the later file.
const currentRateRows = (rows, date) => {
  const chosen = new Map();
  rows.forEach((row, index) => {
    if (!isAvailableOn(row, date)) return;
    const key = pairingKey(row);
    const previous = chosen.get(key);
    if (!previous || (row.availableFrom ?? '') >= (previous.row.availableFrom ?? '')) {
      chosen.set(key, { row, index });
    }
  });
  return [...chosen.values()].sort((a, b) => a.index - b.index).map(({ row }) => row);
};

const movementClass = (cents, previousCents) => {
  const change = cents - previousCents;
  if (change === 0) return 'unchanged';
  if (Math.abs(change) <= 1) return 'rounding';
  return change > 0 ? 'increase' : 'decrease';
};

// Adds the price each chosen row took over from: the same product's latest earlier-starting price.
const withMovement = (allRows, chosenRows) => {
  const fileOrder = [...new Set(allRows.map(row => row.sourceFile))];
  const fileIndex = row => fileOrder.indexOf(row.sourceFile);
  const byKey = new Map();
  for (const row of allRows) {
    const key = pairingKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  const startsBefore = (row, chosen) =>
    (row.availableFrom ?? '') < (chosen.availableFrom ?? '') ||
    ((row.availableFrom ?? '') === (chosen.availableFrom ?? '') &&
      fileIndex(row) < fileIndex(chosen));
  return chosenRows.map(chosen => {
    const previous = byKey
      .get(pairingKey(chosen))
      .filter(row => row !== chosen && startsBefore(row, chosen))
      .reduce((latest, row) => (!latest || !startsBefore(row, latest) ? row : latest), null);
    if (!previous) {
      return {
        ...chosen,
        previousPremiumCents: null,
        movement: fileIndex(chosen) === 0 ? 'not in increment' : 'new product',
      };
    }
    return {
      ...chosen,
      previousPremiumCents: previous.monthlyPremiumCents,
      previousSourceFile: previous.sourceFile,
      movement: movementClass(chosen.monthlyPremiumCents, previous.monthlyPremiumCents),
    };
  });
};

// The rows for one state, membership type and cover type.
const rowsForSearch = (rows, search) =>
  rows.filter(
    row =>
      row.state === search.state &&
      row.membershipType === search.membershipType &&
      row.coverType === search.coverType,
  );

module.exports = {
  currentRateRows,
  isNotSold,
  keysWithoutPriceOn,
  normaliseCoverType,
  normaliseMembershipType,
  normaliseStates,
  readRateFile,
  readRateFiles,
  rowsForSearch,
  withMovement,
};
