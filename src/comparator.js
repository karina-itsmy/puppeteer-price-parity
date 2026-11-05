// Parses a displayed price like "$1,234.56" into cents, or null.
const parseMoney = text => {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
};

// Formats cents as dollars with a sign, or "n/a".
const formatCents = cents => {
  if (cents === null || cents === undefined) return 'n/a';
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
};

// Collapses spacing, so a stray double space isn't read as a rename.
const normaliseName = name => (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : null);

// Matches cards across funds on the rate file's key, so a renamed product still pairs.
const pairingKey = card =>
  [
    String(card.fundProductCode ?? '')
      .trim()
      .toUpperCase(),
    card.state,
    card.membershipType,
    card.coverType,
    Number(card.excess),
  ].join('|');

const groupByKey = cards => {
  const groups = new Map();
  for (const card of cards) {
    const key = pairingKey(card);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  return groups;
};

const moneyFields = [
  ['basePremiumCents', 'base premium'],
  ['rebateCents', 'rebate'],
  ['lhcCents', 'LHC'],
];
const listFields = [
  ['discounts', 'discount', 'money'],
  ['hospitalItems', 'hospital', 'text'],
  ['extrasBenefits', 'extras', 'text'],
];

const isMissing = value => value === null || value === undefined;

// Fields from the hover breakdown, skipped when a card's breakdown wasn't read.
const breakdownFields = ['base premium', 'rebate', 'LHC', 'discount', 'rate file'];
const isBreakdownField = field =>
  breakdownFields.some(name => field === name || field.startsWith(`${name}: `));

const compareValue = (field, kind, expected, actual) => {
  if (isMissing(expected) && isMissing(actual)) return null;
  if (expected === actual) return null;
  const deltaCents =
    kind === 'money' && !isMissing(expected) && !isMissing(actual) ? actual - expected : null;
  return { field, expected: expected ?? null, actual: actual ?? null, deltaCents };
};

const byLabel = items => new Map((items ?? []).map(item => [item.label, item.value]));

const compareList = (name, kind, expectedItems, actualItems) => {
  if (isMissing(expectedItems) && isMissing(actualItems)) return [];
  const expected = byLabel(expectedItems);
  const actual = byLabel(actualItems);
  const labels = [...new Set([...expected.keys(), ...actual.keys()])];
  return labels
    .map(label => compareValue(`${name}: ${label}`, kind, expected.get(label), actual.get(label)))
    .filter(Boolean);
};

// Lists each field that differs between two cards, price first.
const fieldDifferences = (expected, actual) => {
  const price =
    (expected.priceCents === null) !== (actual.priceCents === null)
      ? {
          field: 'price',
          expected: expected.priceCents,
          actual: actual.priceCents,
          deltaCents: null,
        }
      : compareValue('price', 'money', expected.priceCents, actual.priceCents);
  return [
    price,
    compareValue(
      'product name',
      'text',
      normaliseName(expected.productName),
      normaliseName(actual.productName),
    ),
    ...moneyFields.map(([key, name]) => compareValue(name, 'money', expected[key], actual[key])),
    ...listFields.flatMap(([key, name, kind]) =>
      compareList(name, kind, expected[key], actual[key]),
    ),
  ].filter(Boolean);
};

// The file holds the gross premium, so each base premium must equal it.
const rateFileDifference = (expected, actual, rateRow) => {
  const filePremium = rateRow.monthlyPremiumCents;
  const offFile = card =>
    !isMissing(card.basePremiumCents) && card.basePremiumCents !== filePremium;
  if (isMissing(filePremium) || (!offFile(expected) && !offFile(actual))) return null;
  return {
    field: 'rate file',
    expected: expected.basePremiumCents,
    actual: actual.basePremiumCents,
    deltaCents: null,
  };
};

const isBenefitField = field => field.startsWith('hospital: ') || field.startsWith('extras: ');

const sidesWhere = (expected, actual, flag) =>
  Object.entries({ expected, actual })
    .filter(([, card]) => card[flag] === false)
    .map(([side]) => side);

// A real difference wins; anything unread makes the pair unverified, not a match.
const pairStatus = (differences, priceNotRead, breakdownNotRead, benefitsNotRead) => {
  if (differences.length) return 'difference';
  if (priceNotRead) return 'price-not-read';
  if (breakdownNotRead.length) return 'breakdown-not-read';
  if (benefitsNotRead.length) return 'benefits-not-read';
  return 'match';
};

const codeOf = key => key.split('|')[0];

// The listed rename for this name pair, limited to its product code when the entry names one.
const findListedRename = (expectedNameDifferences, code, expectedName, actualName) =>
  expectedNameDifferences.find(
    entry =>
      (entry.code === undefined || entry.code.trim().toUpperCase() === code) &&
      normaliseName(entry.expected) === normaliseName(expectedName) &&
      normaliseName(entry.actual) === normaliseName(actualName),
  );

const isExpectedRename = (difference, key, expectedNameDifferences) =>
  difference.field === 'product name' &&
  Boolean(
    findListedRename(expectedNameDifferences, codeOf(key), difference.expected, difference.actual),
  );

const comparePair = (key, expected, actual, rateRow, expectedNameDifferences) => {
  const deltaCents =
    expected.priceCents === null || actual.priceCents === null
      ? null
      : actual.priceCents - expected.priceCents;
  const breakdownNotRead = sidesWhere(expected, actual, 'breakdownRead');
  const benefitsNotRead = sidesWhere(expected, actual, 'benefitsRead');
  const found = [
    ...fieldDifferences(expected, actual),
    rateFileDifference(expected, actual, rateRow),
  ].filter(
    difference =>
      difference &&
      !(breakdownNotRead.length && isBreakdownField(difference.field)) &&
      !(benefitsNotRead.length && isBenefitField(difference.field)),
  );
  const expectedDifferences = found.filter(difference =>
    isExpectedRename(difference, key, expectedNameDifferences),
  );
  const differences = found.filter(difference => !expectedDifferences.includes(difference));
  const priceNotRead = isMissing(expected.priceCents) && isMissing(actual.priceCents);
  return {
    key,
    status: pairStatus(differences, priceNotRead, breakdownNotRead, benefitsNotRead),
    expected,
    actual,
    deltaCents,
    fieldDifferences: differences,
    ...(expectedDifferences.length && { expectedDifferences }),
    ...(breakdownNotRead.length && { breakdownNotRead }),
    ...(benefitsNotRead.length && { benefitsNotRead }),
  };
};

// Gives each rate file row one result, then lists unmatched cards as unexpected.
const compareWithRateFile = (
  rateRows,
  expectedCards,
  actualCards,
  expectedNameDifferences = [],
) => {
  const expectedGroups = groupByKey(expectedCards);
  const actualGroups = groupByKey(actualCards);
  const checked = new Set();
  const results = [];

  for (const rateRow of rateRows) {
    const key = pairingKey(rateRow);
    if (checked.has(key)) continue;
    checked.add(key);

    const expected = expectedGroups.get(key) ?? [];
    const actual = actualGroups.get(key) ?? [];
    if (expected.length > 1 || actual.length > 1) {
      results.push({
        key,
        rateRow,
        status: 'duplicate',
        expectedCards: expected,
        actualCards: actual,
      });
    } else if (!expected.length && !actual.length) {
      results.push({ key, rateRow, status: rateRow.notSold ? 'not-sold' : 'missing-both' });
    } else if (!actual.length) {
      results.push({
        key,
        rateRow,
        status: 'missing-actual',
        expected: expected[0],
      });
    } else if (!expected.length) {
      results.push({ key, rateRow, status: 'missing-expected', actual: actual[0] });
    } else {
      results.push({
        ...comparePair(key, expected[0], actual[0], rateRow, expectedNameDifferences),
        rateRow,
      });
    }
  }

  const unexpected = (groups, side) =>
    [...groups.entries()]
      .filter(([key]) => !checked.has(key))
      .flatMap(([key, cards]) => cards.map(card => ({ key, status: 'unexpected', side, card })));
  return [
    ...results,
    ...unexpected(expectedGroups, 'expected'),
    ...unexpected(actualGroups, 'actual'),
  ];
};

// Counts results by status.
// A row passes when both funds show it the same, or both hide a product that isn't sold.
const isPassingStatus = status => status === 'match' || status === 'not-sold';

const summarise = results =>
  results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] ?? 0) + 1;
    return counts;
  }, {});

module.exports = {
  compareWithRateFile,
  fieldDifferences,
  findListedRename,
  formatCents,
  isPassingStatus,
  normaliseName,
  pairingKey,
  parseMoney,
  summarise,
};
