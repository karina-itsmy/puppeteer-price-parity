import { describe, expect, it } from 'vitest';
import { benefitLines, checkSummary, coverageGrid, differencesOf, fieldChecks } from './reportData';

const card = (overrides = {}) => ({
  productName: 'Starter Hospital $750 Excess',
  fundProductCode: 'S3P-V',
  priceCents: 8103,
  basePremiumCents: 10678,
  rebateCents: 2575,
  lhcCents: 0,
  discounts: [],
  hospitalItems: [
    { label: 'Private Hospital', value: 'covered' },
    { label: 'Cataracts', value: 'not covered' },
  ],
  extrasBenefits: null,
  ...overrides,
});

const match = (overrides = {}) => ({
  key: 'S3P-V|VIC|single|hospital|750',
  status: 'match',
  rateRow: { productName: 'Itsmy Basic Hospital' },
  expected: card(),
  actual: card(),
  fieldDifferences: [],
  ...overrides,
});

const difference = match({
  status: 'difference',
  actual: card({
    priceCents: 8182,
    basePremiumCents: 10757,
    hospitalItems: [
      { label: 'Private Hospital', value: 'covered' },
      { label: 'Cataracts', value: 'covered' },
    ],
  }),
  fieldDifferences: [
    { field: 'price', expected: 8103, actual: 8182, deltaCents: 79 },
    { field: 'base premium', expected: 10678, actual: 10757, deltaCents: 79 },
    { field: 'hospital: Cataracts', expected: 'not covered', actual: 'covered', deltaCents: null },
  ],
});

const byTitle = checks => Object.fromEntries(checks.map(check => [check.title, check]));

const scenario = (state, membershipType, coverType, results, extra = {}) => ({
  id: `${state}-${membershipType}-${coverType}-age40-base-nolhc`,
  set: 'full-sweep',
  search: { state, membershipType, coverType },
  status: 'done',
  rateRowCount: results.length,
  results,
  ...extra,
});

describe('fieldChecks', () => {
  it('marks every field on a matching pair as the same, and fields on neither card as not shown', () => {
    const checks = byTitle(fieldChecks(match()));
    expect(checks.Price).toMatchObject({ expected: 8103, actual: 8103, same: true });
    expect(checks.LHC).toMatchObject({ expected: 0, actual: 0, same: true });
    expect(checks.Discounts).toMatchObject({ total: 0, same: true });
    expect(checks['Hospital items']).toMatchObject({ total: 2, differ: 0, same: true });
    expect(checks['Extras benefits'].same).toBeNull();
  });

  it('marks the fields that differ and counts the benefit items that differ', () => {
    const checks = byTitle(fieldChecks(difference));
    expect(checks.Price.same).toBe(false);
    expect(checks['Base premium'].same).toBe(false);
    expect(checks.Rebate.same).toBe(true);
    expect(checks['Hospital items']).toMatchObject({ total: 2, differ: 1, same: false });
  });

  it('leaves breakdown fields unjudged when a breakdown was not read, but still judges the price', () => {
    const unread = card({
      basePremiumCents: null,
      rebateCents: null,
      lhcCents: null,
      discounts: null,
    });
    const checks = byTitle(
      fieldChecks(
        match({ status: 'breakdown-not-read', expected: unread, breakdownNotRead: ['expected'] }),
      ),
    );
    expect(checks.Price.same).toBe(true);
    expect(checks['Base premium']).toMatchObject({ expected: null, actual: 10678, same: null });
    expect(checks.LHC.same).toBeNull();
    expect(checks.Discounts.same).toBeNull();
    expect(checks['Hospital items'].same).toBe(true);
  });

  it('compares nothing when one fund has no card', () => {
    const checks = fieldChecks({ ...match(), status: 'missing-actual', actual: undefined });
    expect(checks.every(check => check.same === null)).toBe(true);
    expect(byTitle(checks).Price.expected).toBe(8103);
  });
});

