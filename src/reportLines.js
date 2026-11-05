const path = require('path');
const { findListedRename, isPassingStatus, normaliseName } = require('./comparator');
const { hostOf } = require('./config');
const { checkSummary, differencesOf, fieldChecks } = require('./reportData');
const { hasFailingRow, runTotals } = require('./runResults');
const { describeProfile } = require('./scenarios');

const issueStatuses = [
  'missing-actual',
  'missing-expected',
  'missing-both',
  'duplicate',
  'breakdown-not-read',
  'price-not-read',
  'benefits-not-read',
];

// Passes only when rows were checked and every one matched.
const passed = (run, totals) =>
  !run.stoppedBy &&
  totals.rowsChecked > 0 &&
  totals.searchesErrored === 0 &&
  totals.difference + totals.missingActual + totals.missingExpected + totals.missingBoth === 0 &&
  totals.duplicate +
    totals.unexpected +
    (totals.breakdownNotRead ?? 0) +
    (totals.priceNotRead ?? 0) +
    (totals.benefitsNotRead ?? 0) ===
    0;

const dollars = cents => (cents === null || cents === undefined ? null : cents / 100);

const statusLabel = (status, config) =>
  ({
    match: 'Match',
    difference: 'Differs',
    'missing-actual': `Missing in ${config.actualFund.name}`,
    'missing-expected': `Missing in ${config.expectedFund.name}`,
    'missing-both': 'Missing in both',
    'not-sold': 'Not sold (closed), hidden on both',
    duplicate: 'Duplicate',
    unexpected: 'Unexpected card',
    'breakdown-not-read': 'Breakdown not read',
    'price-not-read': 'Price not read',
    'benefits-not-read': 'Benefits not read',
  })[status] ?? status;

const describeRow = (result, scenario) => {
  const [code, state, membershipType, coverType, excess] = result.key.split('|');
  const card = result.card ?? result.expected ?? result.actual;
  return {
    product: result.rateRow?.productName ?? card?.productName ?? code,
    code,
    state,
    membershipType,
    coverType,
    excess: Number(excess),
    set: scenario.set,
    search: scenario.id,
    profile: describeProfile(scenario.profile),
  };
};

// Sweep and variations are reported apart so adjustment problems stand out.
const resultsWithScenario = (run, set) =>
  run.scenarios
    .filter(scenario => scenario.set === set)
    .flatMap(scenario => scenario.results.map(result => ({ result, scenario })));

// Totals for the full sweep and the variations separately.
const setTotals = run => ({
  fullSweep: runTotals(run.scenarios.filter(scenario => scenario.set === 'full-sweep')),
  variations: runTotals(run.scenarios.filter(scenario => scenario.set === 'variations')),
});

const fieldValue = (difference, value) =>
  difference.field === 'price' || difference.deltaCents !== null || typeof value === 'number'
    ? dollars(value)
    : value;

// One line per differing field, sorted by product.
const differenceLines = (run, set = 'full-sweep') =>
  resultsWithScenario(run, set)
    .filter(({ result }) => result.status === 'difference')
    .flatMap(({ result, scenario }) =>
      differencesOf(result).map(difference => ({
        ...describeRow(result, scenario),
        field: difference.field,
        expected: fieldValue(difference, difference.expected),
        actual: fieldValue(difference, difference.actual),
        delta: dollars(difference.deltaCents),
        filePrice: dollars(result.rateRow?.monthlyPremiumCents),
        expectedScreenshot: result.screenshots?.expected ?? null,
        actualScreenshot: result.screenshots?.actual ?? null,
      })),
    )
    .sort(
      (a, b) =>
        a.product.localeCompare(b.product) ||
        a.code.localeCompare(b.code) ||
        a.search.localeCompare(b.search) ||
        a.excess - b.excess,
    );

