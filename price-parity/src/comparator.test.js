import { describe, expect, it } from 'vitest';
import {
  compareWithRateFile,
  fieldDifferences,
  formatCents,
  isPassingStatus,
  parseMoney,
  summarise,
} from './comparator';

const search = { state: 'VIC', membershipType: 'single', coverType: 'hospital' };

const rateRow = overrides => ({
  ...search,
  rowNumber: 2,
  fundProductCode: 'S31P-V',
  excess: 750,
  monthlyPremiumCents: 10234,
  ...overrides,
});

const card = overrides => ({
  ...search,
  fundProductCode: 'S31P-V',
  excess: '750',
  productName: 'Starter Hospital $750 Excess',
  priceText: '$102.34',
  priceCents: 10234,
  ...overrides,
});

const statuses = results => results.map(result => result.status);

describe('parseMoney', () => {
  it('reads displayed prices into cents', () => {
    expect(parseMoney('$102.34')).toBe(10234);
    expect(parseMoney('$1,234.5')).toBe(123450);
    expect(parseMoney('$87')).toBe(8700);
  });

  it('returns null for text that is not a price', () => {
    expect(parseMoney('$***')).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
});

describe('formatCents', () => {
  it('shows the sign and two decimals', () => {
    expect(formatCents(79)).toBe('$0.79');
    expect(formatCents(-1)).toBe('-$0.01');
    expect(formatCents(null)).toBe('n/a');
  });
});

describe('compareWithRateFile', () => {
  it('reports a match when both funds show the same price', () => {
    const [result] = compareWithRateFile([rateRow()], [card()], [card()]);
    expect(result.status).toBe('match');
    expect(result.deltaCents).toBe(0);
  });

  it('reports a one-cent difference with its delta', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card()],
      [card({ priceText: '$102.35', priceCents: 10235 })],
    );
    expect(result.status).toBe('difference');
    expect(result.deltaCents).toBe(1);
  });

  it('pairs cards whose product names differ, and reports the name as a difference', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ productName: 'Starter Hospital $750 Excess' })],
      [card({ productName: 'Itsmy Basic Hospital $750' })],
    );
    expect(result.status).toBe('difference');
    expect(result.fieldDifferences).toEqual([
      {
        field: 'product name',
        expected: 'Starter Hospital $750 Excess',
        actual: 'Itsmy Basic Hospital $750',
        deltaCents: null,
      },
    ]);
  });

  it('ignores spacing differences in product names', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ productName: 'Starter  Hospital $750 Excess ' })],
      [card({ productName: 'Starter Hospital $750 Excess' })],
    );
    expect(result.status).toBe('match');
  });

  it('keeps a listed rename out of the differences, so the row matches', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ productName: 'Starter Hospital $750 Excess' })],
      [card({ productName: 'Itsmy Basic Hospital $750' })],
      [
        {
          code: 's31p-v',
          expected: 'Starter Hospital $750 Excess',
          actual: 'Itsmy Basic Hospital $750',
        },
      ],
    );
    expect(result.status).toBe('match');
    expect(result.fieldDifferences).toEqual([]);
    expect(result.expectedDifferences).toEqual([
      {
        field: 'product name',
        expected: 'Starter Hospital $750 Excess',
        actual: 'Itsmy Basic Hospital $750',
        deltaCents: null,
      },
    ]);
  });

  it('still fails a listed product when its names differ from the listed rename', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ productName: 'Starter Hospital $750 Excess' })],
      [card({ productName: 'Something Else' })],
      [
        {
          code: 'S31P-V',
          expected: 'Starter Hospital $750 Excess',
          actual: 'Itsmy Basic Hospital $750',
        },
      ],
    );
    expect(result.status).toBe('difference');
    expect(result.expectedDifferences).toBeUndefined();
  });

  it('excuses a rename listed without a code on any product showing that name pair', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ productName: 'Starter Hospital $750 Excess' })],
      [card({ productName: 'Itsmy Basic Hospital $750' })],
      [{ expected: 'Starter Hospital $750 Excess', actual: 'Itsmy Basic Hospital $750' }],
    );
    expect(result.status).toBe('match');
    expect(result.expectedDifferences).toHaveLength(1);
  });

  it('does not excuse a rename listed under another product code', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ productName: 'Starter Hospital $750 Excess' })],
      [card({ productName: 'Itsmy Basic Hospital $750' })],
      [
        {
          code: 'OTHER',
          expected: 'Starter Hospital $750 Excess',
          actual: 'Itsmy Basic Hospital $750',
        },
      ],
    );
    expect(result.status).toBe('difference');
  });

  it('still fails a listed rename row when another field differs', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ productName: 'Starter Hospital $750 Excess' })],
      [card({ productName: 'Itsmy Basic Hospital $750', priceText: '$110.00', priceCents: 11000 })],
      [
        {
          code: 'S31P-V',
          expected: 'Starter Hospital $750 Excess',
          actual: 'Itsmy Basic Hospital $750',
        },
      ],
    );
    expect(result.status).toBe('difference');
    expect(result.fieldDifferences.map(difference => difference.field)).toEqual(['price']);
    expect(result.expectedDifferences).toHaveLength(1);
  });

  it('pairs on fund product code regardless of case and spacing, and "750" with 750', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ excess: '750.00' })],
      [card({ fundProductCode: ' s31p-v ' })],
    );
    expect(result.status).toBe('match');
  });

  it('reports a row missing for one fund', () => {
    expect(statuses(compareWithRateFile([rateRow()], [card()], []))).toEqual(['missing-actual']);
    expect(statuses(compareWithRateFile([rateRow()], [], [card()]))).toEqual(['missing-expected']);
  });

  it('reports a row missing for both funds', () => {
    const [result] = compareWithRateFile([rateRow()], [], []);
    expect(result.status).toBe('missing-both');
    expect(result.rateRow.fundProductCode).toBe('S31P-V');
  });

  it('passes a closed product that neither fund shows, since neither should sell it', () => {
    const [result] = compareWithRateFile([rateRow({ notSold: true })], [], []);
    expect(result.status).toBe('not-sold');
    expect(isPassingStatus(result.status)).toBe(true);
  });

  it('still flags a closed product that one fund shows', () => {
    expect(statuses(compareWithRateFile([rateRow({ notSold: true })], [card()], []))).toEqual([
      'missing-actual',
    ]);
  });

  it('reports cards that match no rate file row as unexpected, per fund', () => {
    const results = compareWithRateFile(
      [rateRow()],
      [card(), card({ fundProductCode: 'OLD-V' })],
      [card(), card({ excess: '500' })],
    );
    expect(results).toEqual([
      expect.objectContaining({ status: 'match' }),
      expect.objectContaining({ status: 'unexpected', side: 'expected' }),
      expect.objectContaining({ status: 'unexpected', side: 'actual' }),
    ]);
  });

  it('gives every rate file row exactly one result', () => {
    const rows = [
      rateRow({ fundProductCode: 'A' }),
      rateRow({ fundProductCode: 'B' }),
      rateRow({ fundProductCode: 'C' }),
      rateRow({ fundProductCode: 'D' }),
    ];
    const results = compareWithRateFile(
      rows,
      [card({ fundProductCode: 'A' }), card({ fundProductCode: 'B' })],
      [card({ fundProductCode: 'A', priceCents: 1 }), card({ fundProductCode: 'C' })],
    );
    expect(results.map(result => [result.rateRow.fundProductCode, result.status])).toEqual([
      ['A', 'difference'],
      ['B', 'missing-actual'],
      ['C', 'missing-expected'],
      ['D', 'missing-both'],
    ]);
  });

  it('checks a key once when the rate file repeats it', () => {
    const results = compareWithRateFile([rateRow(), rateRow({ rowNumber: 3 })], [card()], [card()]);
    expect(statuses(results)).toEqual(['match']);
  });

  it('reports a key shown twice by one fund as a duplicate instead of pairing it', () => {
    const [result] = compareWithRateFile([rateRow()], [card(), card()], [card()]);
    expect(result.status).toBe('duplicate');
    expect(result.expectedCards).toHaveLength(2);
  });

  it('reports a difference when one price cannot be read', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card()],
      [card({ priceText: '$***', priceCents: null })],
    );
    expect(result.status).toBe('difference');
    expect(result.deltaCents).toBeNull();
  });

  it('reports price not read, not a difference or a match, when neither price can be read', () => {
    const unreadPrice = { priceText: '$***', priceCents: null };
    const [result] = compareWithRateFile([rateRow()], [card(unreadPrice)], [card(unreadPrice)]);
    expect(result.status).toBe('price-not-read');
    expect(result.fieldDifferences).toEqual([]);
  });

  it('still reports a difference elsewhere when neither price can be read', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card({ priceCents: null, rebateCents: 100 })],
      [card({ priceCents: null, rebateCents: 200 })],
    );
    expect(result.status).toBe('difference');
    expect(result.fieldDifferences.map(difference => difference.field)).toEqual(['rebate']);
  });
});

