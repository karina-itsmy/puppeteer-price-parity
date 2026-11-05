const fs = require('fs');
const path = require('path');
const { parseArgs, parseEnv } = require('util');
const { readPreviousRun, scenariosToKeep, scenariosToRerun } = require('./runResults');
const { defaultProfile, parseSearch } = require('./scenarios');

const configDirectory = path.join(__dirname, '..', 'config');
const toolRoot = path.join(__dirname, '..');
const scenarioSets = ['full-sweep', 'variations'];

const resumedFields = [
  'leadId',
  'rateFiles',
  'priceDate',
  'sets',
  'searches',
  'profile',
  'screenshots',
];

const today = () => {
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// Reads the command-line flags; the README lists them.
const parseCommandLine = argv => {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string' },
      lead: { type: 'string' },
      'expected-lead': { type: 'string' },
      'actual-lead': { type: 'string' },
      'rate-file': { type: 'string', multiple: true },
      'price-date': { type: 'string' },
      search: { type: 'string', multiple: true },
      headless: { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      'slow-mo': { type: 'string' },
      screenshots: { type: 'string' },
      set: { type: 'string', multiple: true },
      rerun: { type: 'string' },
      resume: { type: 'string' },
      'report-only': { type: 'string' },
    },
  });
  return values;
};

const assertFund = (fund, label) => {
  if (!fund?.code || !fund.name) {
    throw new Error(
      `Config is missing ${label}: it needs a fund code and the fund name shown in the funnel`,
    );
  }
};

const sides = ['expected', 'actual'];

// True when each fund names its own comparator, so the two funds are searched on separate tabs.
const isTwoEnvironment = config =>
  [config.expectedFund, config.actualFund].some(fund => fund?.baseUrl);

const assertEnvironments = config => {
  if (!isTwoEnvironment(config)) {
    for (const side of sides) {
      if (config[`${side}Fund`].leadId) {
        throw new Error(
          `${side}Fund has a leadId but no baseUrl. Give both funds a baseUrl and leadId, or neither`,
        );
      }
    }
    for (const field of ['baseUrl', 'leadId']) {
      if (!config[field]) throw new Error(`Config is missing ${field}`);
    }
    return;
  }
  for (const side of sides) {
    const fund = config[`${side}Fund`];
    if (!fund.baseUrl) {
      throw new Error(
        `Only one fund has a baseUrl. Give both expectedFund and actualFund a baseUrl, or neither (${side}Fund has none)`,
      );
    }
    if (!URL.canParse(fund.baseUrl)) {
      throw new Error(`${side}Fund baseUrl "${fund.baseUrl}" is not a URL`);
    }
    if (!fund.leadId) {
      throw new Error(`${side}Fund is missing leadId: each environment needs its own lead`);
    }
  }
  for (const field of ['baseUrl', 'leadId']) {
    if (config[field]) {
      throw new Error(
        `Top-level ${field} isn't used when each fund has its own baseUrl. Remove it, or move it onto the funds`,
      );
    }
  }
};

const validateConfig = config => {
  assertFund(config.expectedFund, 'expectedFund');
  assertFund(config.actualFund, 'actualFund');
  assertEnvironments(config);
  if (!Array.isArray(config.rateFiles) || !config.rateFiles.length) {
    throw new Error(
      'Config is missing rateFiles: a list of rate files in the order they were loaded',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.priceDate)) {
    throw new Error(`priceDate "${config.priceDate}" is not a YYYY-MM-DD date`);
  }
  const unknownSets = (config.sets ?? []).filter(set => !scenarioSets.includes(set));
  if (unknownSets.length) {
    throw new Error(`Unknown set ${unknownSets.join(', ')}. Use ${scenarioSets.join(' or ')}`);
  }
  if (!Number.isInteger(config.slowMo) || config.slowMo < 0) {
    throw new Error(`slowMo "${config.slowMo}" should be a whole number of milliseconds`);
  }
  if (!['issues', 'all'].includes(config.screenshots)) {
    throw new Error(`screenshots "${config.screenshots}" should be "issues" or "all"`);
  }
  const isRename = entry =>
    ['expected', 'actual'].every(field => typeof entry?.[field] === 'string') &&
    ['string', 'undefined'].includes(typeof entry.code);
  if (
    !Array.isArray(config.expectedNameDifferences) ||
    !config.expectedNameDifferences.every(isRename)
  ) {
    throw new Error(
      'Config expectedNameDifferences should be a list of { "expected", "actual" } product names, each with an optional "code"',
    );
  }
  if (config.searches !== undefined && !Array.isArray(config.searches)) {
    throw new Error('Config searches should be a list such as ["VIC/single/hospital"]');
  }
  return config;
};

