const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const {
  hostOf,
  isTwoEnvironment,
  loadConfig,
  loadEnvFiles,
  parseCommandLine,
  searchTabs,
} = require('./config');
const { compareWithRateFile, formatCents, isPassingStatus, summarise } = require('./comparator');
const {
  backToForm,
  enterProfile,
  enterSearch,
  filterToFunds,
  loadAllResults,
  openComparison,
  openLead,
  readAllCards,
  screenshotCard,
  screenshotDetailedCards,
  screenshotPage,
  SetupError,
} = require('./funnelDriver');
const { currentRateRows, keysWithoutPriceOn, readRateFiles, withMovement } = require('./rateFile');
const { writeReport } = require('./reporter');
const {
  createRunFolder,
  hasFailingRow,
  inRunOrder,
  readPreviousRun,
  runTotals,
  samplesTaken,
  takeSample,
  writeResults,
} = require('./runResults');
const { closeBrowsers, ensureBrowsers } = require('./browserSession');
const { keepAwake } = require('./keepAwake');
const { buildScenarios, describeProfile } = require('./scenarios');

const ATTEMPTS = 2;

// Progress and errors go straight to the terminal, as this is a command-line tool.
const say = message => process.stdout.write(`${message}\n`);
const warn = message => process.stderr.write(`${message}\n`);

