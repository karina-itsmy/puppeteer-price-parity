import { describe, expect, it } from 'vitest';
import { pairingKey } from './comparator';
import {
  buildFullSweep,
  buildScenarios,
  buildVariations,
  dateOfBirthForAge,
  groupIntoSearches,
  parseSearch,
} from './scenarios';

const row = (state, membershipType, coverType, fundProductCode, excess = 750) => ({
  state,
  membershipType,
  coverType,
  fundProductCode,
  excess,
  monthlyPremiumCents: 10000,
});

// Deliberately out of order, so the tests show the grouping sorts its searches.
const rateRows = [
  row('VIC', 'family', 'combined', 'F3PE-V'),
  row('NSW', 'single', 'hospital', 'S3P-N', 500),
  row('VIC', 'single', 'hospital', 'S3P-V', 500),
  row('VIC', 'single', 'hospital', 'S3P-V', 750),
  row('NSW', 'single', 'hospital', 'S3P-N', 750),
  row('VIC', 'single-parent', 'extras', 'X1-V', 0),
  row('VIC', 'single', 'extras', 'X1-V', 0),
];

const today = new Date(2026, 9, 19);

describe('groupIntoSearches', () => {
  it('makes one search per state, membership type and cover type found in the rate file', () => {
    const searches = groupIntoSearches(rateRows).map(({ search }) =>
      Object.values(search).join('/'),
    );
    expect(searches).toEqual([
      'NSW/single/hospital',
      'VIC/single/hospital',
      'VIC/single/extras',
      'VIC/family/combined',
      'VIC/single-parent/extras',
    ]);
  });

  it('orders the any-dependants searches after the four standard membership types', () => {
    const searches = groupIntoSearches([
      row('VIC', 'couple-any-dependants', 'hospital', 'CAD-V', 500),
      row('VIC', 'single-any-dependants', 'hospital', 'SAD-V', 500),
      row('VIC', 'single-parent', 'hospital', 'SP-V', 500),
    ]).map(({ search }) => search.membershipType);
    expect(searches).toEqual(['single-parent', 'single-any-dependants', 'couple-any-dependants']);
  });
});

describe('buildFullSweep', () => {
  it('covers every rate file row exactly once', () => {
    const scenarios = buildFullSweep(rateRows, { today });
    const covered = scenarios.flatMap(scenario => scenario.rateRows.map(pairingKey));
    expect(covered).toHaveLength(rateRows.length);
    expect(new Set(covered)).toEqual(new Set(rateRows.map(pairingKey)));
  });

  it('only puts rows in the search they belong to', () => {
    for (const scenario of buildFullSweep(rateRows, { today })) {
      for (const rateRow of scenario.rateRows) {
        expect(rateRow).toMatchObject(scenario.search);
      }
    }
  });

  it('gives every scenario the fixed profile: age 40, base rebate tier, no LHC', () => {
    const [scenario] = buildFullSweep(rateRows, { today });
    expect(scenario).toMatchObject({
      id: 'NSW-single-hospital-age40-base-nolhc',
      set: 'full-sweep',
      profile: { age: 40, rebateTier: 'base', lhcAge: null, dateOfBirth: '19-09-1986' },
    });
  });

  it('runs only the searches asked for', () => {
    const scenarios = buildFullSweep(rateRows, {
      today,
      onlySearches: [parseSearch('vic/single/hospital')],
    });
    expect(scenarios.map(scenario => scenario.id)).toEqual([
      'VIC-single-hospital-age40-base-nolhc',
    ]);
    expect(scenarios[0].rateRows).toHaveLength(2);
  });

  it('rejects a search the rate file has no rows for', () => {
    expect(() =>
      buildFullSweep(rateRows, { onlySearches: [parseSearch('WA/couple/hospital')] }),
    ).toThrow('no rows for WA/couple/hospital');
  });

  it('rejects an unknown rebate tier', () => {
    expect(() => buildFullSweep(rateRows, { profile: { rebateTier: 'tier9' } })).toThrow(
      'rebate tier "tier9"',
    );
  });
});

const variations = {
  searches: ['VIC/single/hospital', 'NSW/single/hospital'],
  profiles: [
    { age: 65, rebateTier: 'tier3', lhcAge: null },
    { age: 40, rebateTier: 'base', lhcAge: 35 },
    { age: 40, rebateTier: 'base', lhcAge: null },
  ],
};

