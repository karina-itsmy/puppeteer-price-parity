import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRunFolder,
  hasFailingRow,
  inRunOrder,
  readPreviousRun,
  runTotals,
  samplesTaken,
  scenariosToKeep,
  scenariosToRerun,
  takeSample,
  writeResults,
} from './runResults';

const result = status => ({ key: 'S3P-V|VIC|single|hospital|750', status });

const scenarios = [
  {
    id: 'VIC-single-hospital-age40-base-nolhc',
    status: 'done',
    rateRowCount: 3,
    results: [
      result('match'),
      result('difference'),
      result('missing-actual'),
      result('unexpected'),
    ],
  },
  {
    id: 'NSW-single-hospital-age40-base-nolhc',
    status: 'done',
    rateRowCount: 2,
    results: [result('match'), result('missing-both')],
  },
  {
    id: 'WA-single-hospital-age40-base-nolhc',
    status: 'error',
    rateRowCount: 4,
    error: 'Results did not finish loading within 90s',
    results: [],
  },
];

let directory;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'price-parity-run-'));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('runTotals', () => {
  it('adds up results across searches and counts errored rows as not checked', () => {
    expect(runTotals(scenarios)).toEqual({
      searches: 3,
      searchesErrored: 1,
      rowsChecked: 5,
      rowsNotChecked: 4,
      match: 2,
      difference: 1,
      missingExpected: 0,
      missingActual: 1,
      missingBoth: 1,
      notSold: 0,
      duplicate: 0,
      unexpected: 1,
      breakdownNotRead: 0,
      priceNotRead: 0,
      benefitsNotRead: 0,
    });
  });

  it('counts a closed product hidden on both funds as not sold, not missing', () => {
    const hidden = {
      id: 'VIC-single-hospital-age40-base-nolhc',
      status: 'done',
      rateRowCount: 1,
      results: [result('not-sold')],
    };
    expect(runTotals([hidden])).toMatchObject({ rowsChecked: 1, notSold: 1, missingBoth: 0 });
  });

  it('counts a row whose breakdown was not read on its own, as checked but not a difference', () => {
    const unread = {
      id: 'SA-couple-combined-age40-base-nolhc',
      status: 'done',
      rateRowCount: 1,
      results: [result('breakdown-not-read')],
    };
    expect(runTotals([unread])).toMatchObject({
      rowsChecked: 1,
      difference: 0,
      breakdownNotRead: 1,
    });
  });
});

describe('createRunFolder', () => {
  it('names the folder by config and start time', () => {
    const folder = createRunFolder('local', new Date(2026, 9, 19, 14, 30, 5), directory);
    expect(path.basename(folder)).toBe('local-20261019-143005');
    expect(fs.existsSync(folder)).toBe(true);
  });

  it('gives a second run started in the same second its own folder', () => {
    const startedAt = new Date(2026, 9, 19, 14, 30, 5);
    createRunFolder('local', startedAt, directory);
    const second = createRunFolder('local', startedAt, directory);
    expect(path.basename(second)).toBe('local-20261019-143005-2');
  });
});

describe('writeResults', () => {
  it('writes every scenario, the run details and the totals', () => {
    const run = {
      config: { name: 'local', leadId: '111', expectedFund: { code: 'cps' } },
      startedAt: '2026-10-19T03:30:05.000Z',
      finishedAt: '2026-10-19T04:30:05.000Z',
      scenarios,
    };
    const file = writeResults(directory, run);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.config.leadId).toBe('111');
    expect(written.scenarios).toHaveLength(3);
    expect(written.totals).toMatchObject({ rowsChecked: 5, difference: 1, searchesErrored: 1 });
  });
});

describe('hasFailingRow', () => {
  it('is false when every row matched', () => {
    expect(hasFailingRow([{ status: 'match' }, { status: 'match' }])).toBe(false);
  });

  it('counts a duplicate as failing, since it fails the run', () => {
    expect(hasFailingRow([{ status: 'match' }, { status: 'duplicate' }])).toBe(true);
  });

  it('passes a search whose only other rows are closed products hidden on both funds', () => {
    expect(hasFailingRow([{ status: 'match' }, { status: 'not-sold' }])).toBe(false);
    expect(hasFailingRow([{ status: 'not-sold' }, { status: 'missing-both' }])).toBe(true);
  });

  it('is false for a search with no rows', () => {
    expect(hasFailingRow([])).toBe(false);
  });
});

