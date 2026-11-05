import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialsFor,
  isTwoEnvironment,
  loadConfig,
  loadEnvFiles,
  parseCommandLine,
  searchTabs,
} from './config';

const validConfig = {
  baseUrl: 'http://localhost:3000',
  leadId: '111',
  expectedFund: { code: 'cps', name: 'see-u by HBF' },
  actualFund: { code: 'itsmy', name: 'ItsMy' },
  rateFiles: ['rates/itsmy_FullLoad.xlsx'],
};

let directory;

const writeConfig = (name, contents) =>
  fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(contents));

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'price-parity-config-'));
  writeConfig('local', validConfig);
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads the named config and runs visibly by default', () => {
    const config = loadConfig({ config: 'local' }, directory);
    expect(config).toMatchObject({
      ...validConfig,
      name: 'local',
      headless: false,
      keepOpen: false,
      slowMo: 0,
      rateFiles: [expect.any(String)],
    });
  });

  it('reads relative rate file paths from the config folder', () => {
    const config = loadConfig({ config: 'local' }, directory);
    expect(config.rateFiles).toEqual([path.join(directory, 'rates', 'itsmy_FullLoad.xlsx')]);
  });

  it('checks prices as at today unless a price date is given', () => {
    expect(loadConfig({ config: 'local' }, directory).priceDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(loadConfig({ config: 'local', 'price-date': '2027-04-01' }, directory).priceDate).toBe(
      '2027-04-01',
    );
  });

  it('rejects a price date that is not YYYY-MM-DD', () => {
    expect(() => loadConfig({ config: 'local', 'price-date': '1/4/2027' }, directory)).toThrow(
      'not a YYYY-MM-DD date',
    );
  });

  it('lets the command line replace the rate file list', () => {
    const config = loadConfig(
      { config: 'local', 'rate-file': ['/tmp/full.xlsx', '/tmp/rise.xlsx'] },
      directory,
    );
    expect(config.rateFiles).toEqual(['/tmp/full.xlsx', '/tmp/rise.xlsx']);
  });

  it('rejects a config with no rate file', () => {
    writeConfig('broken', { ...validConfig, rateFiles: [] });
    expect(() => loadConfig({ config: 'broken' }, directory)).toThrow('rateFiles');
  });

  it('lets the command line override the lead id and headless flag', () => {
    const config = loadConfig({ config: 'local', lead: '999', headless: true }, directory);
    expect(config.leadId).toBe('999');
    expect(config.headless).toBe(true);
  });

  it('runs headless when the config file asks for it', () => {
    writeConfig('unattended', { ...validConfig, headless: true });
    expect(loadConfig({ config: 'unattended' }, directory).headless).toBe(true);
  });

  it('takes screenshots of issues by default and rejects an unknown screenshot mode', () => {
    expect(loadConfig({ config: 'local' }, directory).screenshots).toBe('issues');
    expect(loadConfig({ config: 'local', screenshots: 'all' }, directory).screenshots).toBe('all');
    expect(() => loadConfig({ config: 'local', screenshots: 'some' }, directory)).toThrow(
      'should be "issues" or "all"',
    );
  });

  it('runs both sets by default, and rejects an unknown set', () => {
    expect(loadConfig({ config: 'local' }, directory).sets).toEqual(['full-sweep', 'variations']);
    expect(loadConfig({ config: 'local', set: ['variations'] }, directory).sets).toEqual([
      'variations',
    ]);
    expect(() => loadConfig({ config: 'local', set: ['extra'] }, directory)).toThrow(
      'Unknown set extra',
    );
  });

  it('lets the command line keep the browser open after the run', () => {
    expect(loadConfig({ config: 'local', 'keep-open': true }, directory).keepOpen).toBe(true);
  });

  it('reads the listed product renames, with none by default', () => {
    expect(loadConfig({ config: 'local' }, directory).expectedNameDifferences).toEqual([]);
    const renames = [{ code: 'S3P-V', expected: 'Old name', actual: 'New name' }];
    writeConfig('renamed', { ...validConfig, expectedNameDifferences: renames });
    expect(loadConfig({ config: 'renamed' }, directory).expectedNameDifferences).toEqual(renames);
  });

  it('accepts a listed rename without a code, but not a code that is not text', () => {
    writeConfig('any', {
      ...validConfig,
      expectedNameDifferences: [{ expected: 'Old name', actual: 'New name' }],
    });
    expect(loadConfig({ config: 'any' }, directory).expectedNameDifferences).toHaveLength(1);
    writeConfig('numeric', {
      ...validConfig,
      expectedNameDifferences: [{ code: 12, expected: 'Old name', actual: 'New name' }],
    });
    expect(() => loadConfig({ config: 'numeric' }, directory)).toThrow(/expectedNameDifferences/);
  });

  it('rejects a listed rename without both names', () => {
    writeConfig('bad', {
      ...validConfig,
      expectedNameDifferences: [{ code: 'S3P-V', expected: 'Old' }],
    });
    expect(() => loadConfig({ config: 'bad' }, directory)).toThrow(/expectedNameDifferences/);
  });

  it('lets the command line slow every browser action down for filming', () => {
    expect(loadConfig({ config: 'local', 'slow-mo': '250' }, directory).slowMo).toBe(250);
  });

  it('rejects a slow-mo that is not a whole number of milliseconds', () => {
    expect(() => loadConfig({ config: 'local', 'slow-mo': 'fast' }, directory)).toThrow(
      'slowMo "NaN" should be a whole number of milliseconds',
    );
    expect(() => loadConfig({ config: 'local', 'slow-mo': '-5' }, directory)).toThrow(/slowMo/);
  });

  it('rejects an unknown config name', () => {
    expect(() => loadConfig({ config: 'dev' }, directory)).toThrow('No config named "dev"');
  });

  it('rejects a config whose fund has no display name', () => {
    writeConfig('broken', { ...validConfig, actualFund: { code: 'itsmy' } });
    expect(() => loadConfig({ config: 'broken' }, directory)).toThrow('actualFund');
  });

  it('runs every search with the default profile when the config names neither', () => {
    const config = loadConfig({ config: 'local' }, directory);
    expect(config.searches).toEqual([]);
    expect(config.profile).toEqual({ age: 40, rebateTier: 'base', lhcAge: null });
  });

  it('lets the command line narrow the run to a few searches', () => {
    writeConfig('narrow', { ...validConfig, searches: ['NSW/family/combined'] });
    const config = loadConfig({ config: 'narrow', search: ['VIC/single/hospital'] }, directory);
    expect(config.searches).toEqual([
      { state: 'VIC', membershipType: 'single', coverType: 'hospital' },
    ]);
  });

  it("re-runs the failed searches of a previous run with that run's config", () => {
    writeConfig('dev', validConfig);
    const runFolder = path.join(directory, 'dev-20261019-143005');
    fs.mkdirSync(runFolder);
    const scenario = (id, status) => ({ id, status: 'done', results: [{ status }] });
    fs.writeFileSync(
      path.join(runFolder, 'results.json'),
      JSON.stringify({
        config: { name: 'dev' },
        scenarios: [
          scenario('VIC-single-hospital-age40-base-nolhc', 'match'),
          scenario('NSW-single-hospital-age40-base-nolhc', 'difference'),
        ],
      }),
    );
    const config = loadConfig({ rerun: runFolder }, directory);
    expect(config.name).toBe('dev');
    expect(config.rerunOf).toBe(path.join(runFolder, 'results.json'));
    expect(config.rerunIds).toEqual(['NSW-single-hospital-age40-base-nolhc']);
  });

  it('writes a re-run back into the previous run, keeping the searches it does not run again', () => {
    const runFolder = path.join(directory, 'local-20261020-111137');
    fs.mkdirSync(runFolder);
    const scenario = (id, status, rowStatus) => ({
      id,
      status,
      results: rowStatus ? [{ status: rowStatus }] : [],
    });
    fs.writeFileSync(
      path.join(runFolder, 'results.json'),
      JSON.stringify({
        config: { name: 'local' },
        scenarios: [
          scenario('VIC-single-hospital-age40-base-nolhc', 'done', 'match'),
          scenario('NSW-single-hospital-age40-base-nolhc', 'done', 'difference'),
          scenario('WA-single-hospital-age40-base-nolhc', 'error'),
        ],
      }),
    );
    const config = loadConfig({ rerun: runFolder }, directory);
    expect(config.continueKind).toBe('rerun');
    expect(config.continueOf).toBe(path.join(runFolder, 'results.json'));
    expect(config.rerunIds).toEqual([
      'NSW-single-hospital-age40-base-nolhc',
      'WA-single-hospital-age40-base-nolhc',
    ]);
    expect(config.keptScenarios.map(kept => kept.id)).toEqual([
      'VIC-single-hospital-age40-base-nolhc',
    ]);
  });

  it('stops when a previous run has nothing to re-run', () => {
    const file = path.join(directory, 'results.json');
    fs.writeFileSync(file, JSON.stringify({ config: { name: 'local' }, scenarios: [] }));
    expect(() => loadConfig({ rerun: file }, directory)).toThrow('Nothing to re-run');
  });

  it("resumes a stopped run with that run's settings, keeping only its finished searches", () => {
    writeConfig('dev', validConfig);
    const runFolder = path.join(directory, 'dev-20261020-111137');
    fs.mkdirSync(runFolder);
    fs.writeFileSync(
      path.join(runFolder, 'results.json'),
      JSON.stringify({
        config: {
          name: 'dev',
          leadId: '999',
          rateFiles: ['/rates/stopped-run.xlsx'],
          priceDate: '2026-10-20',
          sets: ['variations'],
          searches: ['VIC/single/hospital'],
          screenshots: 'all',
        },
        stoppedBy: 'Could not reach the comparator',
        scenarios: [
          { id: 'VIC-single-hospital-age40-base-nolhc', status: 'done', results: [] },
          { id: 'NSW-single-hospital-age40-base-nolhc', status: 'error', results: [] },
        ],
      }),
    );
    const config = loadConfig({ resume: runFolder }, directory);
    expect(config.name).toBe('dev');
    expect(config.continueKind).toBe('resume');
    expect(config.continueOf).toBe(path.join(runFolder, 'results.json'));
    expect(config.leadId).toBe('999');
    expect(config.rateFiles).toEqual(['/rates/stopped-run.xlsx']);
    expect(config.priceDate).toBe('2026-10-20');
    expect(config.sets).toEqual(['variations']);
    expect(config.searches).toEqual([
      { state: 'VIC', membershipType: 'single', coverType: 'hospital' },
    ]);
    expect(config.screenshots).toBe('all');
    expect(config.keptScenarios.map(scenario => scenario.id)).toEqual([
      'VIC-single-hospital-age40-base-nolhc',
    ]);
    expect(config.rerunIds).toBeUndefined();
  });

  it('lets the command line override a resumed setting such as an expired lead', () => {
    const file = path.join(directory, 'results.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ config: { name: 'local', leadId: '999' }, scenarios: [] }),
    );
    expect(loadConfig({ resume: file, lead: '222' }, directory).leadId).toBe('222');
  });

  it('resumes a stopped re-run with the same failed searches it was re-running', () => {
    const original = path.join(directory, 'original.json');
    fs.writeFileSync(
      original,
      JSON.stringify({
        config: { name: 'local' },
        scenarios: [
          {
            id: 'VIC-single-hospital-age40-base-nolhc',
            status: 'done',
            results: [{ status: 'match' }],
          },
          { id: 'NSW-single-hospital-age40-base-nolhc', status: 'error', results: [] },
        ],
      }),
    );
    const stopped = path.join(directory, 'stopped.json');
    fs.writeFileSync(
      stopped,
      JSON.stringify({ config: { name: 'local', rerunOf: original }, scenarios: [] }),
    );
    const config = loadConfig({ resume: stopped }, directory);
    expect(config.rerunOf).toBe(original);
    expect(config.rerunIds).toEqual(['NSW-single-hospital-age40-base-nolhc']);
  });

  it('refuses --rerun and --resume together', () => {
    expect(() => loadConfig({ rerun: 'a', resume: 'b' }, directory)).toThrow('not both');
  });

  it('rejects searches that are not a list', () => {
    writeConfig('broken', { ...validConfig, searches: 'VIC/single/hospital' });
    expect(() => loadConfig({ config: 'broken' }, directory)).toThrow('searches should be a list');
  });
});