// A card with everything the customer can see: price breakdown and benefits.
const fullCard = overrides =>
  card({
    basePremiumCents: 13110,
    rebateCents: 3184,
    lhcCents: null,
    discounts: [{ label: 'Direct debit', value: 192 }],
    hospitalItems: [
      { label: 'Heart and vascular system', value: 'Covered' },
      { label: 'Joint replacements', value: 'Restricted' },
    ],
    extrasBenefits: [{ label: 'General dental', value: '60% back, $500 a year' }],
    ...overrides,
  });

describe('fieldDifferences', () => {
  it('finds nothing when every field is the same', () => {
    expect(fieldDifferences(fullCard(), fullCard())).toEqual([]);
  });

  it('reports a one-cent money difference with its delta', () => {
    expect(fieldDifferences(fullCard(), fullCard({ rebateCents: 3185 }))).toEqual([
      { field: 'rebate', expected: 3184, actual: 3185, deltaCents: 1 },
    ]);
  });

  it('reports a benefit whose text differs, with no delta', () => {
    const actual = fullCard({
      extrasBenefits: [{ label: 'General dental', value: '60% back, $450 a year' }],
    });
    expect(fieldDifferences(fullCard(), actual)).toEqual([
      {
        field: 'extras: General dental',
        expected: '60% back, $500 a year',
        actual: '60% back, $450 a year',
        deltaCents: null,
      },
    ]);
  });

  it('reports a field shown by one fund only', () => {
    expect(fieldDifferences(fullCard(), fullCard({ lhcCents: 262 }))).toEqual([
      { field: 'LHC', expected: null, actual: 262, deltaCents: null },
    ]);
    const actual = fullCard({ hospitalItems: [fullCard().hospitalItems[0]] });
    expect(fieldDifferences(fullCard(), actual)).toEqual([
      {
        field: 'hospital: Joint replacements',
        expected: 'Restricted',
        actual: null,
        deltaCents: null,
      },
    ]);
  });

  it('matches list items by label, not by position', () => {
    const reversed = fullCard({ hospitalItems: [...fullCard().hospitalItems].reverse() });
    expect(fieldDifferences(fullCard(), reversed)).toEqual([]);
  });

  it('skips fields neither card shows', () => {
    expect(fieldDifferences(card(), card())).toEqual([]);
  });

  it('lists the displayed price first when several fields differ', () => {
    const actual = fullCard({ priceCents: 10235, basePremiumCents: 13111 });
    expect(fieldDifferences(fullCard(), actual).map(difference => difference.field)).toEqual([
      'price',
      'base premium',
    ]);
  });
});

