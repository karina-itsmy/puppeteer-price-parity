import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reportOnly } from './priceParity';
import { differenceLines, passed, productGroups, verdict, writeReport } from './reporter';
import {
  duration,
  evidenceEntries,
  expectedDifferenceLines,
  movementCounts,
  movementLines,
  movementSummary,
  runDetails,
} from './reportLines';
import { runTotals } from './runResults';

const search = { state: 'VIC', membershipType: 'single', coverType: 'hospital' };

const profile = { age: 40, rebateTier: 'base', lhcAge: null };

const rateRow = (code, cents, productName = 'Itsmy Basic Hospital') => ({
  ...search,
  sourceFile: 'itsmy_FullLoad.xlsx',
  rowNumber: 2,
  productName,
  fundProductCode: code,
  excess: 750,
  monthlyPremiumCents: cents,
});

const card = (fundName, code, priceCents) => ({
  ...search,
  fundName,
  productName: `${code} product`,
  fundProductCode: code,
  excess: '750',
  priceText: `$${(priceCents / 100).toFixed(2)}`,
  priceCents,
  basePremiumCents: priceCents + 2500,
  rebateCents: 2500,
  lhcCents: 0,
  discounts: [],
  hospitalItems: [{ label: 'Cataracts', value: 'not covered' }],
  extrasBenefits: null,
  cardId: `product-comparison-${code}`,
});

// A 1×1 PNG, enough for the Evidence sheet to embed.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const fixtureRun = () => ({
  config: {
    name: 'local',
    baseUrl: 'http://localhost:3000',
    leadId: '1000000000000000001',
    rerunOf: 'output/local-20261019-130634/results.json',
    expectedFund: { code: 'cps', name: 'see-u by HBF' },
    actualFund: { code: 'itsmy', name: 'ItsMy' },
    rateFiles: ['/rate-files/itsmy_FullLoad.xlsx'],
    priceDate: '2026-10-19',
    profile: { age: 40, rebateTier: 'base', lhcAge: null },
    headless: true,
    screenshots: 'issues',
  },
  scriptVersion: 'abc1234-dirty',
  startedAt: '2026-10-19T04:00:00.000Z',
  finishedAt: '2026-10-19T04:05:00.000Z',
  stoppedBy: null,
  scenarios: [
    {
      id: 'VIC-single-hospital-age40-base-nolhc',
      set: 'full-sweep',
      search,
      profile,
      status: 'done',
      rateRowCount: 3,
      results: [
        {
          key: 'S3P-V|VIC|single|hospital|750',
          status: 'match',
          rateRow: rateRow('S3P-V', 10678),
          expected: card('see-u by HBF', 'S3P-V', 8103),
          actual: card('ItsMy', 'S3P-V', 8103),
          deltaCents: 0,
          fieldDifferences: [],
        },
        {
          key: 'S3J-V|VIC|single|hospital|750',
          status: 'difference',
          rateRow: rateRow('S3J-V', 13307, 'Itsmy Bronze Hospital'),
          expected: card('see-u by HBF', 'S3J-V', 10032),
          actual: card('ItsMy', 'S3J-V', 10111),
          deltaCents: 79,
          fieldDifferences: [
            { field: 'price', expected: 10032, actual: 10111, deltaCents: 79 },
            { field: 'base premium', expected: 13228, actual: 13307, deltaCents: 79 },
            {
              field: 'hospital: Cataracts',
              expected: 'not covered',
              actual: 'covered',
              deltaCents: null,
            },
          ],
          screenshots: {
            expected: 'screenshots/s3j-expected.png',
            actual: 'screenshots/s3j-actual.png',
          },
        },
        {
          key: 'S31P-V|VIC|single|hospital|750',
          status: 'missing-actual',
          rateRow: rateRow('S31P-V', 10234),
          expected: card('see-u by HBF', 'S31P-V', 7766),
        },
        {
          key: 'X9-V|VIC|single|hospital|750',
          status: 'unexpected',
          side: 'actual',
          card: card('ItsMy', 'X9-V', 5000),
        },
      ],
    },
    {
      id: 'WA-single-hospital-age40-base-nolhc',
      set: 'full-sweep',
      search: { ...search, state: 'WA' },
      profile,
      status: 'error',
      attempts: 2,
      rateRowCount: 4,
      error: 'Results did not finish loading within 90s',
      screenshot: 'screenshots/wa-error.png',
      results: [],
    },
    {
      id: 'VIC-single-hospital-age40-base-lhc35',
      set: 'variations',
      search,
      profile: { ...profile, lhcAge: 35 },
      status: 'done',
      rateRowCount: 2,
      results: [
        {
          key: 'S3P-V|VIC|single|hospital|750',
          status: 'match',
          rateRow: rateRow('S3P-V', 10678),
          expected: card('see-u by HBF', 'S3P-V', 9171),
          actual: card('ItsMy', 'S3P-V', 9171),
          deltaCents: 0,
          fieldDifferences: [],
        },
        {
          key: 'S3J-V|VIC|single|hospital|750',
          status: 'difference',
          rateRow: rateRow('S3J-V', 13307, 'Itsmy Bronze Hospital'),
          expected: card('see-u by HBF', 'S3J-V', 11355),
          actual: card('ItsMy', 'S3J-V', 11434),
          deltaCents: 79,
          fieldDifferences: [
            { field: 'price', expected: 11355, actual: 11434, deltaCents: 79 },
            { field: 'LHC', expected: 1323, actual: 1331, deltaCents: 8 },
          ],
        },
      ],
    },
  ],
});