describe('buildVariations', () => {
  it("runs every listed search with every listed profile, on that search's rate file rows", () => {
    const scenarios = buildVariations(rateRows, variations, { today });
    expect(scenarios.map(scenario => scenario.id)).toEqual([
      'VIC-single-hospital-age65-tier3-nolhc',
      'VIC-single-hospital-age40-base-lhc35',
      'VIC-single-hospital-age40-base-nolhc',
      'NSW-single-hospital-age65-tier3-nolhc',
      'NSW-single-hospital-age40-base-lhc35',
      'NSW-single-hospital-age40-base-nolhc',
    ]);
    expect(scenarios[0]).toMatchObject({
      set: 'variations',
      profile: { age: 65, rebateTier: 'tier3', lhcAge: null, dateOfBirth: '19-09-1961' },
    });
    expect(scenarios[0].rateRows.map(pairingKey)).toEqual([
      'S3P-V|VIC|single|hospital|500',
      'S3P-V|VIC|single|hospital|750',
    ]);
  });

  it('rejects a variation search the rate file has no rows for', () => {
    expect(() =>
      buildVariations(rateRows, { searches: ['WA/single/hospital'], profiles: [{}] }, { today }),
    ).toThrow('WA/single/hospital, which the rate file has no rows for');
  });

  it('rejects a variation profile with an unknown rebate tier', () => {
    expect(() =>
      buildVariations(
        rateRows,
        { searches: ['VIC/single/hospital'], profiles: [{ rebateTier: 'gold' }] },
        { today },
      ),
    ).toThrow('rebate tier "gold"');
  });
});

describe('buildScenarios', () => {
  it('runs the full sweep, then the variations, without running any scenario twice', () => {
    const scenarios = buildScenarios(rateRows, { today, variations });
    const ids = scenarios.map(scenario => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(scenarios.filter(scenario => scenario.set === 'full-sweep')).toHaveLength(5);
    // The age 40, base, no LHC variations repeat the full sweep, so only 4 variations are left.
    expect(scenarios.filter(scenario => scenario.set === 'variations')).toHaveLength(4);
    expect(scenarios.slice(0, 5).every(scenario => scenario.set === 'full-sweep')).toBe(true);
  });

  it('runs one set on its own, and narrows both sets to the searches asked for', () => {
    expect(
      buildScenarios(rateRows, { today, variations, sets: ['variations'] }).map(s => s.set),
    ).toEqual(Array(6).fill('variations'));
    const narrowed = buildScenarios(rateRows, {
      today,
      variations,
      onlySearches: [parseSearch('VIC/single/hospital')],
    });
    expect(narrowed.map(scenario => scenario.id)).toEqual([
      'VIC-single-hospital-age40-base-nolhc',
      'VIC-single-hospital-age65-tier3-nolhc',
      'VIC-single-hospital-age40-base-lhc35',
    ]);
  });

  it('keeps only the scenarios a re-run asks for, from either set', () => {
    const ids = ['NSW-single-hospital-age40-base-nolhc', 'VIC-single-hospital-age65-tier3-nolhc'];
    const scenarios = buildScenarios(rateRows, { today, variations, onlyIds: ids });
    expect(scenarios.map(scenario => [scenario.id, scenario.set])).toEqual([
      [ids[0], 'full-sweep'],
      [ids[1], 'variations'],
    ]);
  });

  it('rejects a re-run scenario the rate files no longer have', () => {
    expect(() =>
      buildScenarios(rateRows, {
        today,
        variations,
        onlyIds: ['WA-single-hospital-age40-base-nolhc'],
      }),
    ).toThrow('not in this run');
  });

  it('runs only the full sweep when there is no variation file', () => {
    expect(buildScenarios(rateRows, { today, variations: null })).toHaveLength(5);
  });
});

describe('parseSearch', () => {
  it('rejects a search that is not state/membership type/cover type', () => {
    expect(() => parseSearch('VIC/single')).toThrow('should look like VIC/single/hospital');
  });
});

describe('dateOfBirthForAge', () => {
  it('gives a birthday that makes the customer exactly that age today', () => {
    expect(dateOfBirthForAge(40, today)).toBe('19-09-1986');
    expect(dateOfBirthForAge(65, new Date(2026, 2, 1))).toBe('30-01-1961');
  });
});