const twoEnvironmentConfig = {
  expectedFund: {
    code: 'pho',
    name: 'Phoenix Health Fund',
    baseUrl: 'http://localhost:3001',
    leadId: 'prod-lead',
  },
  actualFund: {
    code: 'phx',
    name: 'Phoenix Test',
    baseUrl: 'http://localhost:3000',
    leadId: 'dev-lead',
  },
  rateFiles: ['rates/phoenix_prod_FullLoad.xlsx'],
};

const withoutKeys = (object, ...keys) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

describe('loadConfig in two-environment mode', () => {
  beforeEach(() => writeConfig('prod-vs-dev', twoEnvironmentConfig));

  it('accepts a baseUrl and leadId on each fund with none at the top level', () => {
    const config = loadConfig({ config: 'prod-vs-dev' }, directory);
    expect(isTwoEnvironment(config)).toBe(true);
    expect(config.expectedFund).toMatchObject({
      baseUrl: 'http://localhost:3001',
      leadId: 'prod-lead',
    });
    expect(config.actualFund).toMatchObject({
      baseUrl: 'http://localhost:3000',
      leadId: 'dev-lead',
    });
  });

  it('keeps a single-environment config as it was', () => {
    expect(isTwoEnvironment(loadConfig({ config: 'local' }, directory))).toBe(false);
  });

  it('refuses a baseUrl on only one fund', () => {
    writeConfig('one-sided', {
      ...validConfig,
      actualFund: { ...validConfig.actualFund, baseUrl: 'http://localhost:3001', leadId: '2' },
    });
    expect(() => loadConfig({ config: 'one-sided' }, directory)).toThrow(
      'Only one fund has a baseUrl. Give both expectedFund and actualFund a baseUrl, or neither (expectedFund has none)',
    );
  });

  it('refuses a per-fund lead without per-fund baseUrls', () => {
    writeConfig('lead-only', {
      ...validConfig,
      expectedFund: { ...validConfig.expectedFund, leadId: '2' },
    });
    expect(() => loadConfig({ config: 'lead-only' }, directory)).toThrow(
      'expectedFund has a leadId but no baseUrl',
    );
  });

  it('needs a lead on each fund', () => {
    writeConfig('no-lead', {
      ...twoEnvironmentConfig,
      actualFund: withoutKeys(twoEnvironmentConfig.actualFund, 'leadId'),
    });
    expect(() => loadConfig({ config: 'no-lead' }, directory)).toThrow(
      'actualFund is missing leadId',
    );
  });

  it('refuses a fund baseUrl that is not a URL', () => {
    writeConfig('bad-url', {
      ...twoEnvironmentConfig,
      expectedFund: { ...twoEnvironmentConfig.expectedFund, baseUrl: 'localhost' },
    });
    expect(() => loadConfig({ config: 'bad-url' }, directory)).toThrow(
      'expectedFund baseUrl "localhost" is not a URL',
    );
  });

  it('refuses a top-level baseUrl or leadId alongside per-fund ones', () => {
    writeConfig('both-levels', { ...twoEnvironmentConfig, leadId: '111' });
    expect(() => loadConfig({ config: 'both-levels' }, directory)).toThrow(
      "Top-level leadId isn't used",
    );
  });

  it('takes each side its own lead from the command line', () => {
    const config = loadConfig(
      { config: 'prod-vs-dev', 'expected-lead': 'new-prod', 'actual-lead': 'new-dev' },
      directory,
    );
    expect(config.expectedFund.leadId).toBe('new-prod');
    expect(config.actualFund.leadId).toBe('new-dev');
  });

  it('refuses --lead in two-environment mode', () => {
    expect(() => loadConfig({ config: 'prod-vs-dev', lead: '1' }, directory)).toThrow(
      '--lead is for a single-environment run. Use --expected-lead and --actual-lead',
    );
  });

  it('refuses --expected-lead in a single-environment run', () => {
    expect(() => loadConfig({ config: 'local', 'expected-lead': '1' }, directory)).toThrow(
      '--expected-lead and --actual-lead need a baseUrl and leadId on each fund',
    );
  });

  it.each(['resume', 'rerun'])("keeps each side's environment and lead on --%s", kind => {
    const file = path.join(directory, 'results.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        config: {
          name: 'prod-vs-dev',
          expectedFund: { ...twoEnvironmentConfig.expectedFund, leadId: 'earlier-prod' },
          actualFund: {
            ...twoEnvironmentConfig.actualFund,
            baseUrl: 'https://poom-slot-1.itsmydev.com.au',
            leadId: 'earlier-dev',
          },
        },
        scenarios: [{ id: 'VIC-single-hospital-age40-base-nolhc', status: 'error', results: [] }],
      }),
    );
    const config = loadConfig({ [kind]: file, 'actual-lead': 'override' }, directory);
    expect(config.expectedFund).toMatchObject({
      baseUrl: 'http://localhost:3001',
      leadId: 'earlier-prod',
    });
    expect(config.actualFund).toMatchObject({
      baseUrl: 'https://poom-slot-1.itsmydev.com.au',
      leadId: 'override',
    });
  });
});