const sheetValues = sheet => {
  const rows = [];
  sheet.eachRow(row => rows.push(row.values.slice(1)));
  return rows;
};

let directory;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'price-parity-report-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('passed', () => {
  it('fails a run with differences, missing rows or errors, and passes a clean one', () => {
    const run = fixtureRun();
    expect(passed(run, runTotals(run.scenarios))).toBe(false);

    const clean = {
      ...run,
      scenarios: [{ ...run.scenarios[0], results: [run.scenarios[0].results[0]], rateRowCount: 1 }],
    };
    expect(passed(clean, runTotals(clean.scenarios))).toBe(true);
  });

  it('fails a run with a row whose breakdown was not read, and says so in the verdict', () => {
    const run = fixtureRun();
    const [first] = run.scenarios[0].results;
    const unread = {
      ...run,
      scenarios: [
        {
          ...run.scenarios[0],
          results: [{ ...first, status: 'breakdown-not-read', breakdownNotRead: ['expected'] }],
          rateRowCount: 1,
        },
      ],
    };
    const totals = runTotals(unread.scenarios);
    expect(passed(unread, totals)).toBe(false);
    expect(verdict(unread, totals)).toBe("1 row with a price breakdown the script couldn't read.");
  });

  it('fails a run with a row whose price was not read on either card, and says so in the verdict', () => {
    const run = fixtureRun();
    const [first] = run.scenarios[0].results;
    const unread = {
      ...run,
      scenarios: [
        {
          ...run.scenarios[0],
          results: [{ ...first, status: 'price-not-read', fieldDifferences: [] }],
          rateRowCount: 1,
        },
      ],
    };
    const totals = runTotals(unread.scenarios);
    expect(totals.priceNotRead).toBe(1);
    expect(passed(unread, totals)).toBe(false);
    expect(verdict(unread, totals)).toBe(
      '1 row with no price the script could read on either card.',
    );
  });

  it('fails a run that stopped part way, even with no differences', () => {
    const run = fixtureRun();
    const stopped = { ...run, stoppedBy: 'Lead did not load', scenarios: [] };
    expect(passed(stopped, runTotals(stopped.scenarios))).toBe(false);
  });

  it('fails a run that checked no rate file rows, rather than passing it vacuously', () => {
    const run = fixtureRun();
    const empty = { ...run, scenarios: [] };
    expect(passed(empty, runTotals(empty.scenarios))).toBe(false);
    expect(verdict(empty, runTotals(empty.scenarios))).toBe('No rate file rows were checked.');
  });
});

describe('differenceLines and productGroups', () => {
  it('lists one line per differing field and groups them by product', () => {
    const lines = differenceLines(fixtureRun(), 'full-sweep');
    expect(lines.map(line => line.field)).toEqual(['price', 'base premium', 'hospital: Cataracts']);
    expect(lines[0]).toMatchObject({
      product: 'Itsmy Bronze Hospital',
      expected: 100.32,
      actual: 101.11,
      delta: 0.79,
    });
    expect(lines[2]).toMatchObject({ expected: 'not covered', actual: 'covered', delta: null });

    expect(productGroups(lines)).toEqual([
      {
        product: 'Itsmy Bronze Hospital',
        rows: 1,
        fields: 'price, base premium, hospital',
        smallestDelta: 0.79,
        largestDelta: 0.79,
      },
    ]);
  });
});