describe('scenariosToRerun', () => {
  it('picks the searches that errored or had any row that did not match', () => {
    const allMatch = {
      id: 'VIC-family-hospital-age40-base-nolhc',
      status: 'done',
      rateRowCount: 1,
      results: [result('match')],
    };
    expect(scenariosToRerun({ scenarios: [...scenarios, allMatch] })).toEqual([
      'VIC-single-hospital-age40-base-nolhc',
      'NSW-single-hospital-age40-base-nolhc',
      'WA-single-hospital-age40-base-nolhc',
    ]);
  });
});

describe('readPreviousRun', () => {
  it('reads the results from a run folder or straight from its results file', () => {
    const file = writeResults(directory, { config: { name: 'local' }, scenarios });
    expect(readPreviousRun(directory).file).toBe(file);
    expect(readPreviousRun(file).run.scenarios).toHaveLength(3);
  });

  it('says where it looked when there are no results', () => {
    expect(() => readPreviousRun(directory)).toThrow('No results file at');
  });
});

describe('takeSample', () => {
  const pair = { status: 'match', expected: { cardId: 'a' }, actual: { cardId: 'b' } };
  const sampleScenario = (state, membershipType, coverType, set = 'full-sweep') => ({
    set,
    search: { state, membershipType, coverType },
  });

  it('picks a matching pair only when every row in the search matched', () => {
    const taken = new Set();
    expect(
      takeSample(taken, sampleScenario('ACT', 'single', 'hospital'), [pair, result('difference')]),
    ).toBeNull();
    expect(takeSample(taken, sampleScenario('ACT', 'single', 'hospital'), [pair])).toBe(pair);
  });

  it('takes one sample per membership and cover type, up to 6 in the full sweep and 2 in the variations', () => {
    const taken = new Set();
    const take = (...args) => takeSample(taken, sampleScenario(...args), [pair]);
    expect(take('ACT', 'single', 'hospital')).toBe(pair);
    // The same membership and cover type in another state is skipped.
    expect(take('NSW', 'single', 'hospital')).toBeNull();
    for (const kind of ['extras', 'combined']) expect(take('ACT', 'single', kind)).toBe(pair);
    for (const kind of ['hospital', 'extras', 'combined'])
      expect(take('ACT', 'couple', kind)).toBe(pair);
    expect(take('ACT', 'family', 'hospital')).toBeNull();

    expect(take('VIC', 'single', 'hospital', 'variations')).toBe(pair);
    expect(take('VIC', 'family', 'hospital', 'variations')).toBe(pair);
    expect(take('NSW', 'family', 'combined', 'variations')).toBeNull();
  });
});

describe('scenariosToKeep', () => {
  it('keeps every search that finished, matching or not, and drops the ones that errored', () => {
    expect(scenariosToKeep({ scenarios }).map(scenario => scenario.id)).toEqual([
      'VIC-single-hospital-age40-base-nolhc',
      'NSW-single-hospital-age40-base-nolhc',
    ]);
  });

  it('keeps nothing from a run with no searches', () => {
    expect(scenariosToKeep({})).toEqual([]);
  });
});

describe('samplesTaken', () => {
  const finished = (state, results, set = 'full-sweep') => ({
    set,
    search: { state, membershipType: 'single', coverType: 'hospital' },
    status: 'done',
    results,
  });
  const shot = { ...result('match'), screenshots: { expected: 'a.png' } };

  it('remembers the kinds a passing search screenshotted, so a resume does not take them again', () => {
    const taken = samplesTaken([
      finished('VIC', [shot]),
      finished('NSW', [result('match')], 'variations'),
    ]);
    expect([...taken]).toEqual(['full-sweep single hospital']);
    expect(
      takeSample(taken, finished('ACT', []), [
        { ...shot, actual: { cardId: 'b' }, expected: { cardId: 'a' } },
      ]),
    ).toBeNull();
  });

  it('ignores failing searches, whose screenshots are evidence rather than samples', () => {
    const failing = { ...result('difference'), screenshots: { expected: 'a.png' } };
    expect(samplesTaken([finished('VIC', [failing])]).size).toBe(0);
  });
});

describe('inRunOrder', () => {
  it('sorts records into the run order, with records the run does not know about last', () => {
    const records = [{ id: 'c' }, { id: 'stray' }, { id: 'a' }];
    expect(inRunOrder(records, ['a', 'b', 'c']).map(record => record.id)).toEqual([
      'a',
      'c',
      'stray',
    ]);
  });
});