describe('compareWithRateFile, every card field', () => {
  it('reports a difference when the price matches but another field does not', () => {
    const [result] = compareWithRateFile(
      [rateRow({ monthlyPremiumCents: 13110 })],
      [fullCard()],
      [fullCard({ discounts: [{ label: 'Direct debit', value: 191 }] })],
    );
    expect(result.status).toBe('difference');
    expect(result.deltaCents).toBe(0);
    expect(result.fieldDifferences).toEqual([
      { field: 'discount: Direct debit', expected: 192, actual: 191, deltaCents: -1 },
    ]);
  });
});

describe('summarise', () => {
  it('counts results by status', () => {
    const results = compareWithRateFile(
      [rateRow(), rateRow({ fundProductCode: 'A' }), rateRow({ fundProductCode: 'B' })],
      [card(), card({ fundProductCode: 'A' })],
      [card(), card({ fundProductCode: 'A', priceCents: 1 })],
    );
    expect(summarise(results)).toEqual({ match: 1, difference: 1, 'missing-both': 1 });
  });
});

describe('compareWithRateFile when a price breakdown was not read', () => {
  const read = {
    breakdownRead: true,
    basePremiumCents: 27059,
    rebateCents: 6526,
    lhcCents: 0,
    discounts: [],
  };
  const unread = {
    breakdownRead: false,
    basePremiumCents: null,
    rebateCents: null,
    lhcCents: null,
    discounts: null,
  };

  it('reports the row as breakdown not read instead of a difference when everything else matches', () => {
    const [result] = compareWithRateFile([rateRow()], [card(unread)], [card(read)]);
    expect(result.status).toBe('breakdown-not-read');
    expect(result.breakdownNotRead).toEqual(['expected']);
    expect(result.fieldDifferences).toEqual([]);
  });

  it('still reports a price difference, leaving the unread breakdown fields out', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card(unread)],
      [card({ ...read, priceText: '$102.35', priceCents: 10235 })],
    );
    expect(result.status).toBe('difference');
    expect(result.fieldDifferences.map(difference => difference.field)).toEqual(['price']);
    expect(result.breakdownNotRead).toEqual(['expected']);
  });

  it('names both sides when neither breakdown was read', () => {
    const [result] = compareWithRateFile([rateRow()], [card(unread)], [card(unread)]);
    expect(result.breakdownNotRead).toEqual(['expected', 'actual']);
  });

  it('compares the breakdown as before when both cards were read', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card(read)],
      [card({ ...read, rebateCents: 6527 })],
    );
    expect(result.status).toBe('difference');
    expect(result).not.toHaveProperty('breakdownNotRead');
  });
});

