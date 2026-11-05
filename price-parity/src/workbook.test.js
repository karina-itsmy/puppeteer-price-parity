import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTotals } from './runResults';
import { buildWorkbook } from './workbook';

const search = { state: 'VIC', membershipType: 'single', coverType: 'hospital' };

const profile = { age: 40, rebateTier: 'base', lhcAge: null };

const config = {
  name: 'local',
  baseUrl: 'http://localhost:3000',
  leadId: '1',
  expectedFund: { code: 'cps', name: 'see-u by HBF' },
  actualFund: { code: 'itsmy', name: 'ItsMy' },
  rateFiles: ['/rate-files/itsmy_FullLoad.xlsx'],
  priceDate: '2026-10-19',
  profile,
  screenshots: 'issues',
};

// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const card = (priceCents, discounts) => ({
  ...search,
  productName: 'Bronze Hospital',
  fundProductCode: 'S3J-V',
  excess: '750',
  priceText: `$${(priceCents / 100).toFixed(2)}`,
  priceCents,
  basePremiumCents: priceCents,
  rebateCents: 0,
  lhcCents: 0,
  discounts,
  hospitalItems: [],
  extrasBenefits: null,
  cardId: 'product-comparison-S3J-V',
});

const differenceResult = (expectedDiscounts, actualDiscounts) => ({
  key: 'S3J-V|VIC|single|hospital|750',
  status: 'difference',
  rateRow: { productName: 'Bronze Hospital', monthlyPremiumCents: 10000 },
  expected: card(10000, expectedDiscounts),
  actual: card(10079, actualDiscounts),
  deltaCents: 79,
  fieldDifferences: [{ field: 'price', expected: 10000, actual: 10079, deltaCents: 79 }],
  screenshots: { expected: 'screenshots/expected.png', actual: 'screenshots/actual.png' },
});

const runWith = results => ({
  config,
  startedAt: '2026-10-19T04:00:00.000Z',
  finishedAt: '2026-10-19T04:05:00.000Z',
  stoppedBy: null,
  scenarios: [
    {
      id: 'VIC-single-hospital',
      set: 'full-sweep',
      search,
      profile,
      status: 'done',
      rateRowCount: results.length,
      results,
    },
  ],
});

// Writes the workbook to disk and reads it back, so the test sees what Excel would open.
const roundTrip = async run => {
  const file = path.join(directory, 'report.xlsx');
  await buildWorkbook(run, runTotals(run.scenarios), directory).xlsx.writeFile(file);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  return workbook;
};

const columnValues = (sheet, header) => {
  const headerRow = sheet.getRow(2).values;
  const columns = headerRow.flatMap((value, index) => (value === header ? [index] : []));
  return columns.map(column => sheet.getRow(3).getCell(column).value);
};

let directory;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'price-parity-workbook-'));
  fs.mkdirSync(path.join(directory, 'screenshots'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('buildWorkbook', () => {
  it('builds every sheet for a run with no searches', async () => {
    const workbook = await roundTrip({ ...runWith([]), scenarios: [] });
    expect(workbook.getWorksheet('Summary').getRow(4).values.slice(1)).toEqual(['Result', 'FAIL']);
    expect(workbook.getWorksheet('Differences').rowCount).toBe(1);
    expect(workbook.getWorksheet('Evidence').getRow(2).getCell(1).value).toBe(
      'No screenshots were taken.',
    );
  });

  it('embeds a real screenshot and skips empty or non-PNG files instead of writing a broken image', async () => {
    fs.writeFileSync(path.join(directory, 'screenshots/expected.png'), PNG);
    fs.writeFileSync(path.join(directory, 'screenshots/actual.png'), '');
    const workbook = await roundTrip(runWith([differenceResult([], [])]));
    expect(workbook.getWorksheet('Evidence').getImages()).toHaveLength(1);

    fs.writeFileSync(path.join(directory, 'screenshots/expected.png'), 'not a png at all, honest');
    fs.writeFileSync(path.join(directory, 'screenshots/actual.png'), PNG.subarray(0, 20));
    const broken = await roundTrip(runWith([differenceResult([], [])]));
    expect(broken.getWorksheet('Evidence').getImages()).toHaveLength(0);
    expect(broken.getWorksheet('Evidence').getRow(2).getCell(1).value).toBe(
      'No screenshots were taken.',
    );
  });

  it('shows discounts as text, "None" for an empty list and blank when not read', async () => {
    const workbook = await roundTrip(
      runWith([differenceResult([{ label: 'Direct debit', value: 450 }], [])]),
    );
    const allRows = workbook.getWorksheet('All rows');
    const discounts = allRows.getRow(1).values.indexOf('Discounts');
    expect(allRows.getRow(3).getCell(discounts).value).toBe('Direct debit $4.50');
    expect(allRows.getRow(3).getCell(discounts + 1).value).toBe('None');

    const unread = await roundTrip(runWith([differenceResult(null, null)]));
    const unreadRows = unread.getWorksheet('All rows');
    expect(unreadRows.getRow(3).getCell(discounts).value).toBeNull();
  });

  it('says "None" for hospital items when the card had none to compare', async () => {
    const workbook = await roundTrip(runWith([differenceResult([], [])]));
    expect(columnValues(workbook.getWorksheet('All rows'), 'Hospital items')).toEqual(['None']);
  });
});