// The fixture run as a two-environment run: each fund on its own comparator with its own lead.
const twoEnvironmentRun = () => {
  const run = fixtureRun();
  const { baseUrl, leadId, ...config } = run.config;
  run.config = {
    ...config,
    expectedFund: {
      code: 'pho',
      name: 'Phoenix Health Fund',
      baseUrl: 'http://localhost:3001',
      leadId: 'prod-lead',
    },
    actualFund: {
      code: 'phx',
      name: 'Phoenix Test',
      baseUrl: 'http://localhost:3000',
      leadId: 'dev-lead',
    },
  };
  return run;
};

describe('evidenceEntries', () => {
  const config = fixtureRun().config;

  it('lists failing cards, then failed searches, then sample passes', () => {
    const run = fixtureRun();
    run.scenarios[0].results[0].screenshots = {
      expected: 'screenshots/s3p-expected.png',
      actual: 'screenshots/s3p-actual.png',
    };
    const { entries, more } = evidenceEntries(run, config);
    expect(entries.map(entry => entry.group)).toEqual([
      'Failing',
      'Failing',
      'Failed searches',
      'Sample passes',
      'Sample passes',
    ]);
    expect(entries[3].label).toBe(
      'Sample pass: Itsmy Basic Hospital (S3P-V), excess 750, VIC single hospital. see-u by HBF',
    );
    expect(more).toBe(0);
  });

  it('shows selected items after the card screenshots, once per card', () => {
    const run = fixtureRun();
    const failing = run.scenarios[0].results[1];
    failing.screenshots = { expected: 'screenshots/card-750.png' };
    failing.itemScreenshots = { expected: 'screenshots/card-items.png' };
    const otherExcess = {
      ...failing,
      screenshots: { expected: 'screenshots/card-500.png' },
      itemScreenshots: { expected: 'screenshots/card-items.png' },
    };
    run.scenarios[0].results.push(otherExcess);
    const files = evidenceEntries(run, config)
      .entries.filter(entry => entry.group === 'Failing')
      .map(entry => entry.file);
    expect(files).toEqual([
      'screenshots/card-750.png',
      'screenshots/card-items.png',
      'screenshots/card-500.png',
    ]);
  });

  it('labels a selected items screenshot with its card and fund', () => {
    const run = fixtureRun();
    const failing = run.scenarios[0].results[1];
    failing.screenshots = { actual: 'screenshots/card.png' };
    failing.itemScreenshots = { actual: 'screenshots/card-items.png' };
    const entry = evidenceEntries(run, config).entries.find(
      item => item.file === 'screenshots/card-items.png',
    );
    expect(entry.label).toMatch(/\. ItsMy, selected items$/);
    expect(entry).not.toHaveProperty('items');
  });

  it('embeds at most 100 failing screenshots and counts the rest', () => {
    const run = fixtureRun();
    const failing = run.scenarios[0].results[1];
    run.scenarios[0].results = Array.from({ length: 60 }, () => failing);
    const { entries, more } = evidenceEntries(run, config);
    expect(entries.filter(entry => entry.group === 'Failing')).toHaveLength(100);
    expect(more).toBe(20);
  });

  it('puts whole pages of failing searches, then sample passes, in their own group', () => {
    const run = fixtureRun();
    run.scenarios[0].screenshot = 'screenshots/failing-page.png';
    const passes = Array.from({ length: 10 }, (_, index) => ({
      ...run.scenarios[0],
      id: `pass-${index}`,
      results: [{ ...run.scenarios[0].results[0], status: 'match' }],
      screenshot: `screenshots/pass-${index}.png`,
    }));
    run.scenarios.push(...passes);
    const labels = evidenceEntries(run, config)
      .entries.filter(entry => entry.group === 'Whole pages')
      .map(entry => entry.label);
    expect(labels[0]).toBe(`Failing search, whole page: ${run.scenarios[0].id}`);
    expect(labels.slice(1)).toEqual(
      Array.from({ length: 8 }, (_, index) => `Sample pass, whole page: pass-${index}`),
    );
  });

  it('embeds at most 20 failing whole pages and counts the rest', () => {
    const run = fixtureRun();
    const failingPages = Array.from({ length: 25 }, (_, index) => ({
      ...run.scenarios[0],
      id: `failing-${index}`,
      screenshot: `screenshots/failing-${index}.png`,
    }));
    run.scenarios.push(...failingPages);
    const { entries, morePages } = evidenceEntries(run, config);
    expect(entries.filter(entry => entry.group === 'Whole pages')).toHaveLength(20);
    expect(morePages).toBe(5);
  });

  it('leaves the whole page of a failed search to the failed searches group', () => {
    const run = fixtureRun();
    const errored = run.scenarios.find(scenario => scenario.status === 'error');
    errored.screenshot = 'screenshots/error-page.png';
    const pages = evidenceEntries(run, config).entries.filter(
      entry => entry.group === 'Whole pages',
    );
    expect(pages).toEqual([]);
  });

  it('labels each side of a two-environment run with its fund and environment', () => {
    const run = twoEnvironmentRun();
    const [scenario] = run.scenarios;
    scenario.screenshot = null;
    scenario.pageScreenshots = {
      expected: 'screenshots/vic-expected-page.png',
      actual: 'screenshots/vic-actual-page.png',
    };
    scenario.results[1].screenshots = { actual: 'screenshots/card-actual.png' };
    const { entries } = evidenceEntries(run, run.config);
    const pages = entries.filter(entry => entry.group === 'Whole pages');
    expect(pages).toEqual([
      {
        group: 'Whole pages',
        file: 'screenshots/vic-expected-page.png',
        label: `Failing search, whole page: ${scenario.id}. Phoenix Health Fund on localhost:3001`,
      },
      {
        group: 'Whole pages',
        file: 'screenshots/vic-actual-page.png',
        label: `Failing search, whole page: ${scenario.id}. Phoenix Test on localhost:3000`,
      },
    ]);
    const card = entries.find(entry => entry.file === 'screenshots/card-actual.png');
    expect(card.label).toMatch(/\. Phoenix Test on localhost:3000$/);
  });
});