describe('fieldChecks product name', () => {
  it('shows both names and flags a listed rename', () => {
    const check = byTitle(
      fieldChecks(
        match({
          actual: card({ productName: 'Itsmy Basic Hospital' }),
          expectedDifferences: [
            {
              field: 'product name',
              expected: 'Starter Hospital $750 Excess',
              actual: 'Itsmy Basic Hospital',
              deltaCents: null,
            },
          ],
        }),
      ),
    )['Product name'];
    expect(check).toMatchObject({
      expected: 'Starter Hospital $750 Excess',
      actual: 'Itsmy Basic Hospital',
      same: false,
      expectedDifference: true,
    });
  });
});

describe('differencesOf', () => {
  it('treats a difference from a run that only compared prices as a price difference', () => {
    const old = { ...difference, fieldDifferences: undefined, deltaCents: 79 };
    expect(differencesOf(old)).toEqual([
      { field: 'price', expected: 8103, actual: 8182, deltaCents: 79 },
    ]);
    expect(byTitle(fieldChecks(old)).Price.same).toBe(false);
  });
});

describe('checkSummary', () => {
  it('counts per field how many paired rows were the same, differed or did not show it', () => {
    const run = {
      scenarios: [
        scenario('VIC', 'single', 'hospital', [
          match(),
          difference,
          { status: 'missing-both', key: 'X' },
        ]),
      ],
    };
    const lines = byTitle(checkSummary(run));
    expect(lines.Price).toMatchObject({ rowsCompared: 2, same: 1, differ: 1, notShown: 0 });
    expect(lines.Rebate).toMatchObject({ rowsCompared: 2, same: 2, differ: 0 });
    expect(lines['Hospital items']).toMatchObject({ itemsCompared: 4, itemsDiffer: 1 });
    expect(lines['Extras benefits']).toMatchObject({ rowsCompared: 0, notShown: 2 });
  });

  it('counts product names that differ apart from listed renames', () => {
    const renamed = match({
      actual: card({ productName: 'Itsmy Basic Hospital' }),
      expectedDifferences: [
        {
          field: 'product name',
          expected: 'Starter Hospital $750 Excess',
          actual: 'Itsmy Basic Hospital',
          deltaCents: null,
        },
      ],
    });
    const unlisted = match({
      status: 'difference',
      actual: card({ productName: 'Something Else' }),
      fieldDifferences: [
        {
          field: 'product name',
          expected: 'Starter Hospital $750 Excess',
          actual: 'Something Else',
          deltaCents: null,
        },
      ],
    });
    const run = {
      scenarios: [scenario('VIC', 'single', 'hospital', [match(), renamed, unlisted])],
    };
    expect(byTitle(checkSummary(run))['Product name']).toMatchObject({
      rowsCompared: 3,
      same: 1,
      differ: 1,
      expectedDiffer: 1,
    });
  });
});

describe('coverageGrid', () => {
  it('lays the full sweep out by state and membership type × cover type', () => {
    const run = {
      scenarios: [
        scenario('VIC', 'single', 'hospital', [match(), difference]),
        scenario('NSW', 'family', 'combined', [match()]),
        scenario('NSW', 'single', 'hospital', [], { status: 'error', rateRowCount: 3 }),
        { ...scenario('VIC', 'single', 'extras', [match()]), set: 'variations' },
      ],
    };
    expect(coverageGrid(run)).toEqual({
      columns: ['single hospital', 'family combined'],
      rows: [
        {
          state: 'NSW',
          cells: [
            { status: 'error', rows: 3, issues: null },
            { status: 'pass', rows: 1, issues: 0 },
          ],
        },
        { state: 'VIC', cells: [{ status: 'fail', rows: 2, issues: 1 }, null] },
      ],
    });
  });
});

describe('benefitLines', () => {
  it('lists each product once per set of benefit values, with the states it was seen in', () => {
    const run = {
      scenarios: [
        scenario('VIC', 'single', 'hospital', [match()]),
        scenario('NSW', 'single', 'hospital', [match()]),
        scenario('QLD', 'single', 'hospital', [difference]),
      ],
    };
    const lines = benefitLines(run);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toEqual({
      product: 'Itsmy Basic Hospital',
      type: 'Hospital',
      item: 'Cataracts',
      expected: 'not covered',
      actual: 'not covered',
      same: true,
      states: 'NSW, VIC',
      rows: 2,
    });
    expect(lines[3]).toMatchObject({
      item: 'Cataracts',
      actual: 'covered',
      same: false,
      states: 'QLD',
    });
  });
});
