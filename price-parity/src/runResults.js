const fs = require('fs');
const path = require('path');
const { isPassingStatus } = require('./comparator');

// Where run folders go.
const outputDirectory = path.join(__dirname, '..', 'output');

// Local time as YYYYMMDD-HHMMSS, for file names.
const timestamp = date => {
  const pad = number => String(number).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
};

// Makes a new run folder, e.g. output/local-20261019-143012, adding -2 on a clash.
const createRunFolder = (configName, startedAt, directory = outputDirectory) => {
  fs.mkdirSync(directory, { recursive: true });
  const base = path.join(directory, `${configName}-${timestamp(startedAt)}`);
  for (let copy = 1; ; copy += 1) {
    const folder = copy === 1 ? base : `${base}-${copy}`;
    try {
      fs.mkdirSync(folder);
      return folder;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
};

const emptyTotals = () => ({
  searches: 0,
  searchesErrored: 0,
  rowsChecked: 0,
  rowsNotChecked: 0,
  match: 0,
  difference: 0,
  missingExpected: 0,
  missingActual: 0,
  missingBoth: 0,
  notSold: 0,
  duplicate: 0,
  unexpected: 0,
  breakdownNotRead: 0,
  priceNotRead: 0,
  benefitsNotRead: 0,
});

const statusTotals = {
  match: 'match',
  difference: 'difference',
  'missing-expected': 'missingExpected',
  'missing-actual': 'missingActual',
  'missing-both': 'missingBoth',
  'not-sold': 'notSold',
  duplicate: 'duplicate',
  unexpected: 'unexpected',
  'breakdown-not-read': 'breakdownNotRead',
  'price-not-read': 'priceNotRead',
  'benefits-not-read': 'benefitsNotRead',
};

// Adds up all scenarios; rows in an errored search count as not checked.
const runTotals = scenarios =>
  scenarios.reduce((totals, scenario) => {
    totals.searches += 1;
    if (scenario.status === 'error') {
      totals.searchesErrored += 1;
      totals.rowsNotChecked += scenario.rateRowCount;
      return totals;
    }
    totals.rowsChecked += scenario.rateRowCount;
    for (const result of scenario.results) totals[statusTotals[result.status]] += 1;
    return totals;
  }, emptyTotals());

// Saves results.json after every search, so a stopped run keeps its results.
const writeResults = (folder, run) => {
  const file = path.join(folder, 'results.json');
  const contents = { ...run, totals: runTotals(run.scenarios) };
  fs.writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
  return file;
};

// True when any row in a search didn't pass.
const hasFailingRow = results => results.some(result => !isPassingStatus(result.status));

const sampleKind = scenario =>
  `${scenario.set} ${scenario.search.membershipType} ${scenario.search.coverType}`;

// Sample passes per set, so a clean report still shows evidence.
const SAMPLE_LIMITS = { 'full-sweep': 6, variations: 2 };

// Picks a matching pair to screenshot, spread over types; null when none is needed.
const takeSample = (taken, scenario, results) => {
  if (!results.length || hasFailingRow(results)) return null;
  const kind = sampleKind(scenario);
  const inSet = [...taken].filter(key => key.startsWith(`${scenario.set} `)).length;
  if (taken.has(kind) || inSet >= (SAMPLE_LIMITS[scenario.set] ?? 0)) return null;
  const pair = results.find(result => result.expected?.cardId && result.actual?.cardId);
  if (!pair) return null;
  taken.add(kind);
  return pair;
};

// Reads a previous run from its folder or results.json.
const readPreviousRun = location => {
  const resolved = path.resolve(location);
  const file =
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? path.join(resolved, 'results.json')
      : resolved;
  if (!fs.existsSync(file)) throw new Error(`No results file at ${file}`);
  return { file, run: JSON.parse(fs.readFileSync(file, 'utf8')) };
};

// Scenarios that errored or had a row that didn't match.
const scenariosToRerun = run =>
  (run.scenarios ?? [])
    .filter(scenario => scenario.status === 'error' || hasFailingRow(scenario.results))
    .map(scenario => scenario.id);

// Scenarios a resume keeps: the finished ones.
const scenariosToKeep = run => (run.scenarios ?? []).filter(scenario => scenario.status === 'done');

// Sample kinds already screenshotted, so a resume doesn't repeat them.
const samplesTaken = scenarios =>
  new Set(
    scenarios
      .filter(
        scenario =>
          scenario.results?.length &&
          !hasFailingRow(scenario.results) &&
          scenario.results.some(result => result.screenshots),
      )
      .map(sampleKind),
  );

// Sorts scenario records into run order; unknown ones go last.
const inRunOrder = (records, orderedIds) => {
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  const rank = record => position.get(record.id) ?? orderedIds.length;
  return [...records].sort((a, b) => rank(a) - rank(b));
};

module.exports = {
  inRunOrder,
  samplesTaken,
  scenariosToKeep,
  createRunFolder,
  hasFailingRow,
  outputDirectory,
  readPreviousRun,
  runTotals,
  scenariosToRerun,
  takeSample,
  timestamp,
  writeResults,
};