// One line per product, so one bad product reads as one problem.
const productGroups = lines => {
  const groups = new Map();
  for (const line of lines) {
    if (!groups.has(line.product))
      groups.set(line.product, {
        product: line.product,
        rows: new Set(),
        fields: new Set(),
        deltas: [],
      });
    const group = groups.get(line.product);
    group.rows.add(`${line.search}|${line.code}|${line.excess}`);
    group.fields.add(line.field.split(':')[0]);
    if (line.field === 'price' && line.delta !== null) group.deltas.push(line.delta);
  }
  return [...groups.values()].map(group => ({
    product: group.product,
    rows: group.rows.size,
    fields: [...group.fields].join(', '),
    smallestDelta: group.deltas.length ? Math.min(...group.deltas) : null,
    largestDelta: group.deltas.length ? Math.max(...group.deltas) : null,
  }));
};

// One line per listed rename, so the list can be checked against the run; "Any" means no code.
const expectedDifferenceLines = run => {
  const listed = run.config?.expectedNameDifferences ?? [];
  const groups = new Map();
  const groupOf = (code, expected, actual) => {
    const key = JSON.stringify([code, normaliseName(expected), normaliseName(actual)]);
    if (!groups.has(key)) groups.set(key, { code, expected, actual, rows: 0, searches: new Set() });
    return groups.get(key);
  };
  const codeLabel = entry => (entry.code === undefined ? '' : entry.code.trim().toUpperCase());
  for (const entry of listed) groupOf(codeLabel(entry), entry.expected, entry.actual);
  for (const set of ['full-sweep', 'variations']) {
    for (const { result, scenario } of resultsWithScenario(run, set)) {
      const code = result.key.split('|')[0];
      for (const difference of result.expectedDifferences ?? []) {
        const entry = findListedRename(listed, code, difference.expected, difference.actual);
        const group = entry
          ? groupOf(codeLabel(entry), entry.expected, entry.actual)
          : groupOf(code, difference.expected, difference.actual);
        group.rows += 1;
        group.searches.add(scenario.id);
      }
    }
  }
  return [...groups.values()]
    .map(group => ({
      code: group.code || 'Any',
      expected: group.expected,
      actual: group.actual,
      rows: group.rows,
      searches: group.searches.size,
      seen: group.rows ? 'Seen' : 'Not seen in this run',
    }))
    .sort((a, b) => a.code.localeCompare(b.code) || a.expected.localeCompare(b.expected));
};

// One line per missing, duplicate or unread row.
const missingLines = (run, config, set = 'full-sweep') =>
  resultsWithScenario(run, set)
    .filter(({ result }) => issueStatuses.includes(result.status))
    .map(({ result, scenario }) => {
      const shown = result.expected ?? result.actual;
      return {
        status: statusLabel(result.status, config),
        ...describeRow(result, scenario),
        filePrice: dollars(result.rateRow?.monthlyPremiumCents),
        shownPrice: dollars(shown?.priceCents),
        screenshot: result.screenshots?.expected ?? result.screenshots?.actual ?? null,
      };
    });

// One line per card that matched no rate file row.
const unexpectedLines = (run, config, set = 'full-sweep') =>
  resultsWithScenario(run, set)
    .filter(({ result }) => result.status === 'unexpected')
    .map(({ result, scenario }) => ({
      fund: result.side === 'expected' ? config.expectedFund.name : config.actualFund.name,
      ...describeRow(result, scenario),
      cardProduct: result.card.productName,
      price: dollars(result.card.priceCents),
      screenshot: result.screenshots?.[result.side] ?? null,
    }));

const movementClasses = [
  'increase',
  'decrease',
  'rounding',
  'unchanged',
  'new product',
  'not in increment',
];
const movedClasses = ['increase', 'decrease', 'rounding', 'new product'];

const percentChange = (cents, previousCents) =>
  previousCents ? Math.round(((cents - previousCents) / previousCents) * 10000) / 100 : null;

