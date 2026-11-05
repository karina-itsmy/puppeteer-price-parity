import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
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
} from './rateFile';

// The PriceLoad columns the reader uses, in rate file order, plus one it ignores.
const fullLoadHeader = [
  'Product Name',
  'Fund Product Code',
  'State',
  'Sis Membership Type',
  'Policy Type',
  'Available From',
  'Available To',
  'Gross Monthly Full Premium',
  'Future Available From',
  'Future Available To',
  'Future Gross Monthly Full Premium',
  'Excess',
  'Product Status',
];
const incrementalHeader = fullLoadHeader.filter(column => !column.startsWith('Future'));

const thisYear = ['2026-04-01', '2027-03-31'];
const nextYear = ['2027-04-01', '2028-03-31'];
const noFuture = [null, null, null];

const fullLoadRows = [
  [
    'Itsmy Basic Hospital',
    'S3P-V',
    'VIC',
    'Single',
    'Hospital',
    ...thisYear,
    106.78,
    ...noFuture,
    750,
    'open',
  ],
  [
    'Itsmy Bronze Plus Hospital',
    'S3J-V',
    'VIC',
    'Single',
    'Hospital',
    ...thisYear,
    131.1,
    ...noFuture,
    750,
    'open',
  ],
  [
    'Itsmy Extras 50',
    'FX50',
    'NSW',
    'Singleparentfamily',
    'Extras',
    ...thisYear,
    40.5,
    ...noFuture,
    0,
    'open',
  ],
  [
    'Itsmy Next Year',
    'N1',
    'all',
    'Couple',
    'Combined',
    null,
    null,
    null,
    ...nextYear,
    200,
    750,
    'open',
  ],
  [
    'Itsmy Both Years',
    'B1',
    'VIC',
    'Single',
    'Hospital',
    ...thisYear,
    100,
    ...nextYear,
    110,
    750,
    'open',
  ],
];
const priceRiseRows = [
  [
    'Itsmy Bronze Plus Hospital',
    'S3J-V',
    'VIC',
    'Single',
    'Hospital',
    '2026-09-01',
    '2027-03-31',
    133.07,
    750,
    'open',
  ],
];

let directory;

const writeWorkbook = async (
  name,
  { sheetName = 'PriceLoad', columns = fullLoadHeader, rows = fullLoadRows } = {},
) => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('FundData').addRow(['ignored']);
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(columns);
  rows.forEach(row => sheet.addRow(row));
  const filePath = path.join(directory, name);
  await workbook.xlsx.writeFile(filePath);
  return filePath;
};

const writePriceRise = () =>
  writeWorkbook('rise.xlsx', { columns: incrementalHeader, rows: priceRiseRows });