describe('runDetails', () => {
  it('lists when the run was re-run and resumed, with how many searches each ran', () => {
    const run = {
      ...fixtureRun(),
      reruns: [{ startedAt: '2026-10-21T09:00:00.000Z', searches: 11 }],
      resumes: [{ startedAt: '2026-10-20T06:19:45.910Z' }],
    };
    const details = Object.fromEntries(runDetails(run, runTotals(run.scenarios)));
    expect(details['Re-runs']).toBe('2026-10-21T09:00:00.000Z (11 searches)');
    expect(details.Resumes).toBe('2026-10-20T06:19:45.910Z');
  });

  it('shows one environment and lead for a single-environment run', () => {
    const run = fixtureRun();
    const details = Object.fromEntries(runDetails(run, runTotals(run.scenarios)));
    expect(details.Environment).toBe('http://localhost:3000');
    expect(details['Lead id']).toBe('1000000000000000001');
    expect(details).not.toHaveProperty('Expected environment');
  });

  it("shows each side's environment and lead in two-environment mode", () => {
    const run = twoEnvironmentRun();
    const details = Object.fromEntries(runDetails(run, runTotals(run.scenarios)));
    expect(details).toMatchObject({
      'Expected environment': 'http://localhost:3001',
      'Actual environment': 'http://localhost:3000',
      'Expected lead id': 'prod-lead',
      'Actual lead id': 'dev-lead',
    });
    expect(details).not.toHaveProperty('Environment');
    expect(details).not.toHaveProperty('Lead id');
  });
});

describe('duration', () => {
  const timed = (extra = {}) => ({
    startedAt: '2026-10-20T00:00:00.000Z',
    finishedAt: '2026-10-20T22:30:00.000Z',
    scenarios: [{ seconds: 3000 }, { seconds: 1200 }],
    ...extra,
  });

  it('measures a single run from start to finish', () => {
    expect(duration(timed())).toBe('22h 30m');
  });

  it('adds up search time for a resumed or re-run run, leaving out the gaps between sessions', () => {
    expect(duration(timed({ resumes: [{ startedAt: '2026-10-20T05:00:00.000Z' }] }))).toBe(
      '1h 10m of searches',
    );
    expect(duration(timed({ reruns: [{ startedAt: '2026-10-20T06:00:00.000Z' }] }))).toBe(
      '1h 10m of searches',
    );
  });

  it('says a run that never finished is not finished', () => {
    expect(duration(timed({ finishedAt: null }))).toBe('not finished');
  });
});