// A rate file row's movement from the price it took over; blank for runs from before movement.
const movementOf = rateRow => {
  if (!rateRow?.movement) return {};
  const previous = rateRow.previousPremiumCents ?? null;
  return {
    previousPremium: dollars(previous),
    movementChange: previous === null ? null : dollars(rateRow.monthlyPremiumCents - previous),
    movementPercent: percentChange(rateRow.monthlyPremiumCents, previous),
    movementClass: rateRow.movement,
    sourceFile: rateRow.sourceFile ?? null,
  };
};

// True when the run loaded an increment, so movement is worth reporting.
const hasMovement = run =>
  resultsWithScenario(run, 'full-sweep').some(({ result }) =>
    movedClasses.concat('unchanged').includes(result.rateRow?.movement),
  );

// Full sweep rows per movement class, each class once in a fixed order.
const movementCounts = run => {
  const counts = Object.fromEntries(movementClasses.map(name => [name, 0]));
  for (const { result } of resultsWithScenario(run, 'full-sweep')) {
    if (result.rateRow?.movement) counts[result.rateRow.movement] += 1;
  }
  return counts;
};

const range = values => (values.length ? [Math.min(...values), Math.max(...values)] : [null, null]);

// One line per product and movement class, so a uniform uplift reads as one line.
const movementLines = run => {
  const groups = new Map();
  for (const { result, scenario } of resultsWithScenario(run, 'full-sweep')) {
    const rateRow = result.rateRow;
    if (!movedClasses.includes(rateRow?.movement)) continue;
    const product = describeRow(result, scenario).product;
    const key = JSON.stringify([product, rateRow.movement]);
    if (!groups.has(key)) {
      groups.set(key, {
        product,
        movement: rateRow.movement,
        rows: 0,
        matched: 0,
        changes: [],
        percents: [],
      });
    }
    const group = groups.get(key);
    const { movementChange, movementPercent } = movementOf(rateRow);
    group.rows += 1;
    if (result.status === 'match') group.matched += 1;
    if (movementChange !== null) group.changes.push(movementChange);
    if (movementPercent !== null) group.percents.push(movementPercent);
  }
  return [...groups.values()]
    .map(group => {
      const [smallestChange, largestChange] = range(group.changes);
      const [smallestPercent, largestPercent] = range(group.percents);
      return {
        product: group.product,
        movement: group.movement,
        rows: group.rows,
        smallestChange,
        largestChange,
        smallestPercent,
        largestPercent,
        matchedOnBoth: group.matched,
      };
    })
    .sort(
      (a, b) =>
        movementClasses.indexOf(a.movement) - movementClasses.indexOf(b.movement) ||
        a.product.localeCompare(b.product),
    );
};

// e.g. "84 rows moved (84 increases, 0 decreases, 0 rounding)"; null when nothing moved.
const movementSummary = run => {
  if (!hasMovement(run)) return null;
  const counts = movementCounts(run);
  const moved = movedClasses.reduce((sum, name) => sum + counts[name], 0);
  const parts = [
    plural(counts.increase, 'increase'),
    plural(counts.decrease, 'decrease'),
    `${counts.rounding} rounding`,
    ...(counts['new product'] ? [plural(counts['new product'], 'new product')] : []),
  ];
  return `${plural(moved, 'row')} moved (${parts.join(', ')})`;
};

// One line per result with every field, for the All rows and Variation rows sheets.
const allLines = (run, config, set = 'full-sweep') =>
  resultsWithScenario(run, set).map(({ result, scenario }) => ({
    status: result.status,
    statusLabel: statusLabel(result.status, config),
    ...describeRow(result, scenario),
    checks: fieldChecks(result),
    delta: dollars(result.deltaCents),
    filePrice: dollars(result.rateRow?.monthlyPremiumCents),
    ...movementOf(result.rateRow),
    expectedScreenshot: result.screenshots?.expected ?? null,
    actualScreenshot: result.screenshots?.actual ?? null,
  }));