// Loads config/<name>.json with command-line overrides; a resume keeps the stopped run's settings.
const loadConfig = (overrides = {}, directory = configDirectory) => {
  if (overrides.rerun && overrides.resume) {
    throw new Error('Use --rerun or --resume, not both');
  }
  const previousLocation = overrides.rerun || overrides.resume;
  const previous = previousLocation ? readPreviousRun(previousLocation) : null;
  const resumed = overrides.resume ? (previous.run.config ?? {}) : null;
  const name = overrides.config || previous?.run.config?.name || 'local';
  const configPath = path.join(directory, `${name}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No config named "${name}" (looked for ${configPath})`);
  }
  const config = {
    name,
    headless: false,
    keepOpen: false,
    slowMo: 0,
    expectedNameDifferences: [],
    screenshots: 'issues',
    ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
  };
  if (resumed) {
    for (const field of resumedFields) {
      if (resumed[field] !== undefined && resumed[field] !== null) config[field] = resumed[field];
    }
  }
  // A re-run or resume keeps each side's environment and lead from the run it continues.
  for (const side of sides) {
    const before = previous?.run.config?.[`${side}Fund`];
    if (before?.baseUrl) {
      config[`${side}Fund`] = {
        ...config[`${side}Fund`],
        baseUrl: before.baseUrl,
        leadId: before.leadId,
      };
    }
  }
  const sideLeads = sides.filter(side => overrides[`${side}-lead`]);
  if (isTwoEnvironment(config)) {
    if (overrides.lead) {
      throw new Error(
        '--lead is for a single-environment run. Use --expected-lead and --actual-lead',
      );
    }
    for (const side of sideLeads) {
      config[`${side}Fund`] = { ...config[`${side}Fund`], leadId: overrides[`${side}-lead`] };
    }
  } else if (sideLeads.length) {
    throw new Error(
      '--expected-lead and --actual-lead need a baseUrl and leadId on each fund. Use --lead',
    );
  }
  if (overrides.lead) config.leadId = overrides.lead;
  if (overrides.headless !== undefined) config.headless = overrides.headless;
  if (overrides['keep-open'] !== undefined) config.keepOpen = overrides['keep-open'];
  if (overrides['slow-mo'] !== undefined) config.slowMo = Number(overrides['slow-mo']);
  if (overrides['rate-file'])
    config.rateFiles = overrides['rate-file'].map(file => path.resolve(file));
  if (overrides.screenshots) config.screenshots = overrides.screenshots;
  if (overrides['price-date']) config.priceDate = overrides['price-date'];
  if (overrides.search) config.searches = overrides.search;
  if (overrides.set) config.sets = overrides.set;
  config.priceDate ??= today();
  validateConfig(config);
  config.rateFiles = config.rateFiles.map(file => path.resolve(directory, file));
  config.searches = (config.searches ?? []).map(parseSearch);
  config.profile = { ...defaultProfile, ...config.profile };
  config.sets ??= scenarioSets;
  // The variation searches and profiles live in their own file, so they change without code.
  if (config.variationFile) {
    config.variationFile = path.resolve(directory, config.variationFile);
    config.variations = JSON.parse(fs.readFileSync(config.variationFile, 'utf8'));
  } else {
    config.variations = null;
  }
  // A re-run or resume writes back into the previous run, keeping the searches it doesn't run again.
  if (overrides.rerun) {
    config.rerunOf = previous.file;
    config.rerunIds = scenariosToRerun(previous.run);
    if (!config.rerunIds.length) {
      throw new Error(`Nothing to re-run: every search in ${previous.file} matched`);
    }
    const rerunning = new Set(config.rerunIds);
    config.continueKind = 'rerun';
    config.continueOf = previous.file;
    config.continueRun = previous.run;
    config.keptScenarios = (previous.run.scenarios ?? []).filter(
      scenario => !rerunning.has(scenario.id),
    );
  }
  if (resumed) {
    config.continueKind = 'resume';
    config.continueOf = previous.file;
    config.continueRun = previous.run;
    config.keptScenarios = scenariosToKeep(previous.run);
    // Resuming a re-run from before re-runs wrote back picks up the failed searches of the run it re-ran.
    if (resumed.rerunOf) {
      config.rerunOf = resumed.rerunOf;
      config.rerunIds = scenariosToRerun(readPreviousRun(resumed.rerunOf).run);
    }
  }
  return config;
};

// Fills env from the tool folder's .env.local then .env, never overriding a variable already set in the shell.
const loadEnvFiles = (env = process.env, directory = toolRoot) => {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8')))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  return env;
};

// The basic-auth login for one side: PRICE_PARITY_<SIDE>_AUTH_* first, then the shared PRICE_PARITY_AUTH_*.
const credentialsFor = (side, env = process.env) => {
  const prefixes = [
    ...(side ? [`PRICE_PARITY_${side.toUpperCase()}_AUTH`] : []),
    'PRICE_PARITY_AUTH',
  ];
  const prefix = prefixes.find(candidate => env[`${candidate}_USER`]) ?? prefixes[0];
  return {
    username: env[`${prefix}_USER`],
    password: env[`${prefix}_PASSWORD`] ?? '',
    variables: `${prefix}_USER / ${prefix}_PASSWORD`,
  };
};

// e.g. "localhost:3001", naming an environment in messages and labels.
const hostOf = baseUrl => (URL.canParse(baseUrl) ? new URL(baseUrl).host : baseUrl);

// The tabs a search runs on: one filtered to both funds, or one per fund in two-environment mode.
const searchTabs = (config, env = process.env) => {
  const { expectedFund, actualFund } = config;
  if (!isTwoEnvironment(config)) {
    return [
      {
        key: 'both',
        label: null,
        sides,
        baseUrl: config.baseUrl,
        leadId: config.leadId,
        fundNames: [expectedFund.name, actualFund.name],
        credentials: credentialsFor(null, env),
      },
    ];
  }
  return sides.map(side => {
    const fund = config[`${side}Fund`];
    return {
      key: side,
      label: `${hostOf(fund.baseUrl)} (${side})`,
      sides: [side],
      baseUrl: fund.baseUrl,
      leadId: fund.leadId,
      fundNames: [fund.name],
      credentials: credentialsFor(side, env),
    };
  });
};

module.exports = {
  credentialsFor,
  hostOf,
  isTwoEnvironment,
  loadConfig,
  loadEnvFiles,
  parseCommandLine,
  searchTabs,
};