const scriptVersion = () => {
  try {
    return execSync('git describe --always --dirty', { cwd: __dirname, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};

const movedClasses = ['increase', 'decrease', 'rounding', 'new product'];

// e.g. "672 from itsmy_FullLoad.xlsx, 84 from INC_A.xlsx (84 moved)".
const describeRowSources = rateRows => {
  const counts = new Map();
  for (const row of rateRows) {
    const count = counts.get(row.sourceFile) ?? { rows: 0, moved: 0 };
    count.rows += 1;
    if (movedClasses.includes(row.movement)) count.moved += 1;
    counts.set(row.sourceFile, count);
  }
  return [...counts.entries()]
    .map(
      ([file, count]) =>
        `${count.rows} from ${file}${count.moved ? ` (${count.moved} moved)` : ''}`,
    )
    .join(', ');
};

const fileSafe = text => String(text).replace(/[^A-Za-z0-9._-]+/g, '_');

const saveScreenshot = async (session, name, take) => {
  const relative = path.join('screenshots', `${fileSafe(name)}.png`);
  fs.mkdirSync(path.join(session.folder, 'screenshots'), { recursive: true });
  return (await take(path.join(session.folder, relative))) === false ? null : relative;
};

const cardsOf = result => ({
  expected: result.expected ?? (result.side === 'expected' ? result.card : null),
  actual: result.actual ?? (result.side === 'actual' ? result.card : null),
});

// The tab a side's cards were read on.
const pageFor = (session, side) => session.pages[side] ?? session.pages.both;

const screenshotCards = async (session, scenario, result) => {
  for (const [side, card] of Object.entries(cardsOf(result))) {
    if (!card?.cardId) continue;
    const name = `${scenario.id}-${card.fundProductCode}-${card.excess}-${side}`;
    const file = await saveScreenshot(session, name, target =>
      screenshotCard(pageFor(session, side), card.cardId, target),
    );
    if (file) result.screenshots = { ...result.screenshots, [side]: file };
  }
};

const screenshotItems = async (session, scenario, results, tab) => {
  const onTab = ([side, card]) => tab.sides.includes(side) && card?.cardId;
  const shot = results.filter(result => result.screenshots);
  const files = new Map();
  for (const result of shot) {
    for (const [side, card] of Object.entries(cardsOf(result)).filter(onTab)) {
      if (!result.screenshots[side] || files.has(card.cardId)) continue;
      const name = `${scenario.id}-${card.fundProductCode}-${side}-items`;
      files.set(card.cardId, path.join('screenshots', `${fileSafe(name)}.png`));
    }
  }
  const absolute = new Map(
    [...files].map(([cardId, file]) => [cardId, path.join(session.folder, file)]),
  );
  const captured = await screenshotDetailedCards(session.pages[tab.key], absolute);
  for (const result of shot) {
    for (const [side, card] of Object.entries(cardsOf(result)).filter(onTab)) {
      if (!captured.has(card.cardId) || !result.screenshots[side]) continue;
      result.itemScreenshots = { ...result.itemScreenshots, [side]: files.get(card.cardId) };
    }
  }
};

// Screenshots failing cards, a sample pass, and the page when a search failed or was sampled.
const captureEvidence = async (session, scenario, results) => {
  const { tabs } = session;
  for (const tab of tabs) await loadAllResults(session.pages[tab.key]);
  for (const result of results) {
    if (isPassingStatus(result.status) || result.status === 'duplicate') continue;
    await screenshotCards(session, scenario, result);
  }
  const sample = takeSample(session.samples, scenario, results);
  if (sample) await screenshotCards(session, scenario, sample);
  for (const tab of tabs) {
    try {
      await screenshotItems(session, scenario, results, tab);
    } catch (error) {
      say(
        `    Selected items screenshots skipped${tab.label ? ` on ${tab.label}` : ''} (${error.message})`,
      );
    }
  }
  if (!hasFailingRow(results) && !sample && session.config.screenshots !== 'all') {
    return { screenshot: null };
  }
  const shots = {};
  for (const tab of tabs) {
    const page = session.pages[tab.key];
    await loadAllResults(page);
    const name = tab.label ? `${scenario.id}-${tab.key}-page` : `${scenario.id}-page`;
    shots[tab.key] = await saveScreenshot(session, name, target => screenshotPage(page, target));
  }
  // One environment keeps its single page screenshot; two record one per side.
  return shots.both !== undefined
    ? { screenshot: shots.both }
    : { screenshot: null, pageScreenshots: shots };
};

const signed = cents => `${cents > 0 ? '+' : ''}${formatCents(cents)}`;

const label = result => {
  const [code, , , , excess] = result.key.split('|');
  return `${code} excess ${excess}`;
};

const filePrice = result =>
  result.rateRow ? `file ${formatCents(result.rateRow.monthlyPremiumCents)}` : '';

const otherFields = result => {
  const fields = (result.fieldDifferences ?? [])
    .map(difference => difference.field)
    .filter(field => field !== 'price');
  return fields.length ? `  also differs: ${fields.join(', ')}` : '';
};

// One console line per result, naming the funds by code.
const describeResult = (result, expectedCode, actualCode) => {
  const priceOf = card => card.priceText ?? 'no price';
  switch (result.status) {
    case 'match':
      return `MATCH              ${label(result)}  ${priceOf(result.expected)}  ${filePrice(result)}`;
    case 'difference':
      return (
        `DIFFERENCE         ${label(result)}  ${expectedCode} ${priceOf(result.expected)}  ` +
        `${actualCode} ${priceOf(result.actual)}  delta ${signed(result.deltaCents)}  ${filePrice(result)}` +
        otherFields(result)
      );
    case 'missing-actual':
      return `MISSING ${actualCode.padEnd(11)}${label(result)}  ${expectedCode} ${priceOf(result.expected)}  ${filePrice(result)}`;
    case 'missing-expected':
      return `MISSING ${expectedCode.padEnd(11)}${label(result)}  ${actualCode} ${priceOf(result.actual)}  ${filePrice(result)}`;
    case 'missing-both':
      return `MISSING BOTH       ${label(result)}  ${filePrice(result)}`;
    case 'duplicate':
      return (
        `DUPLICATE          ${label(result)}  ${expectedCode} cards ${result.expectedCards.length}, ` +
        `${actualCode} cards ${result.actualCards.length}`
      );
    case 'breakdown-not-read':
      return (
        `BREAKDOWN NOT READ ${label(result)}  ${result.breakdownNotRead.map(side => (side === 'expected' ? expectedCode : actualCode)).join(', ')}  ` +
        `${expectedCode} ${priceOf(result.expected)}  ${actualCode} ${priceOf(result.actual)}`
      );
    case 'price-not-read':
      return `PRICE NOT READ     ${label(result)}  ${filePrice(result)}`;
    case 'benefits-not-read':
      return `BENEFITS NOT READ  ${label(result)}  ${result.benefitsNotRead.map(side => (side === 'expected' ? expectedCode : actualCode)).join(', ')}`;
    case 'unexpected': {
      const code = result.side === 'expected' ? expectedCode : actualCode;
      return `UNEXPECTED ${code.padEnd(8)}${label(result)}  ${priceOf(result.card)}  (${result.card.productName})`;
    }
    default:
      return `${result.status} ${result.key}`;
  }
};

const describeSearch = search => `${search.state} · ${search.membershipType} · ${search.coverType}`;

const minutes = ms => `${Math.round(ms / 60000)}m`;

// Enters the search on one tab and reads its cards; the tab is reused so the next search starts from the form.
const searchOnTab = async (session, tab, scenario) => {
  let page = session.pages[tab.key];
  if (page) {
    await backToForm(page);
  } else {
    page = await session.browsers[tab.key].newPage();
    session.pages[tab.key] = page;
    await openLead(page, tab.baseUrl, tab.leadId, tab.credentials);
  }
  await enterSearch(page, scenario.search);
  await enterProfile(page, scenario.profile);
  await openComparison(page);
  await filterToFunds(page, tab.fundNames);
  await loadAllResults(page);
  return (await readAllCards(page)).map(record => ({ ...record, ...scenario.search }));
};

// Prefixes a two-environment tab's error with its side, e.g. "localhost:3001 (expected): ...".
const onTab = async (tab, work) => {
  try {
    return await work();
  } catch (error) {
    if (tab.label) {
      error.message = `${tab.label}: ${error.message}`;
      error.side = tab.key;
    }
    throw error;
  }
};

// Runs one search on every tab at once, each in its own browser, so the two sides are read together.
const runScenario = async (session, config, scenario) => {
  const cards = { expected: [], actual: [] };
  let otherFunds = 0;
  // Every side finishes before a failure is raised, so the retry never overlaps a side still running.
  const searches = await Promise.allSettled(
    session.tabs.map(tab => onTab(tab, () => searchOnTab(session, tab, scenario))),
  );
  const failed = searches.find(search => search.status === 'rejected');
  if (failed) throw failed.reason;
  for (const [index, tab] of session.tabs.entries()) {
    const records = searches[index].value;
    for (const side of tab.sides) {
      cards[side] = records.filter(record => record.fundName === config[`${side}Fund`].name);
    }
    otherFunds += records.length - tab.sides.reduce((sum, side) => sum + cards[side].length, 0);
  }
  const results = compareWithRateFile(
    scenario.rateRows,
    cards.expected,
    cards.actual,
    config.expectedNameDifferences,
  );
  let evidence = { screenshot: null };
  try {
    evidence = await captureEvidence(session, scenario, results);
  } catch (error) {
    say(`    Screenshots skipped (${error.message})`);
  }
  return {
    cardCounts: { expected: cards.expected.length, actual: cards.actual.length, otherFunds },
    ...evidence,
    results,
  };
};

const discardTabs = async session => {
  for (const page of Object.values(session.pages)) await page.close().catch(() => {});
  session.pages = {};
};

// Runs a scenario with one retry in fresh tabs; a repeated setup error stops the run.
const runWithRetry = async (session, config, scenario, attemptScenario = runScenario) => {
  const startedAt = Date.now();
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      if (await ensureBrowsers(session, session.launch))
        say('    The browser had closed, so a new one was opened');
      const outcome = await attemptScenario(session, config, scenario);
      return {
        status: 'done',
        attempts: attempt,
        seconds: (Date.now() - startedAt) / 1000,
        ...outcome,
      };
    } catch (error) {
      lastError = error;
      const failedPage = session.pages[error.side] ?? Object.values(session.pages)[0];
      if (attempt === ATTEMPTS && failedPage) {
        const name = `${scenario.id}${error.side ? `-${error.side}` : ''}-error`;
        lastError.screenshot = await saveScreenshot(session, name, target =>
          screenshotPage(failedPage, target),
        ).catch(() => null);
      }
      await discardTabs(session);
      if (attempt < ATTEMPTS) say(`    Attempt ${attempt} failed (${error.message}), retrying`);
    }
  }
  if (lastError instanceof SetupError) throw lastError;
  return {
    status: 'error',
    attempts: ATTEMPTS,
    seconds: (Date.now() - startedAt) / 1000,
    error: lastError.message,
    failedSide: lastError.side ?? null,
    screenshot: lastError.screenshot ?? null,
    results: [],
  };
};

const progressLine = (index, total, scenario, outcome, totals, config, startedAt, kept = 0) => {
  const { expectedFund, actualFund } = config;
  const elapsed = Date.now() - startedAt;
  const left = total > index ? `, about ${minutes((elapsed / index) * (total - index))} left` : '';
  const profile = scenario.set === 'variations' ? ` (${describeProfile(scenario.profile)})` : '';
  const head = `[${kept + index}/${kept + total}] ${describeSearch(scenario.search)}${profile}`;
  if (outcome.status === 'error') {
    return `${head}: ERROR after ${outcome.attempts} attempts: ${outcome.error}${left}`;
  }
  const counts = summarise(outcome.results);
  return (
    `${head}: ${expectedFund.code} ${outcome.cardCounts.expected} cards, ${actualFund.code} ${outcome.cardCounts.actual} cards, ` +
    `${counts.match ?? 0}/${scenario.rateRows.length} rows match` +
    (counts['not-sold'] ? `, ${counts['not-sold']} not sold (closed, hidden on both)` : '') +
    ` in ${Math.round(outcome.seconds)}s. ` +
    `Differences so far: ${totals.difference}${left}`
  );
};

// The end-of-run totals line.
const totalsLine = (totals, config) =>
  `Totals: ${totals.searches} searches (${totals.searchesErrored} errored), ${totals.rowsChecked} rows checked, ` +
  `${totals.match} match, ${totals.difference} differ, ${totals.missingActual} missing ${config.actualFund.code}, ` +
  `${totals.missingExpected} missing ${config.expectedFund.code}, ${totals.missingBoth} missing both, ` +
  `${totals.notSold ?? 0} not sold (closed, hidden on both), ` +
  `${totals.duplicate} duplicate, ${totals.unexpected} unexpected cards, ` +
  `${totals.breakdownNotRead} breakdown not read, ${totals.priceNotRead} price not read, ` +
  `${totals.benefitsNotRead} benefits not read, ` +
  `${totals.rowsNotChecked} rows not checked`;

// The first console line, naming each side's environment and lead in two-environment mode.
const startLine = config => {
  const { expectedFund, actualFund } = config;
  const head = `Config "${config.name}": `;
  if (!isTwoEnvironment(config)) {
    return `${head}${expectedFund.code} (expected) vs ${actualFund.code} (actual), lead ${config.leadId}`;
  }
  const side = (fund, name) =>
    `${fund.code} on ${hostOf(fund.baseUrl)}, lead ${fund.leadId} (${name})`;
  return `${head}${side(expectedFund, 'expected')} vs ${side(actualFund, 'actual')}`;
};

// 0 when the run finished with a report, even a failing one, whose PASS or FAIL line gives the result;
// 1 only when no report was written. A stopped run exits 1 on its own.
const exitCodeFor = report => (report ? 0 : 1);

// Runs every scenario and returns the report, or null if it couldn't be written.
const run = async config => {
  const { expectedFund, actualFund } = config;
  say(startLine(config));

  const allRateRows = await readRateFiles(config.rateFiles, config.rateFileSheet);
  const rateRows = withMovement(allRateRows, currentRateRows(allRateRows, config.priceDate));
  const unpriced = keysWithoutPriceOn(allRateRows, config.priceDate);
  if (unpriced.length) {
    say(
      `${unpriced.length} rate file products have no price on ${config.priceDate}, so they aren't checked ` +
        `(a card shown for one counts as unexpected), e.g. ${unpriced
          .slice(0, 3)
          .map(row => `${row.sourceFile} row ${row.rowNumber}`)
          .join(', ')}`,
    );
  }
  const allScenarios = buildScenarios(rateRows, {
    profile: config.profile,
    onlySearches: config.searches,
    variations: config.variations,
    sets: config.sets,
    onlyIds: config.rerunIds,
  });
  const keptIds = new Set((config.keptScenarios ?? []).map(scenario => scenario.id));
  const scenarios = allScenarios.filter(scenario => !keptIds.has(scenario.id));
  const countIn = set => allScenarios.filter(scenario => scenario.set === set).length;
  const rowCount = allScenarios
    .filter(scenario => scenario.set === 'full-sweep')
    .reduce((sum, scenario) => sum + scenario.rateRows.length, 0);
  say(`Rate files: ${config.rateFiles.map(file => path.basename(file)).join(', ')}`);
  if (config.rateFiles.length > 1) say(`Rate file rows: ${describeRowSources(rateRows)}`);
  say(
    `Prices as at ${config.priceDate}: full sweep ${countIn('full-sweep')} searches (${rowCount} rate file rows), ` +
      `variations ${countIn('variations')} searches`,
  );
  say(`Full sweep profile: ${describeProfile(config.profile)}`);
  if (config.continueKind === 'rerun')
    say(
      `Re-running the ${scenarios.length} failed and differing searches of ${config.rerunOf}, keeping its other ${keptIds.size}`,
    );
  if (config.continueKind === 'resume')
    say(
      `Resuming ${config.continueOf}: keeping ${keptIds.size} finished searches, running ${scenarios.length}`,
    );

  const startedAt = new Date();
  const folder = config.continueOf
    ? path.dirname(config.continueOf)
    : createRunFolder(config.name, startedAt);
  const freshRecord = {
    config: {
      name: config.name,
      baseUrl: config.baseUrl,
      leadId: config.leadId,
      expectedFund,
      actualFund,
      rateFiles: config.rateFiles,
      priceDate: config.priceDate,
      profile: config.profile,
      searches: config.searches.map(
        search => `${search.state}/${search.membershipType}/${search.coverType}`,
      ),
      variationFile: config.variationFile,
      sets: config.sets,
      headless: config.headless,
      screenshots: config.screenshots,
      expectedNameDifferences: config.expectedNameDifferences,
      rerunOf: config.rerunOf ?? null,
    },
    scriptVersion: scriptVersion(),
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    stoppedBy: null,
    scenarios: [],
  };
  // A re-run or resume carries on in the previous run's folder, keeping its other searches and start time.
  const history = config.continueKind === 'rerun' ? 'reruns' : 'resumes';
  const runRecord = config.continueOf
    ? {
        ...config.continueRun,
        finishedAt: null,
        stoppedBy: null,
        [history]: [
          ...(config.continueRun[history] ?? []),
          {
            startedAt: startedAt.toISOString(),
            scriptVersion: freshRecord.scriptVersion,
            searches: scenarios.length,
          },
        ],
        scenarios: config.keptScenarios,
      }
    : freshRecord;
  const builtIds = allScenarios.map(scenario => scenario.id);
  const previousIds = (config.continueRun?.scenarios ?? []).map(scenario => scenario.id);
  // A re-run only builds its own searches, so the previous run sets the order; a resume builds them all.
  const order = [
    ...new Set(
      config.continueKind === 'rerun'
        ? [...previousIds, ...builtIds]
        : [...builtIds, ...previousIds],
    ),
  ];
  say(`Output: ${folder}`);

  // A visible browser takes its page size from the window, so the page fills the whole window.
  // Each side's window is offset so both show, and a covered window is kept running.
  const launch = (index = 0) =>
    puppeteer.launch(
      config.headless
        ? { headless: true, defaultViewport: { width: 1440, height: 900 } }
        : {
            headless: false,
            defaultViewport: null,
            args: [
              '--window-size=1440,1000',
              `--window-position=${index * 60},${index * 60}`,
              '--disable-backgrounding-occluded-windows',
            ],
            slowMo: config.slowMo,
          },
    );
  const keepOpen = config.keepOpen && !config.headless;
  let report = null;
  const session = {
    browsers: {},
    launch,
    tabs: searchTabs(config),
    pages: {},
    folder,
    config,
    samples: samplesTaken(runRecord.scenarios),
  };
  await ensureBrowsers(session, launch);
  try {
    for (const [index, scenario] of scenarios.entries()) {
      const outcome = await runWithRetry(session, config, scenario);
      const record = {
        id: scenario.id,
        set: scenario.set,
        search: scenario.search,
        profile: scenario.profile,
        rateRowCount: scenario.rateRows.length,
        ...outcome,
      };
      runRecord.scenarios = inRunOrder([...runRecord.scenarios, record], order);
      writeResults(folder, runRecord);

      const totals = runTotals(runRecord.scenarios);
      say(
        progressLine(
          index + 1,
          scenarios.length,
          scenario,
          outcome,
          totals,
          config,
          startedAt,
          keptIds.size,
        ),
      );
      outcome.results
        .filter(result => !isPassingStatus(result.status))
        .forEach(result =>
          say(`    ${describeResult(result, expectedFund.code, actualFund.code)}`),
        );
    }
  } catch (error) {
    runRecord.stoppedBy = error.message;
    throw error;
  } finally {
    runRecord.finishedAt = new Date().toISOString();
    writeResults(folder, runRecord);
    try {
      report = await writeReport(folder, runRecord);
      say(`Report: ${report.passed ? 'PASS' : 'FAIL'}, ${report.summary}`);
    } catch (error) {
      say(`Report not written (${error.message})`);
    }
    if (keepOpen) say('Browser left open on the last search. Press Ctrl+C to exit.');
    else await closeBrowsers(session);
    say(totalsLine(runTotals(runRecord.scenarios), config));
    say(`Results: ${path.join(folder, 'results.json')}`);
  }
  return report;
};

// Rebuilds the report from a run folder's results.json without the browser.
const reportOnly = async location => {
  const { file, run: runRecord } = readPreviousRun(location);
  const report = await writeReport(path.dirname(file), runRecord);
  say(`Report: ${report.passed ? 'PASS' : 'FAIL'}, ${report.summary}`);
  say(`Workbook: ${report.workbook}`);
  return report;
};

const main = () => {
  let options;
  let config;
  try {
    loadEnvFiles();
    options = parseCommandLine(process.argv.slice(2));
    if (!options['report-only']) config = loadConfig(options);
  } catch (error) {
    warn(`Setup error: ${error.message}`);
    process.exit(1);
  }
  if (!config) {
    reportOnly(options['report-only']).then(
      report => {
        process.exitCode = exitCodeFor(report);
      },
      error => {
        warn(`Report not written: ${error.message}`);
        process.exit(1);
      },
    );
    return;
  }
  keepAwake();
  run(config).then(
    report => {
      process.exitCode = exitCodeFor(report);
    },
    error => {
      warn(`Run stopped: ${error.message}`);
      process.exitCode = 1;
      if (!config.keepOpen) process.exit(1);
    },
  );
};

if (require.main === module) main();

module.exports = {
  describeResult,
  describeRowSources,
  exitCodeFor,
  reportOnly,
  run,
  runWithRetry,
  startLine,
  totalsLine,
};