// One line per search that errored.
const errorLines = run =>
  run.scenarios
    .filter(scenario => scenario.status === 'error')
    .map(scenario => ({
      search: scenario.id,
      set: scenario.set,
      attempts: scenario.attempts,
      error: scenario.error,
      screenshot: scenario.screenshot ?? null,
    }));

const hoursAndMinutes = minutes =>
  minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;

// Run time; re-runs count only their searches' time, not gaps between sessions.
const duration = run => {
  if (!run.startedAt || !run.finishedAt) return 'not finished';
  if (run.resumes?.length || run.reruns?.length) {
    const seconds = run.scenarios.reduce((sum, scenario) => sum + (scenario.seconds ?? 0), 0);
    return `${hoursAndMinutes(Math.round(seconds / 60))} of searches`;
  }
  return hoursAndMinutes(Math.round((new Date(run.finishedAt) - new Date(run.startedAt)) / 60000));
};

const continuations = entries =>
  (entries ?? [])
    .map(entry =>
      entry.searches === undefined
        ? entry.startedAt
        : `${entry.startedAt} (${entry.searches} searches)`,
    )
    .join(', ');

// The run's result and settings for the report header.
const runDetails = (run, totals) => {
  const { config } = run;
  const { expectedFund, actualFund } = config;
  const twoEnvironment = Boolean(expectedFund.baseUrl);
  return [
    ['Result', passed(run, totals) ? 'PASS' : 'FAIL'],
    ['Config', config.name],
    ...(twoEnvironment
      ? [
          ['Expected environment', expectedFund.baseUrl],
          ['Actual environment', actualFund.baseUrl],
        ]
      : [['Environment', config.baseUrl]]),
    ['Expected fund', `${config.expectedFund.name} (${config.expectedFund.code})`],
    ['Actual fund', `${config.actualFund.name} (${config.actualFund.code})`],
    ['Rate files', config.rateFiles.map(file => path.basename(file)).join(', ')],
    ['Prices as at', config.priceDate],
    ['Full sweep profile', config.profile ? describeProfile(config.profile) : ''],
    ...(twoEnvironment
      ? [
          ['Expected lead id', expectedFund.leadId],
          ['Actual lead id', actualFund.leadId],
        ]
      : [['Lead id', config.leadId]]),
    ['Re-run of', config.rerunOf ?? ''],
    ['Re-runs', continuations(run.reruns)],
    ['Resumes', continuations(run.resumes)],
    ['Started', run.startedAt],
    ['Finished', run.finishedAt ?? 'not finished'],
    ['Run time', duration(run)],
    ['Stopped by', run.stoppedBy ?? ''],
  ];
};

// One line per count, sweep and variations side by side.
const countRows = (bySet, config) =>
  [
    ['Searches', 'searches'],
    ['Searches errored', 'searchesErrored'],
    ['Rate file rows checked', 'rowsChecked'],
    ['Rows not checked (errored searches)', 'rowsNotChecked'],
    ['Match', 'match'],
    ['Differ', 'difference'],
    [`Missing ${config.actualFund.code}`, 'missingActual'],
    [`Missing ${config.expectedFund.code}`, 'missingExpected'],
    ['Missing both', 'missingBoth'],
    ['Not sold (closed), hidden on both', 'notSold'],
    ['Duplicate', 'duplicate'],
    ['Unexpected cards', 'unexpected'],
    ['Breakdown not read', 'breakdownNotRead'],
    ['Price not read', 'priceNotRead'],
    ['Benefits not read', 'benefitsNotRead'],
  ].map(([name, key]) => [name, bySet.fullSweep[key], bySet.variations[key]]);

