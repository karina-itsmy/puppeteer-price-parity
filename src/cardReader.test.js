import { describe, expect, it } from 'vitest';
import { fieldDifferences } from './comparator';
import { readUntilBreakdown, toCardRecord } from './cardReader';

const raw = overrides => ({
  fundName: 'ItsMy',
  productName: 'ItsMy Basic Hospital 750',
  fundProductCode: 'S31P-V',
  excess: '750',
  priceText: '$77.66',
  breakdown: {
    basePremium: '$102.34',
    rebate: '-$24.68',
    lhc: null,
    discounts: [],
  },
  benefits: {
    hospital: [
      { label: 'Private Hospital', status: 'covered' },
      { label: 'Hospital psychiatric services', status: 'restricted' },
    ],
    extras: null,
  },
  ...overrides,
});

describe('toCardRecord', () => {
  it('reads the price breakdown into cents', () => {
    const record = toCardRecord(raw());
    expect(record).toMatchObject({
      fundName: 'ItsMy',
      fundProductCode: 'S31P-V',
      excess: '750',
      priceCents: 7766,
      basePremiumCents: 10234,
      rebateCents: 2468,
      lhcCents: 0,
      discounts: [],
    });
    expect(record).not.toHaveProperty('breakdown');
    expect(record).not.toHaveProperty('benefits');
  });

  it('reads LHC and discounts, naming each discount without its percentage', () => {
    const record = toCardRecord(
      raw({
        breakdown: {
          basePremium: '$249.72',
          rebate: '-$60.23',
          lhc: '$10.00',
          discounts: [{ label: 'Direct debit (4%)', amount: '-$9.99' }],
        },
      }),
    );
    expect(record.lhcCents).toBe(1000);
    expect(record.discounts).toEqual([{ label: 'Direct debit', value: 999 }]);
  });

  it('turns benefits into labelled values and leaves an unshown table as null', () => {
    const record = toCardRecord(raw());
    expect(record.hospitalItems).toEqual([
      { label: 'Private Hospital', value: 'covered' },
      { label: 'Hospital psychiatric services', value: 'restricted' },
    ]);
    expect(record.extrasBenefits).toBeNull();
  });

  it('marks the breakdown as not read when it shows without a base premium, e.g. after a selector change', () => {
    const record = toCardRecord(
      raw({ breakdown: { basePremium: null, rebate: null, lhc: null, discounts: [] } }),
    );
    expect(record.breakdownRead).toBe(false);
    expect(record.basePremiumCents).toBeNull();
  });

  it('marks the breakdown as not read, with unknown values rather than zero, when it never showed', () => {
    const record = toCardRecord(raw({ breakdown: null, benefits: null }));
    expect(record.priceCents).toBe(7766);
    expect(record).toMatchObject({
      breakdownRead: false,
      basePremiumCents: null,
      rebateCents: null,
      lhcCents: null,
      discounts: null,
    });
    expect(record.hospitalItems).toBeNull();
    expect(record.benefitsRead).toBe(false);
  });

  it('marks a breakdown that showed as read', () => {
    expect(toCardRecord(raw()).breakdownRead).toBe(true);
  });

  it('gives records the comparator can diff field by field', () => {
    const expected = toCardRecord(raw());
    const actual = toCardRecord(
      raw({
        breakdown: { basePremium: '$102.35', rebate: '-$24.68', lhc: null, discounts: [] },
        benefits: {
          hospital: [
            { label: 'Private Hospital', status: 'covered' },
            { label: 'Hospital psychiatric services', status: 'covered' },
          ],
          extras: null,
        },
      }),
    );
    expect(fieldDifferences(expected, actual)).toEqual([
      { field: 'base premium', expected: 10234, actual: 10235, deltaCents: 1 },
      {
        field: 'hospital: Hospital psychiatric services',
        expected: 'restricted',
        actual: 'covered',
        deltaCents: null,
      },
    ]);
  });
});

describe('readUntilBreakdown', () => {
  // A fake card read that returns each of the given reads in turn, and counts the hover resets.
  const reader = reads => {
    const state = { resets: 0, reads: 0 };
    return {
      state,
      read: async () => reads[Math.min(state.reads++, reads.length - 1)],
      reset: async () => {
        state.resets += 1;
      },
    };
  };
  const shown = raw();
  const hidden = raw({ breakdown: null });

  it('reads once when the breakdown shows first time', async () => {
    const fake = reader([shown]);
    expect(await readUntilBreakdown(fake.read, fake.reset)).toBe(shown);
    expect(fake.state.resets).toBe(0);
  });

  it('hovers again when the breakdown did not show, and keeps the second read', async () => {
    const fake = reader([hidden, shown]);
    expect(await readUntilBreakdown(fake.read, fake.reset)).toBe(shown);
    expect(fake.state.resets).toBe(1);
  });

  it('gives up after the second try and returns the read without a breakdown', async () => {
    const fake = reader([hidden, hidden, shown]);
    expect(await readUntilBreakdown(fake.read, fake.reset)).toBe(hidden);
    expect(fake.state.reads).toBe(2);
  });
});