describe('searchTabs', () => {
  const env = {
    PRICE_PARITY_AUTH_USER: 'shared',
    PRICE_PARITY_AUTH_PASSWORD: 'shared-secret',
    PRICE_PARITY_EXPECTED_AUTH_USER: 'prod-user',
    PRICE_PARITY_EXPECTED_AUTH_PASSWORD: 'prod-secret',
  };

  it('searches both funds on one tab in a single-environment run', () => {
    const tabs = searchTabs(loadConfig({ config: 'local' }, directory), env);
    expect(tabs).toEqual([
      {
        key: 'both',
        label: null,
        sides: ['expected', 'actual'],
        baseUrl: 'http://localhost:3000',
        leadId: '111',
        fundNames: ['see-u by HBF', 'ItsMy'],
        credentials: {
          username: 'shared',
          password: 'shared-secret',
          variables: 'PRICE_PARITY_AUTH_USER / PRICE_PARITY_AUTH_PASSWORD',
        },
      },
    ]);
  });

  it('searches each fund on its own tab, expected first, in two-environment mode', () => {
    writeConfig('prod-vs-dev', twoEnvironmentConfig);
    const tabs = searchTabs(loadConfig({ config: 'prod-vs-dev' }, directory), env);
    expect(tabs.map(({ credentials, ...tab }) => tab)).toEqual([
      {
        key: 'expected',
        label: 'localhost:3001 (expected)',
        sides: ['expected'],
        baseUrl: 'http://localhost:3001',
        leadId: 'prod-lead',
        fundNames: ['Phoenix Health Fund'],
      },
      {
        key: 'actual',
        label: 'localhost:3000 (actual)',
        sides: ['actual'],
        baseUrl: 'http://localhost:3000',
        leadId: 'dev-lead',
        fundNames: ['Phoenix Test'],
      },
    ]);
  });
});