// Formats a count with its noun, e.g. "1 row", "2 rows".
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// Says names differ only by the listed renames, and how many of those the run saw.
const renameSummary = (run, renamedRows) => {
  const renames = expectedDifferenceLines(run);
  const seen = renames.filter(rename => rename.rows).length;
  const seenNote = seen === renames.length ? 'all seen' : `${seen} seen in this run`;
  return `Product names match apart from ${plural(renames.length, 'listed rename')} (${seenNote}, ${plural(renamedRows, 'row')}).`;
};

// Which sets the run's totals cover, e.g. "full sweep + variations".
const setsChecked = run => {
  const { fullSweep, variations } = setTotals(run);
  if (fullSweep.searches && variations.searches) return 'full sweep + variations';
  return variations.searches ? 'variations only' : 'full sweep only';
};

// The one-sentence answer at the top of the report.
const verdict = (run, totals) => {
  const renamed = checkSummary(run).find(line => line.title === 'Product name')?.expectedDiffer;
  const fields = checkSummary(run)
    .filter(line => line.rowsCompared && !(renamed && line.title === 'Product name'))
    .map(line => (line.title === 'LHC' ? line.title : line.title.toLowerCase()));
  const fieldList =
    fields.length > 1 ? `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}` : fields[0];
  if (passed(run, totals)) {
    // The variations check the same rate file rows again for other customers, so they're counted apart.
    const { fullSweep, variations } = setTotals(run);
    const sweep = fullSweep.rowsChecked
      ? `All ${fullSweep.rowsChecked} rate file rows show the same ${fieldList ?? 'values'} for both funds`
      : `Every row checked shows the same ${fieldList ?? 'values'} for both funds`;
    const extra = variations.rowsChecked
      ? `, and so do ${variations.rowsChecked} rows rechecked across ${plural(variations.searches, 'rebate and LHC variation')}`
      : '';
    const notSold = totals.notSold
      ? ` ${plural(totals.notSold, 'row')} of those are closed products not sold through the fund channel, hidden on both as expected.`
      : '';
    const renames = renamed ? ` ${renameSummary(run, renamed)}` : '';
    const moved = movementSummary(run);
    return `${sweep}${extra}.${notSold}${renames}${moved ? ` ${moved}, all shown on both funds.` : ''}`;
  }
  if (run.stoppedBy) return `The run stopped before it finished: ${run.stoppedBy}.`;
  if (!totals.rowsChecked && !totals.searchesErrored) return 'No rate file rows were checked.';
  const off =
    totals.difference + totals.missingActual + totals.missingExpected + totals.missingBoth;
  const parts = [
    off && `${off} of ${totals.rowsChecked} rate file rows are not the same for both funds`,
    totals.duplicate && plural(totals.duplicate, 'duplicate row'),
    totals.unexpected && plural(totals.unexpected, 'unexpected card'),
    totals.breakdownNotRead &&
      `${plural(totals.breakdownNotRead, 'row')} with a price breakdown the script couldn't read`,
    totals.priceNotRead &&
      `${plural(totals.priceNotRead, 'row')} with no price the script could read on either card`,
    totals.benefitsNotRead &&
      `${plural(totals.benefitsNotRead, 'row')} with benefits the script couldn't read`,
    totals.searchesErrored && `${plural(totals.searchesErrored, 'search', 'searches')} errored`,
  ].filter(Boolean);
  const moved = movementSummary(run);
  return `${parts.join(', ')}.${moved ? ` ${moved}.` : ''}`;
};

// Failing screenshots embedded; the rest stay linked.
const FAILING_LIMIT = 100;
// Pages are tall, so fewer are embedded.
const FAILING_PAGE_LIMIT = 20;
// Passing pages shown, matching the 6 + 2 card samples.
const PASS_PAGE_LIMIT = 8;