describe('compareWithRateFile against the rate file premium', () => {
  const breakdown = basePremiumCents => ({
    breakdownRead: true,
    basePremiumCents,
    rebateCents: 0,
    lhcCents: 0,
    discounts: [],
  });

  it('matches when both base premiums equal the file premium', () => {
    const [result] = compareWithRateFile(
      [rateRow({ monthlyPremiumCents: 13110 })],
      [card(breakdown(13110))],
      [card(breakdown(13110))],
    );
    expect(result.status).toBe('match');
  });

  it('reports a difference when both funds agree but are off the file', () => {
    const [result] = compareWithRateFile(
      [rateRow({ monthlyPremiumCents: 13110 })],
      [card(breakdown(13228))],
      [card(breakdown(13228))],
    );
    expect(result.status).toBe('difference');
    expect(result.fieldDifferences).toEqual([
      { field: 'rate file', expected: 13228, actual: 13228, deltaCents: null },
    ]);
  });

  it('reports a difference when one fund is off the file', () => {
    const [result] = compareWithRateFile(
      [rateRow({ monthlyPremiumCents: 13110 })],
      [card(breakdown(13110))],
      [card(breakdown(13111))],
    );
    expect(result.fieldDifferences.map(difference => difference.field)).toEqual([
      'base premium',
      'rate file',
    ]);
  });

  it('leaves the file check out when a breakdown was not read', () => {
    const [result] = compareWithRateFile(
      [rateRow({ monthlyPremiumCents: 13110 })],
      [card({ breakdownRead: false, basePremiumCents: null })],
      [card(breakdown(13228))],
    );
    expect(result.status).toBe('breakdown-not-read');
  });
});

describe('compareWithRateFile when benefits were not read', () => {
  const benefits = {
    benefitsRead: true,
    hospitalItems: [{ label: 'Joint replacements', value: 'Covered' }],
  };
  const unread = { benefitsRead: false, hospitalItems: null };

  it('reports benefits not read instead of a difference for every item', () => {
    const [result] = compareWithRateFile([rateRow()], [card(benefits)], [card(unread)]);
    expect(result.status).toBe('benefits-not-read');
    expect(result.benefitsNotRead).toEqual(['actual']);
    expect(result.fieldDifferences).toEqual([]);
  });

  it('still reports a price difference when benefits were not read', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card(unread)],
      [card({ ...benefits, priceCents: 10235 })],
    );
    expect(result.status).toBe('difference');
    expect(result.fieldDifferences.map(difference => difference.field)).toEqual(['price']);
  });

  it('compares benefits when both were read', () => {
    const [result] = compareWithRateFile(
      [rateRow()],
      [card(benefits)],
      [
        card({
          benefitsRead: true,
          hospitalItems: [{ label: 'Joint replacements', value: 'Restricted' }],
        }),
      ],
    );
    expect(result.status).toBe('difference');
    expect(result).not.toHaveProperty('benefitsNotRead');
  });
});