describe('credentialsFor', () => {
  it("uses a side's own login when set", () => {
    const env = {
      PRICE_PARITY_AUTH_USER: 'shared',
      PRICE_PARITY_EXPECTED_AUTH_USER: 'prod-user',
      PRICE_PARITY_EXPECTED_AUTH_PASSWORD: 'prod-secret',
    };
    expect(credentialsFor('expected', env)).toEqual({
      username: 'prod-user',
      password: 'prod-secret',
      variables: 'PRICE_PARITY_EXPECTED_AUTH_USER / PRICE_PARITY_EXPECTED_AUTH_PASSWORD',
    });
  });

  it('falls back to the shared login, then to none', () => {
    expect(credentialsFor('actual', { PRICE_PARITY_AUTH_USER: 'shared' })).toMatchObject({
      username: 'shared',
      password: '',
    });
    expect(credentialsFor('actual', {})).toEqual({
      username: undefined,
      password: '',
      variables: 'PRICE_PARITY_ACTUAL_AUTH_USER / PRICE_PARITY_ACTUAL_AUTH_PASSWORD',
    });
  });
});

describe('parseCommandLine', () => {
  it("reads each side's lead", () => {
    expect(parseCommandLine(['--expected-lead', '1', '--actual-lead', '2'])).toEqual({
      'expected-lead': '1',
      'actual-lead': '2',
    });
  });

  it('reads nothing when given nothing, so the config defaults to local', () => {
    expect(parseCommandLine([])).toEqual({});
    expect(loadConfig(parseCommandLine([]), directory).name).toBe('local');
  });

  it('reads the run to re-run', () => {
    expect(parseCommandLine(['--rerun', 'output/local-20261019-143005'])).toEqual({
      rerun: 'output/local-20261019-143005',
    });
  });

  it('reads the run to resume', () => {
    expect(parseCommandLine(['--resume', 'output/local-20261020-111137'])).toEqual({
      resume: 'output/local-20261020-111137',
    });
  });

  it('reads the config name, lead id and headless switch', () => {
    expect(
      parseCommandLine([
        '--config',
        'dev',
        '--lead',
        '123',
        '--rate-file',
        'x.xlsx',
        '--rate-file',
        'y.xlsx',
        '--price-date',
        '2027-04-01',
        '--search',
        'VIC/single/hospital',
        '--headless',
        '--keep-open',
        '--set',
        'variations',
      ]),
    ).toEqual({
      config: 'dev',
      lead: '123',
      'rate-file': ['x.xlsx', 'y.xlsx'],
      'price-date': '2027-04-01',
      search: ['VIC/single/hospital'],
      headless: true,
      'keep-open': true,
      set: ['variations'],
    });
  });
});