const priceOf = (rows, code) =>
  rows.filter(row => row.fundProductCode === code).map(row => row.monthlyPremiumCents);

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'price-parity-rate-file-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('readRateFile', () => {
  it('reads the price sheet into keyed rows in funnel terms', async () => {
    const rows = await readRateFile(await writeWorkbook('full.xlsx'));
    expect(rows.slice(0, 3)).toEqual([
      {
        sourceFile: 'full.xlsx',
        rowNumber: 2,
        productName: 'Itsmy Basic Hospital',
        fundProductCode: 'S3P-V',
        state: 'VIC',
        membershipType: 'single',
        coverType: 'hospital',
        excess: 750,
        notSold: false,
        monthlyPremiumCents: 10678,
        availableFrom: '2026-04-01',
        availableTo: '2027-03-31',
      },
      expect.objectContaining({ fundProductCode: 'S3J-V', monthlyPremiumCents: 13110 }),
      expect.objectContaining({
        fundProductCode: 'FX50',
        state: 'NSW',
        membershipType: 'single-parent',
        coverType: 'extras',
        excess: 0,
      }),
    ]);
  });

  it('expands a row for state "all" into every state', async () => {
    const rows = await readRateFile(await writeWorkbook('full.xlsx'));
    expect(rows.filter(row => row.fundProductCode === 'N1').map(row => row.state)).toEqual([
      'ACT',
      'NSW',
      'NT',
      'QLD',
      'SA',
      'TAS',
      'VIC',
      'WA',
    ]);
  });

  it("splits a row with this year's and next year's prices into two windows", async () => {
    const rows = await readRateFile(await writeWorkbook('full.xlsx'));
    expect(rows.filter(row => row.fundProductCode === 'B1')).toEqual([
      expect.objectContaining({ monthlyPremiumCents: 10000, availableFrom: '2026-04-01' }),
      expect.objectContaining({ monthlyPremiumCents: 11000, availableFrom: '2027-04-01' }),
    ]);
  });

  it('reads an incremental file, which has no future columns', async () => {
    const rows = await readRateFile(await writePriceRise());
    expect(rows).toEqual([
      expect.objectContaining({
        sourceFile: 'rise.xlsx',
        fundProductCode: 'S3J-V',
        monthlyPremiumCents: 13307,
        availableFrom: '2026-09-01',
      }),
    ]);
  });

  it('rejects a sheet missing a required column, naming it', async () => {
    const filePath = await writeWorkbook('full.xlsx', {
      columns: fullLoadHeader.filter(column => column !== 'Excess'),
      rows: [],
    });
    await expect(readRateFile(filePath)).rejects.toThrow('missing columns: Excess');
  });

  it('rejects a workbook with no price sheet, listing the sheets it has', async () => {
    const filePath = await writeWorkbook('full.xlsx', { sheetName: 'Prices' });
    await expect(readRateFile(filePath)).rejects.toThrow(
      'no "PriceLoad" sheet. Sheets: FundData, Prices',
    );
  });

  it('names the file and row when a label is not recognised', async () => {
    const filePath = await writeWorkbook('full.xlsx', {
      rows: [
        [
          'Odd',
          'X1',
          'VIC',
          'Extended Family',
          'Hospital',
          ...thisYear,
          10,
          ...noFuture,
          750,
          'open',
        ],
      ],
    });
    await expect(readRateFile(filePath)).rejects.toThrow(
      'Rate file full.xlsx row 2: Unknown membership type "Extended Family"',
    );
  });

  const oneRow = (overrides = {}) => {
    const row = [
      'Odd',
      'X1',
      'VIC',
      'Single',
      'Hospital',
      ...thisYear,
      10,
      ...noFuture,
      750,
      'open',
    ];
    for (const [column, value] of Object.entries(overrides))
      row[fullLoadHeader.indexOf(column)] = value;
    return writeWorkbook('full.xlsx', { rows: [row] });
  };

  it('names the row when a premium cannot be read', async () => {
    await expect(
      readRateFile(await oneRow({ 'Gross Monthly Full Premium': 'N/A' })),
    ).rejects.toThrow('Rate file full.xlsx row 2: Unreadable premium "N/A"');
  });

  it('names the row when the premium is blank', async () => {
    await expect(
      readRateFile(await oneRow({ 'Gross Monthly Full Premium': null })),
    ).rejects.toThrow('row 2: "Gross Monthly Full Premium" is blank');
  });

  it('reads an excess written as money, and names the row when the excess is blank', async () => {
    const [row] = await readRateFile(await oneRow({ Excess: '$500' }));
    expect(row.excess).toBe(500);
    await expect(readRateFile(await oneRow({ Excess: null }))).rejects.toThrow(
      'row 2: Unreadable excess ""',
    );
  });

  it('reads day-first text dates, and names the row when a date cannot be read', async () => {
    const [row] = await readRateFile(await oneRow({ 'Available From': '1/04/2026' }));
    expect(row.availableFrom).toBe('2026-04-01');
    await expect(readRateFile(await oneRow({ 'Available From': 'April 2026' }))).rejects.toThrow(
      'row 2: Unreadable date "April 2026"',
    );
  });

  it('rejects a file that cannot be read', async () => {
    await expect(readRateFile(path.join(directory, 'missing.xlsx'))).rejects.toThrow(
      'Could not read rate file',
    );
  });
});

