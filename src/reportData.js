const { isPassingStatus, normaliseName } = require('./comparator');
const { coverTypeOrder, membershipTypeOrder } = require('./scenarios');

// Report fields in order; the first name matches the comparator's field.
const moneyChecks = [
  ['price', 'Price', 'priceCents'],
  ['base premium', 'Base premium', 'basePremiumCents'],
  ['rebate', 'Rebate', 'rebateCents'],
  ['LHC', 'LHC', 'lhcCents'],
];
const listChecks = [
  ['discount', 'Discounts', 'discounts'],
  ['hospital', 'Hospital items', 'hospitalItems'],
  ['extras', 'Extras benefits', 'extrasBenefits'],
];
const listTitles = listChecks.map(([, title]) => title);
const checkTitles = ['Product name', ...moneyChecks.map(([, title]) => title), ...listTitles];

const pairedStatuses = [
  'match',
  'difference',
  'breakdown-not-read',
  'price-not-read',
  'benefits-not-read',
];
const breakdownChecks = ['base premium', 'rebate', 'LHC', 'discount'];

// Both cards of a result, wherever the result keeps them.
const cardsOf = result => ({
  expected: result.expected ?? (result.side === 'expected' ? result.card : null) ?? null,
  actual: result.actual ?? (result.side === 'actual' ? result.card : null) ?? null,
});

// A result's differing fields; older runs only compared the price.
const differencesOf = result =>
  result.fieldDifferences ??
  (result.status === 'difference'
    ? [
        {
          field: 'price',
          expected: result.expected?.priceCents ?? null,
          actual: result.actual?.priceCents ?? null,
          deltaCents: result.deltaCents ?? null,
        },
      ]
    : []);

// Names are checked from the cards, so runs from before names were compared still report them.
const nameCheck = (result, expected, actual, paired) => {
  const values = { expected: expected?.productName ?? null, actual: actual?.productName ?? null };
  const shown = values.expected !== null || values.actual !== null;
  return {
    field: 'product name',
    title: 'Product name',
    kind: 'text',
    ...values,
    expectedDifference: Boolean(
      result.expectedDifferences?.some(difference => difference.field === 'product name'),
    ),
    same: paired && shown ? normaliseName(values.expected) === normaliseName(values.actual) : null,
  };
};

// One check per field; `same` is null when there's nothing to compare.
const fieldChecks = result => {
  const { expected, actual } = cardsOf(result);
  const paired = pairedStatuses.includes(result.status);
  const differing = differencesOf(result).map(difference => difference.field);
  const unread = field =>
    (Boolean(result.breakdownNotRead?.length) && breakdownChecks.includes(field)) ||
    (Boolean(result.benefitsNotRead?.length) && ['hospital', 'extras'].includes(field));
  const money = moneyChecks.map(([field, title, key]) => {
    const values = { expected: expected?.[key] ?? null, actual: actual?.[key] ?? null };
    const shown = values.expected !== null || values.actual !== null;
    return {
      field,
      title,
      kind: 'money',
      ...values,
      same: paired && shown && !unread(field) ? !differing.includes(field) : null,
    };
  });
  const lists = listChecks.map(([field, title, key]) => {
    const values = { expected: expected?.[key] ?? null, actual: actual?.[key] ?? null };
    const shown = values.expected !== null || values.actual !== null;
    const labels = new Set(
      [...(values.expected ?? []), ...(values.actual ?? [])].map(i => i.label),
    );
    const differ = differing.filter(name => name.startsWith(`${field}: `)).length;
    return {
      field,
      title,
      kind: 'list',
      ...values,
      total: labels.size,
      differ,
      same: paired && shown && !unread(field) ? differ === 0 : null,
    };
  });
  return [nameCheck(result, expected, actual, paired), ...money, ...lists];
};

const pairedResults = (run, set) =>
  run.scenarios
    .filter(scenario => scenario.set === set)
    .flatMap(scenario => scenario.results.filter(result => pairedStatuses.includes(result.status)));