describe('verdict', () => {
  it('names every field that was compared when the run passes', () => {
    const run = fixtureRun();
    const clean = {
      ...run,
      scenarios: [{ ...run.scenarios[0], results: [run.scenarios[0].results[0]], rateRowCount: 1 }],
    };
    expect(verdict(clean, runTotals(clean.scenarios))).toBe(
      'All 1 rate file rows show the same product name, price, base premium, rebate, LHC, discounts and hospital items for both funds.',
    );
  });

  it('passes a run whose other rows are closed products hidden on both funds, and says how many', () => {
    const run = fixtureRun();
    const [first] = run.scenarios;
    const hidden = { key: 'VSGT|VIC|single|hospital|0', rateRow: { notSold: true }, status: 'not-sold' };
    const clean = {
      ...run,
      scenarios: [{ ...first, results: [first.results[0], hidden], rateRowCount: 2 }],
    };
    const totals = runTotals(clean.scenarios);
    expect(passed(clean, totals)).toBe(true);
    expect(verdict(clean, totals)).toBe(
      'All 2 rate file rows show the same product name, price, base premium, rebate, LHC, discounts and hospital items for both funds. ' +
        '1 row of those are closed products not sold through the fund channel, hidden on both as expected.',
    );
  });

  it('counts the variation rows apart from the rate file rows when the run passes', () => {
    const run = fixtureRun();
    const [first] = run.scenarios;
    const matchOnly = { ...first, results: [first.results[0]], rateRowCount: 1 };
    const clean = {
      ...run,
      scenarios: [
        matchOnly,
        { ...matchOnly, id: 'VIC-single-hospital-age65-tier3-nolhc', set: 'variations' },
        { ...matchOnly, id: 'VIC-single-hospital-age30-none-nolhc', set: 'variations' },
      ],
    };
    expect(verdict(clean, runTotals(clean.scenarios))).toBe(
      'All 1 rate file rows show the same product name, price, base premium, rebate, LHC, discounts and hospital items for both funds, ' +
        'and so do 2 rows rechecked across 2 rebate and LHC variations.',
    );
  });

  it('says how many rows passed only because of a listed product rename', () => {
    const run = fixtureRun();
    const [first] = run.scenarios[0].results;
    const renamed = {
      ...first,
      actual: { ...first.actual, productName: 'New name' },
      expectedDifferences: [
        { field: 'product name', expected: 'S3P-V product', actual: 'New name', deltaCents: null },
      ],
    };
    const clean = {
      ...run,
      scenarios: [{ ...run.scenarios[0], results: [renamed], rateRowCount: 1 }],
    };
    expect(verdict(clean, runTotals(clean.scenarios))).toBe(
      'All 1 rate file rows show the same price, base premium, rebate, LHC, discounts and hospital items for both funds. ' +
        'Product names match apart from 1 listed rename (all seen, 1 row).',
    );
  });

  it('says how many listed renames the run saw when some never showed', () => {
    const run = fixtureRun();
    const [first] = run.scenarios[0].results;
    const renamed = {
      ...first,
      actual: { ...first.actual, productName: 'New name' },
      expectedDifferences: [
        { field: 'product name', expected: 'S3P-V product', actual: 'New name', deltaCents: null },
      ],
    };
    const clean = {
      ...run,
      config: {
        ...run.config,
        expectedNameDifferences: [
          { expected: 'S3P-V product', actual: 'New name' },
          { expected: 'Unused', actual: 'Never shown' },
        ],
      },
      scenarios: [{ ...run.scenarios[0], results: [renamed], rateRowCount: 1 }],
    };
    expect(verdict(clean, runTotals(clean.scenarios))).toContain(
      'Product names match apart from 2 listed renames (1 seen in this run, 1 row).',
    );
  });

  it('says how many rows are off when the run fails', () => {
    const run = fixtureRun();
    expect(verdict(run, runTotals(run.scenarios))).toBe(
      '3 of 5 rate file rows are not the same for both funds, 1 unexpected card, 1 search errored.',
    );
  });
});

describe('expectedDifferenceLines', () => {
  it('groups listed renames by product and flags the ones the run never saw', () => {
    const run = fixtureRun();
    const [first] = run.scenarios[0].results;
    const rename = {
      field: 'product name',
      expected: 'S3P-V product',
      actual: 'New name',
      deltaCents: null,
    };
    run.config.expectedNameDifferences = [
      { code: 's3p-v', expected: 'S3P-V product', actual: 'New  name' },
      { code: 'GONE', expected: 'Old', actual: 'New' },
    ];
    run.scenarios[0].results = [{ ...first, expectedDifferences: [rename] }];
    run.scenarios[1] = {
      ...run.scenarios[1],
      results: [{ ...first, expectedDifferences: [rename] }],
    };
    expect(expectedDifferenceLines(run)).toEqual([
      {
        code: 'GONE',
        expected: 'Old',
        actual: 'New',
        rows: 0,
        searches: 0,
        seen: 'Not seen in this run',
      },
      {
        code: 'S3P-V',
        expected: 'S3P-V product',
        actual: 'New  name',
        rows: 2,
        searches: 2,
        seen: 'Seen',
      },
    ]);
  });
});