describe('the committed example config', () => {
  it('is valid', () => {
    expect(() => loadConfig({ config: 'local.example' })).not.toThrow();
  });

  it('reads the committed variation file', () => {
    const { variations } = loadConfig({ config: 'local.example' });
    expect(variations.searches.length).toBeGreaterThan(0);
    expect(variations.profiles.length).toBeGreaterThan(0);
  });
});

describe('loadEnvFiles', () => {
  it('reads .env.local over .env and keeps variables already set in the shell', () => {
    fs.writeFileSync(
      path.join(directory, '.env'),
      'PRICE_PARITY_AUTH_USER=from-env\nPRICE_PARITY_AUTH_PASSWORD=env-secret\nOTHER=env',
    );
    fs.writeFileSync(path.join(directory, '.env.local'), "PRICE_PARITY_AUTH_USER='from-local'");
    const env = loadEnvFiles({ OTHER: 'shell' }, directory);
    expect(env).toEqual({
      PRICE_PARITY_AUTH_USER: 'from-local',
      PRICE_PARITY_AUTH_PASSWORD: 'env-secret',
      OTHER: 'shell',
    });
  });

  it('leaves env alone when there are no env files', () => {
    expect(loadEnvFiles({ A: '1' }, directory)).toEqual({ A: '1' });
  });
});