// The "What was checked" table: per field, rows the same and rows differing.
const checkSummary = (run, set = 'full-sweep') => {
  const lines = checkTitles.map(title => ({
    title,
    list: listTitles.includes(title),
    rowsCompared: 0,
    same: 0,
    differ: 0,
    expectedDiffer: 0,
    notShown: 0,
    itemsCompared: 0,
    itemsDiffer: 0,
  }));
  for (const result of pairedResults(run, set)) {
    fieldChecks(result).forEach((check, index) => {
      const line = lines[index];
      if (check.same === null) {
        line.notShown += 1;
        return;
      }
      line.rowsCompared += 1;
      if (check.expectedDifference) line.expectedDiffer += 1;
      else line[check.same ? 'same' : 'differ'] += 1;
      if (check.kind === 'list') {
        line.itemsCompared += check.total;
        line.itemsDiffer += check.differ;
      }
    });
  }
  return lines;
};

const orderOf = (order, value) => {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
};

// Pass or fail per state, membership type and cover type for the full sweep.
const coverageGrid = run => {
  const scenarios = run.scenarios.filter(scenario => scenario.set === 'full-sweep');
  const columnKey = search => `${search.membershipType} ${search.coverType}`;
  const columns = [...new Map(scenarios.map(({ search }) => [columnKey(search), search])).values()]
    .sort(
      (a, b) =>
        orderOf(membershipTypeOrder, a.membershipType) -
          orderOf(membershipTypeOrder, b.membershipType) ||
        orderOf(coverTypeOrder, a.coverType) - orderOf(coverTypeOrder, b.coverType),
    )
    .map(columnKey);
  const states = [...new Set(scenarios.map(({ search }) => search.state))].sort();
  const cells = new Map(
    scenarios.map(scenario => {
      const issues =
        scenario.status === 'error'
          ? null
          : scenario.results.filter(result => !isPassingStatus(result.status)).length;
      const status = scenario.status === 'error' ? 'error' : issues ? 'fail' : 'pass';
      const cell = { status, rows: scenario.rateRowCount, issues };
      return [`${scenario.search.state} ${columnKey(scenario.search)}`, cell];
    }),
  );
  return {
    columns,
    rows: states.map(state => ({
      state,
      cells: columns.map(column => cells.get(`${state} ${column}`) ?? null),
    })),
  };
};

const benefitTypes = [
  ['hospitalItems', 'Hospital'],
  ['extrasBenefits', 'Extras'],
];

// Each product's hospital and extras items, listed once per product.
const benefitLines = (run, set = 'full-sweep') => {
  const groups = new Map();
  for (const scenario of run.scenarios.filter(item => item.set === set)) {
    for (const result of scenario.results.filter(item => pairedStatuses.includes(item.status))) {
      const product = result.rateRow?.productName ?? result.actual.productName;
      for (const [key, type] of benefitTypes) {
        const expected = result.expected[key];
        const actual = result.actual[key];
        if (!expected && !actual) continue;
        const groupKey = JSON.stringify([product, type, expected, actual]);
        if (!groups.has(groupKey)) {
          groups.set(groupKey, { product, type, expected, actual, states: new Set(), rows: 0 });
        }
        const group = groups.get(groupKey);
        group.states.add(scenario.search.state);
        group.rows += 1;
      }
    }
  }
  return [...groups.values()].flatMap(group => {
    const expectedItems = new Map((group.expected ?? []).map(item => [item.label, item.value]));
    const actualItems = new Map((group.actual ?? []).map(item => [item.label, item.value]));
    const labels = [...new Set([...expectedItems.keys(), ...actualItems.keys()])];
    return labels.map(item => ({
      product: group.product,
      type: group.type,
      item,
      expected: expectedItems.get(item) ?? null,
      actual: actualItems.get(item) ?? null,
      same: expectedItems.get(item) === actualItems.get(item),
      states: [...group.states].sort().join(', '),
      rows: group.rows,
    }));
  });
};

module.exports = {
  benefitLines,
  cardsOf,
  checkSummary,
  coverageGrid,
  differencesOf,
  fieldChecks,
};