describe('currentRateRows', () => {
  it('uses the full load alone when no price rise is listed', async () => {
    const rows = currentRateRows(
      await readRateFiles([await writeWorkbook('full.xlsx')]),
      '2026-10-19',
    );
    expect(priceOf(rows, 'S3J-V')).toEqual([13110]);
    expect(priceOf(rows, 'B1')).toEqual([10000]);
  });

  it('lets a price rise replace the full load price once it is available', async () => {
    const rows = await readRateFiles([await writeWorkbook('full.xlsx'), await writePriceRise()]);
    expect(priceOf(currentRateRows(rows, '2026-08-31'), 'S3J-V')).toEqual([13110]);
    expect(priceOf(currentRateRows(rows, '2026-09-01'), 'S3J-V')).toEqual([13307]);
    expect(priceOf(currentRateRows(rows, '2026-09-01'), 'S3P-V')).toEqual([10678]);
  });

  it("switches to next year's prices on their start date, and drops prices that have ended", async () => {
    const rows = await readRateFiles([await writeWorkbook('full.xlsx'), await writePriceRise()]);
    const nextYearRows = currentRateRows(rows, '2027-04-01');
    expect(priceOf(nextYearRows, 'B1')).toEqual([11000]);
    expect(priceOf(nextYearRows, 'N1')).toHaveLength(8);
    expect(priceOf(nextYearRows, 'S3P-V')).toEqual([]);
  });

  it('leaves out prices that have not started yet', async () => {
    const rows = currentRateRows(
      await readRateFiles([await writeWorkbook('full.xlsx')]),
      '2026-10-19',
    );
    expect(priceOf(rows, 'N1')).toEqual([]);
  });

  it('gives a tie on start date to the file loaded later', async () => {
    const rows = await readRateFiles([
      await writePriceRise(),
      await writeWorkbook('second.xlsx', {
        columns: incrementalHeader,
        rows: [[...priceRiseRows[0].slice(0, 7), 140, 750, 'open']],
      }),
    ]);
    expect(priceOf(currentRateRows(rows, '2026-10-19'), 'S3J-V')).toEqual([14000]);
  });
});

describe('isNotSold', () => {
  it('marks a closed product that the fund channel does not sell', () => {
    expect(isNotSold({ 'Product Status': 'closed', 'Fund Channel': false })).toBe(true);
    expect(isNotSold({ 'Product Status': 'Closed', 'Fund Channel': 'FALSE' })).toBe(true);
  });

  it('keeps open products, closed products still sold through the fund channel, and files without the columns', () => {
    expect(isNotSold({ 'Product Status': 'open', 'Fund Channel': false })).toBe(false);
    expect(isNotSold({ 'Product Status': 'closed', 'Fund Channel': true })).toBe(false);
    expect(isNotSold({ 'Product Status': 'closed' })).toBe(false);
    expect(isNotSold({})).toBe(false);
  });
});

describe('label normalising', () => {
  it('maps rate file membership types to funnel values', () => {
    expect(normaliseMembershipType('Single')).toBe('single');
    expect(normaliseMembershipType('COUPLE')).toBe('couple');
    expect(normaliseMembershipType('Family')).toBe('family');
    expect(normaliseMembershipType('Singleparentfamily')).toBe('single-parent');
    expect(normaliseMembershipType('Single Parent')).toBe('single-parent');
  });

  it('maps the any-dependants membership types some funds sell', () => {
    expect(normaliseMembershipType('singleanydependants')).toBe('single-any-dependants');
    expect(normaliseMembershipType('Couple: any dependants')).toBe('couple-any-dependants');
  });

  it('maps rate file policy types to funnel cover types', () => {
    expect(normaliseCoverType('Hospital')).toBe('hospital');
    expect(normaliseCoverType('Extras')).toBe('extras');
    expect(normaliseCoverType('Ancillary')).toBe('extras');
    expect(normaliseCoverType('Combined')).toBe('combined');
  });

  it('rejects an unknown state', () => {
    expect(normaliseStates(' vic ')).toEqual(['VIC']);
    expect(() => normaliseStates('XYZ')).toThrow('Unknown state "XYZ"');
  });
});

describe('rowsForSearch', () => {
  it('keeps only the rows for one state, membership type and cover type', async () => {
    const rows = currentRateRows(
      await readRateFile(await writeWorkbook('full.xlsx')),
      '2026-10-19',
    );
    const found = rowsForSearch(rows, {
      state: 'VIC',
      membershipType: 'single',
      coverType: 'hospital',
    });
    expect(found.map(row => row.fundProductCode)).toEqual(['S3P-V', 'S3J-V', 'B1']);
  });
});