// Screenshots for the Evidence sheet and summary page, in four groups.
const evidenceEntries = (run, config) => {
  const fundName = side => {
    const fund = config[`${side}Fund`];
    return fund.baseUrl ? `${fund.name} on ${hostOf(fund.baseUrl)}` : fund.name;
  };
  const shots = ['full-sweep', 'variations'].flatMap(set =>
    resultsWithScenario(run, set)
      .filter(({ result }) => result.screenshots)
      .flatMap(({ result, scenario }) => {
        const row = describeRow(result, scenario);
        const profile = set === 'variations' ? ` · ${row.profile}` : '';
        const status =
          result.status === 'match' ? 'Sample pass' : statusLabel(result.status, config);
        const group = isPassingStatus(result.status) ? 'Sample passes' : 'Failing';
        const label = side =>
          `${status}: ${row.product} (${row.code}), excess ${row.excess}, ` +
          `${row.state} ${row.membershipType} ${row.coverType}${profile}. ${fundName(side)}`;
        return [
          ...Object.entries(result.screenshots).map(([side, file]) => ({
            group,
            file,
            label: label(side),
          })),
          ...Object.entries(result.itemScreenshots ?? {}).map(([side, file]) => ({
            group,
            file,
            label: `${label(side)}, selected items`,
            items: true,
          })),
        ];
      }),
  );
  // Every excess of a card shares one selected-items screenshot, so show it once.
  const seen = new Set();
  const cards = shots
    .filter(entry => !entry.items || (!seen.has(entry.file) && seen.add(entry.file)))
    .map(({ items, ...entry }) => entry);
  const failing = cards.filter(entry => entry.group === 'Failing');
  const errors = errorLines(run)
    .filter(line => line.screenshot)
    .map(line => ({
      group: 'Failed searches',
      file: line.screenshot,
      label: `Search failed: ${line.search}. ${line.error}`,
    }));
  // A two-environment search has a page screenshot per side; a single-environment one has one.
  const pageFiles = scenario =>
    scenario.pageScreenshots
      ? Object.entries(scenario.pageScreenshots).filter(([, file]) => file)
      : scenario.screenshot
        ? [[null, scenario.screenshot]]
        : [];
  const pages = run.scenarios.filter(
    scenario => scenario.status !== 'error' && pageFiles(scenario).length,
  );
  const wholePage = (scenario, status) =>
    pageFiles(scenario).map(([side, file]) => ({
      group: 'Whole pages',
      file,
      label: `${status}, whole page: ${scenario.id}${side ? `. ${fundName(side)}` : ''}`,
    }));
  const failingPages = pages
    .filter(scenario => hasFailingRow(scenario.results))
    .flatMap(scenario => wholePage(scenario, 'Failing search'));
  const passPages = pages
    .filter(scenario => !hasFailingRow(scenario.results))
    .slice(0, PASS_PAGE_LIMIT)
    .flatMap(scenario => wholePage(scenario, 'Sample pass'));
  return {
    entries: [
      ...failing.slice(0, FAILING_LIMIT),
      ...errors,
      ...cards.filter(entry => entry.group === 'Sample passes'),
      ...failingPages.slice(0, FAILING_PAGE_LIMIT),
      ...passPages,
    ],
    more: Math.max(failing.length - FAILING_LIMIT, 0),
    morePages: Math.max(failingPages.length - FAILING_PAGE_LIMIT, 0),
  };
};

// One coverage grid cell as text.
const coverageText = cell => {
  if (!cell) return '';
  if (cell.status === 'error') return 'error';
  return cell.status === 'pass' ? `✓ ${cell.rows}` : `✗ ${cell.issues} of ${cell.rows}`;
};

module.exports = {
  allLines,
  countRows,
  coverageText,
  differenceLines,
  duration,
  errorLines,
  evidenceEntries,
  expectedDifferenceLines,
  missingLines,
  movementClasses,
  movementCounts,
  movementLines,
  movementSummary,
  passed,
  plural,
  productGroups,
  runDetails,
  setsChecked,
  setTotals,
  unexpectedLines,
  verdict,
};