describe('expectedDifferenceLines without codes', () => {
  it('counts every product showing a code-less rename on that one line', () => {
    const run = fixtureRun();
    const [first] = run.scenarios[0].results;
    const rename = { field: 'product name', expected: 'Old', actual: 'New', deltaCents: null };
    run.config.expectedNameDifferences = [{ expected: 'Old', actual: 'New' }];
    run.scenarios[0].results = [
      { ...first, expectedDifferences: [rename] },
      { ...first, key: 'OTHER|VIC|single|hospital|750', expectedDifferences: [rename] },
    ];
    expect(expectedDifferenceLines(run)).toEqual([
      { code: 'Any', expected: 'Old', actual: 'New', rows: 2, searches: 1, seen: 'Seen' },
    ]);
  });
});

// The fixture as if INC A raised S3P-V and S3J-V and left S31P-V as loaded in the full load.
const movedRun = () => {
  const run = fixtureRun();
  const movement = {
    'S3P-V': { movement: 'increase', previousPremiumCents: 10520, sourceFile: 'inc-a.xlsx' },
    'S3J-V': { movement: 'increase', previousPremiumCents: 13110, sourceFile: 'inc-a.xlsx' },
    'S31P-V': { movement: 'not in increment', previousPremiumCents: null },
  };
  for (const scenario of run.scenarios) {
    scenario.results = (scenario.results ?? []).map(result =>
      result.rateRow
        ? { ...result, rateRow: { ...result.rateRow, ...movement[result.rateRow.fundProductCode] } }
        : result,
    );
  }
  return run;
};

describe('price movement', () => {
  it('counts the full sweep rows per movement class', () => {
    expect(movementCounts(movedRun())).toEqual({
      increase: 2,
      decrease: 0,
      rounding: 0,
      unchanged: 0,
      'new product': 0,
      'not in increment': 1,
    });
    expect(movementSummary(movedRun())).toBe('2 rows moved (2 increases, 0 decreases, 0 rounding)');
  });

  it('groups moved rows by product with the change range and how many matched on both funds', () => {
    expect(movementLines(movedRun())).toEqual([
      {
        product: 'Itsmy Basic Hospital',
        movement: 'increase',
        rows: 1,
        smallestChange: 1.58,
        largestChange: 1.58,
        smallestPercent: 1.5,
        largestPercent: 1.5,
        matchedOnBoth: 1,
      },
      {
        product: 'Itsmy Bronze Hospital',
        movement: 'increase',
        rows: 1,
        smallestChange: 1.97,
        largestChange: 1.97,
        smallestPercent: 1.5,
        largestPercent: 1.5,
        matchedOnBoth: 0,
      },
    ]);
  });

  it('reports no movement for a run with only a full load', () => {
    expect(movementSummary(fixtureRun())).toBeNull();
    expect(movementLines(fixtureRun())).toEqual([]);
  });

  it('adds the movement to the verdict', () => {
    const run = movedRun();
    const clean = {
      ...run,
      scenarios: [{ ...run.scenarios[0], results: [run.scenarios[0].results[0]], rateRowCount: 1 }],
    };
    expect(verdict(clean, runTotals(clean.scenarios))).toMatch(
      / 1 row moved \(1 increase, 0 decreases, 0 rounding\), all shown on both funds\.$/,
    );
    expect(verdict(run, runTotals(run.scenarios))).toMatch(
      / 2 rows moved \(2 increases, 0 decreases, 0 rounding\)\.$/,
    );
  });

  it('writes a Price movement sheet, movement columns and a summary section', async () => {
    fs.mkdirSync(path.join(directory, 'screenshots'), { recursive: true });
    const report = await writeReport(directory, movedRun());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(report.workbook);
    expect(workbook.worksheets.map(sheet => sheet.name)).toContain('Price movement');
    const allRows = sheetValues(workbook.getWorksheet('All rows'));
    const header = allRows[1];
    const at = name => header.indexOf(name);
    expect(header.slice(at('File price'), at('File price') + 6)).toEqual([
      'File price',
      'Previous premium',
      'Change',
      'Change %',
      'Movement',
      'Source file',
    ]);
    const s3p = allRows.find(values => values[2] === 'S3P-V');
    expect(s3p.slice(at('Previous premium'), at('Source file') + 1)).toEqual([
      105.2,
      1.58,
      1.5,
      'increase',
      'inc-a.xlsx',
    ]);
    const html = fs.readFileSync(report.summary, 'utf8');
    expect(html).toContain('Price movement (full sweep)');
    expect(html).toContain('+1.50%');
  });

  it('leaves the movement columns and sheet out of a run with only a full load', async () => {
    fs.mkdirSync(path.join(directory, 'screenshots'), { recursive: true });
    const report = await writeReport(directory, fixtureRun());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(report.workbook);
    expect(workbook.worksheets.map(sheet => sheet.name)).not.toContain('Price movement');
    expect(sheetValues(workbook.getWorksheet('All rows'))[1]).not.toContain('Previous premium');
    expect(fs.readFileSync(report.summary, 'utf8')).not.toContain('Price movement');
  });
});