describe('keysWithoutPriceOn', () => {
  const row = (fundProductCode, availableFrom, availableTo) => ({
    fundProductCode,
    state: 'VIC',
    membershipType: 'single',
    coverType: 'hospital',
    excess: 750,
    monthlyPremiumCents: 10000,
    availableFrom,
    availableTo,
  });

  it('lists each product with no price on the date once, and leaves out priced ones', () => {
    const rows = [
      row('ENDED', '2025-04-01', '2026-03-31'),
      row('ENDED', '2024-04-01', '2025-03-31'),
      row('CURRENT', '2026-04-01', '2027-03-31'),
      row('CURRENT', '2025-04-01', '2026-03-31'),
    ];
    expect(
      keysWithoutPriceOn(rows, '2026-10-21').map(unpriced => unpriced.fundProductCode),
    ).toEqual(['ENDED']);
  });
});

describe('withMovement', () => {
  const row = (sourceFile, code, cents, availableFrom, availableTo = '2027-03-31') => ({
    sourceFile,
    fundProductCode: code,
    state: 'VIC',
    membershipType: 'single',
    coverType: 'hospital',
    excess: 750,
    monthlyPremiumCents: cents,
    availableFrom,
    availableTo,
  });
  const movementOf = (allRows, chosen) => {
    const [result] = withMovement(allRows, [chosen]);
    return { movement: result.movement, previous: result.previousPremiumCents };
  };

  it('classes a later file price against the price it took over', () => {
    const full = [
      row('full.xlsx', 'UP', 10000, '2026-04-01'),
      row('full.xlsx', 'DOWN', 10000, '2026-04-01'),
      row('full.xlsx', 'ROUND', 10000, '2026-04-01'),
      row('full.xlsx', 'SAME', 10000, '2026-04-01'),
    ];
    const increment = [
      row('inc.xlsx', 'UP', 10150, '2026-09-01'),
      row('inc.xlsx', 'DOWN', 9900, '2026-09-01'),
      row('inc.xlsx', 'ROUND', 10001, '2026-09-01'),
      row('inc.xlsx', 'SAME', 10000, '2026-09-01'),
      row('inc.xlsx', 'NEW', 5000, '2026-09-01'),
    ];
    const all = [...full, ...increment];
    expect(increment.map(chosen => movementOf(all, chosen))).toEqual([
      { movement: 'increase', previous: 10000 },
      { movement: 'decrease', previous: 10000 },
      { movement: 'rounding', previous: 10000 },
      { movement: 'unchanged', previous: 10000 },
      { movement: 'new product', previous: null },
    ]);
  });

  it('leaves a first-file row with nothing before it as not in an increment', () => {
    const full = row('full.xlsx', 'A', 10000, '2026-04-01');
    expect(movementOf([full, row('inc.xlsx', 'B', 1, '2026-09-01')], full)).toEqual({
      movement: 'not in increment',
      previous: null,
    });
  });

  it('takes the latest earlier price when three files are loaded', () => {
    const all = [
      row('full.xlsx', 'A', 10000, '2026-04-01'),
      row('inc-a.xlsx', 'A', 10150, '2026-09-01'),
      row('inc-b.xlsx', 'A', 10500, '2027-04-01', '2028-03-31'),
    ];
    expect(movementOf(all, all[2])).toEqual({ movement: 'increase', previous: 10150 });
  });

  it('on a tie in start date, treats the earlier file as the previous price', () => {
    const all = [
      row('full.xlsx', 'A', 10000, '2026-04-01'),
      row('inc.xlsx', 'A', 10300, '2026-04-01'),
    ];
    expect(movementOf(all, all[1])).toEqual({ movement: 'increase', previous: 10000 });
  });

  it("compares a full load's future price with its current price", () => {
    const all = [
      row('full.xlsx', 'A', 10000, '2026-04-01'),
      row('full.xlsx', 'A', 10400, '2027-04-01', '2028-03-31'),
    ];
    expect(movementOf(all, all[1])).toEqual({ movement: 'increase', previous: 10000 });
  });
});