describe('writeReport', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(directory, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'screenshots', 's3j-expected.png'), PNG);
  });

  it('writes a workbook with every sheet and the headline counts', async () => {
    const report = await writeReport(directory, fixtureRun());
    expect(report.passed).toBe(false);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(report.workbook);
    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual([
      'Summary',
      'Differences',
      'Expected differences',
      'Missing',
      'Unexpected',
      'All rows',
      'Benefits',
      'Variation differences',
      'Variation rows',
      'Errors',
      'Evidence',
    ]);

    const summary = Object.fromEntries(
      sheetValues(workbook.getWorksheet('Summary')).map(([name, ...values]) => [name, values]),
    );
    expect(summary).not.toHaveProperty('Script version');
    expect(summary).toMatchObject({
      Result: ['FAIL'],
      Verdict: [expect.stringContaining('3 of 5 rate file rows')],
      'Lead id': ['1000000000000000001'],
      'Re-run of': ['output/local-20261019-130634/results.json'],
      'Run time': ['5m'],
      // Full sweep, then variations.
      'Rate file rows checked': [3, 2],
      Match: [1, 1],
      Differ: [1, 1],
      'Missing itsmy': [1, 0],
      'Unexpected cards': [1, 0],
      'Searches errored': [1, 0],
      // The coverage grid: one search ran and one errored, both for single hospital.
      VIC: ['✗ 3 of 3'],
      WA: ['error'],
    });

    expect(workbook.getWorksheet('Differences').rowCount).toBe(4);
    expect(workbook.getWorksheet('Differences').getRow(2).getCell(14).value).toEqual({
      text: 's3j-expected.png',
      hyperlink: 'screenshots/s3j-expected.png',
    });
    expect(workbook.getWorksheet('Missing').rowCount).toBe(2);
    expect(workbook.getWorksheet('Missing').getRow(2).getCell(1).value).toBe('Missing in ItsMy');
    expect(workbook.getWorksheet('Unexpected').rowCount).toBe(2);
    expect(sheetValues(workbook.getWorksheet('Variation differences')).map(row => row[7])).toEqual([
      'Field',
      'price',
      'LHC',
    ]);
    expect(workbook.getWorksheet('Variation differences').getRow(2).getCell(7).value).toBe(
      'age 40 · rebate base · LHC age 35',
    );
    expect(workbook.getWorksheet('Errors').getRow(2).getCell(4).value).toBe(
      'Results did not finish loading within 90s',
    );
  });

  it('shows every field for both funds side by side in All rows and Variation rows', async () => {
    const report = await writeReport(directory, fixtureRun());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(report.workbook);
    const allRows = sheetValues(workbook.getWorksheet('All rows'));
    // Two header rows, then the four full sweep results.
    expect(allRows).toHaveLength(6);
    expect(allRows[0].slice(7, 13)).toEqual([
      'Product name',
      'Product name',
      'Product name',
      'Price',
      'Price',
      'Price',
    ]);
    expect(allRows[1].slice(7, 10)).toEqual(['see-u by HBF', 'ItsMy', 'Same']);
    expect(allRows[2].slice(0, 25)).toEqual([
      'Match',
      'Itsmy Basic Hospital',
      'S3P-V',
      'VIC',
      'single',
      'hospital',
      750,
      'S3P-V product',
      'S3P-V product',
      '✓',
      81.03,
      81.03,
      '✓',
      106.03,
      106.03,
      '✓',
      25,
      25,
      '✓',
      0,
      0,
      '✓',
      'None',
      'None',
      '✓',
    ]);
    // S3J-V differs on price, base premium and one hospital item, so those are marked.
    expect(allRows[3][12]).toBe('✗');
    expect(allRows[3][15]).toBe('✗');
    expect(allRows[3][25]).toBe('0/1 same');

    const variationRows = sheetValues(workbook.getWorksheet('Variation rows'));
    expect(variationRows).toHaveLength(4);
    expect(variationRows[2][7]).toBe('age 40 · rebate base · LHC age 35');
  });

  it('lists the benefits and embeds the screenshots that exist', async () => {
    const report = await writeReport(directory, fixtureRun());
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(report.workbook);
    expect(sheetValues(workbook.getWorksheet('Benefits'))).toEqual([
      ['Product', 'Type', 'Item', 'see-u by HBF', 'ItsMy', 'Same', 'States', 'Rows'],
      [
        'Itsmy Basic Hospital',
        'Hospital',
        'Cataracts',
        'not covered',
        'not covered',
        '✓',
        'VIC',
        1,
      ],
      [
        'Itsmy Bronze Hospital',
        'Hospital',
        'Cataracts',
        'not covered',
        'not covered',
        '✓',
        'VIC',
        1,
      ],
    ]);
    const evidence = workbook.getWorksheet('Evidence');
    expect(evidence.getImages()).toHaveLength(1);
    expect(sheetValues(evidence).flat()).toContain('Failing');
    expect(sheetValues(evidence).flat()).toContain(
      'Differs: Itsmy Bronze Hospital (S3J-V), excess 750, VIC single hospital. see-u by HBF',
    );
  });

  it('writes a summary page that states the result first and links the evidence', async () => {
    const report = await writeReport(directory, fixtureRun());
    const html = fs.readFileSync(report.summary, 'utf8');
    expect(html.indexOf('FAIL')).toBeLessThan(html.indexOf('<h2>'));
    expect(html).toContain('3 of 5 rate file rows are not the same for both funds');
    expect(html).toContain('5 rows checked: 2 match, 2 differ');
    expect(html).toContain('What was checked (full sweep)');
    expect(html).toContain('Coverage (full sweep)');
    expect(html).toContain('Variations: rows that do not match');
    expect(html).toContain('age 40 · rebate base · LHC age 35');
    expect(html).toContain('1 unexpected cards, 1 search errored');
    expect(html).toContain('<img src="screenshots/s3j-expected.png"');
    expect(html).not.toContain('<img src="screenshots/s3j-actual.png"');
    expect(html).toContain('href="screenshots/wa-error.png"');
    expect(html).toContain(`href="${path.basename(report.workbook)}"`);
    expect(html).toContain('@media print');
  });

  it('shows whole pages in their own cropped group on the summary page', async () => {
    const run = fixtureRun();
    run.scenarios[0].screenshot = 'screenshots/failing-page.png';
    fs.mkdirSync(path.join(directory, 'screenshots'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'screenshots/failing-page.png'), '');
    const html = fs.readFileSync((await writeReport(directory, run)).summary, 'utf8');
    expect(html).toContain('<h3>Whole pages</h3><div class="evidence pages">');
    expect(html).toContain('href="screenshots/failing-page.png"');
  });

  it('leaves out the sections of a set that did not run', async () => {
    const run = fixtureRun();
    const variationsOnly = {
      ...run,
      scenarios: run.scenarios.filter(scenario => scenario.set === 'variations'),
    };
    const html = fs.readFileSync((await writeReport(directory, variationsOnly)).summary, 'utf8');
    expect(html).not.toContain('What was checked (full sweep)');
    expect(html).toContain('What was checked (variations)');
  });
});

describe('reportOnly', () => {
  it('rebuilds the report from a run folder without running anything', async () => {
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify(fixtureRun()));
    const report = await reportOnly(directory);
    expect(report.passed).toBe(false);
    expect(fs.existsSync(report.workbook)).toBe(true);
    expect(fs.existsSync(report.summary)).toBe(true);
  });
});

describe('writeReport file names', () => {
  it('stamps both files with the time the report was generated', async () => {
    const report = await writeReport(directory, fixtureRun(), new Date(2026, 9, 20, 9, 37, 7));
    expect(path.basename(report.workbook)).toBe('report-20261020-093707.xlsx');
    expect(path.basename(report.summary)).toBe('summary-20261020-093707.html');
  });

  it('keeps the earlier report when it is rebuilt later', async () => {
    const first = await writeReport(directory, fixtureRun(), new Date(2026, 9, 20, 9, 0, 0));
    const second = await writeReport(directory, fixtureRun(), new Date(2026, 9, 20, 10, 0, 0));
    expect(second.workbook).not.toBe(first.workbook);
    expect(fs.existsSync(first.workbook)).toBe(true);
  });
});
