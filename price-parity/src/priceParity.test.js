import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';
import {
  describeResult,
  describeRowSources,
  exitCodeFor,
  runWithRetry,
  startLine,
  totalsLine,
} from './priceParity';
import { runTotals } from './runResults';

// Loaded with require, as priceParity.js does, so its SetupError is the same class.
const { SetupError } = createRequire(import.meta.url)('./funnelDriver');

const key = 'S3J-V|VIC|single|hospital|750';

const card = (priceText, productName = 'Bronze Hospital') => ({ priceText, productName });

const rateRow = { monthlyPremiumCents: 13307 };

const lineFor = result => describeResult({ key, ...result }, 'cps', 'itsmy');

describe('describeResult', () => {
  it('shows the price and the rate file price for a match', () => {
    expect(lineFor({ status: 'match', expected: card('$100.32'), rateRow })).toBe(
      'MATCH              S3J-V excess 750  $100.32  file $133.07',
    );
  });

  it('shows both prices and a signed delta for a difference', () => {
    const line = lineFor({
      status: 'difference',
      expected: card('$100.32'),
      actual: card('$101.11'),
      deltaCents: 79,
      rateRow,
    });
    expect(line).toContain('cps $100.32  itsmy $101.11  delta +$0.79  file $133.07');
  });

  it('keeps the minus sign when the actual fund is cheaper', () => {
    const line = lineFor({
      status: 'difference',
      expected: card('$101.11'),
      actual: card('$100.32'),
      deltaCents: -79,
    });
    expect(line).toContain('delta -$0.79');
  });

  it('shows no plus sign for a difference with a zero price delta', () => {
    const line = lineFor({
      status: 'difference',
      expected: card('$100.32'),
      actual: card('$100.32'),
      deltaCents: 0,
      fieldDifferences: [{ field: 'rebate' }],
    });
    expect(line).toContain('delta $0.00');
  });

  it('names the other fields that differ, leaving out the price', () => {
    const line = lineFor({
      status: 'difference',
      expected: card('$100.32'),
      actual: card('$101.11'),
      deltaCents: 79,
      fieldDifferences: [{ field: 'price' }, { field: 'rebate' }, { field: 'LHC' }],
    });
    expect(line.endsWith('  also differs: rebate, LHC')).toBe(true);
  });

  it('says "no price" for a card whose price could not be read', () => {
    expect(lineFor({ status: 'match', expected: card(null) })).toContain('no price');
  });

  it('leaves the file price out when there is no rate file row', () => {
    expect(lineFor({ status: 'match', expected: card('$100.32') })).not.toContain('file');
  });

  it('names the fund each missing row is missing from', () => {
    expect(lineFor({ status: 'missing-actual', expected: card('$100.32') })).toMatch(
      /^MISSING itsmy\s+S3J-V excess 750 {2}cps \$100\.32/,
    );
    expect(lineFor({ status: 'missing-expected', actual: card('$101.11') })).toMatch(
      /^MISSING cps\s+S3J-V excess 750 {2}itsmy \$101\.11/,
    );
    expect(lineFor({ status: 'missing-both', rateRow })).toBe(
      'MISSING BOTH       S3J-V excess 750  file $133.07',
    );
  });

  it('counts the cards each fund showed for a duplicate', () => {
    const line = lineFor({
      status: 'duplicate',
      expectedCards: [card('$1'), card('$2')],
      actualCards: [card('$1')],
    });
    expect(line).toContain('cps cards 2, itsmy cards 1');
  });

  it('names the fund and product of an unexpected card', () => {
    const line = lineFor({ status: 'unexpected', side: 'expected', card: card('$50.00', 'Odd') });
    expect(line).toMatch(/^UNEXPECTED cps\s+S3J-V excess 750 {2}\$50\.00 {2}\(Odd\)$/);
  });

  it('falls back to the status and key for a status it does not know', () => {
    expect(lineFor({ status: 'error' })).toBe(`error ${key}`);
  });
});

describe('exitCodeFor', () => {
  it('exits 0 when a report was written, whether it passed or failed', () => {
    expect(exitCodeFor({ passed: true })).toBe(0);
    expect(exitCodeFor({ passed: false })).toBe(0);
  });

  it('exits 1 when no report was written', () => {
    expect(exitCodeFor(null)).toBe(1);
  });
});

describe('describeResult for a price that was not read', () => {
  it('names the row and the rate file price', () => {
    expect(lineFor({ status: 'price-not-read', rateRow })).toBe(
      'PRICE NOT READ     S3J-V excess 750  file $133.07',
    );
  });
});

describe('runWithRetry', () => {
  const session = () => ({
    tabs: [{ key: 'both' }],
    browsers: { both: { connected: true } },
    pages: {},
    launch: async () => ({}),
  });
  // A stand-in tab that only knows whether it was closed.
  const fakePage = () => ({
    closed: false,
    async close() {
      this.closed = true;
    },
  });
  const failingOn = (side, message) => Object.assign(new Error(message), { side });
  const scenario = { id: 'VIC-single-hospital' };
  const outcome = { cardCounts: {}, screenshot: null, results: [] };
  const failingThen = (...steps) => {
    let call = 0;
    return async () => {
      const step = steps[call++];
      if (step instanceof Error) throw step;
      return step;
    };
  };

  it('retries a failed search once and keeps the second result', async () => {
    const result = await runWithRetry(
      session(),
      {},
      scenario,
      failingThen(new Error('timeout'), outcome),
    );
    expect(result).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('records the search as errored when both attempts fail', async () => {
    const attempt = failingThen(new Error('first'), new Error('Results did not load'));
    const result = await runWithRetry(session(), {}, scenario, attempt);
    expect(result).toMatchObject({
      status: 'error',
      attempts: 2,
      error: 'Results did not load',
      results: [],
    });
  });

  it('stops the run when a setup problem survives the retry', async () => {
    const attempt = failingThen(
      new SetupError('Lead did not load'),
      new SetupError('Lead did not load'),
    );
    await expect(runWithRetry(session(), {}, scenario, attempt)).rejects.toThrow(
      'Lead did not load',
    );
  });

  it('discards both tabs when one side fails, so the retry opens both afresh', async () => {
    const tabs = { expected: fakePage(), actual: fakePage() };
    const twoTabs = { ...session(), pages: { ...tabs } };
    let pagesOnRetry;
    let call = 0;
    const attempt = async current => {
      call += 1;
      if (call === 1) throw failingOn('actual', 'localhost:3000 (actual): timeout');
      pagesOnRetry = { ...current.pages };
      return outcome;
    };
    const result = await runWithRetry(twoTabs, {}, scenario, attempt);
    expect(result.status).toBe('done');
    expect(tabs.expected.closed).toBe(true);
    expect(tabs.actual.closed).toBe(true);
    expect(pagesOnRetry).toEqual({});
  });

  it('records which side failed when both attempts fail on it', async () => {
    const attempt = failingThen(
      failingOn('expected', 'localhost:3001 (expected): Results did not load'),
      failingOn('expected', 'localhost:3001 (expected): Results did not load'),
    );
    const result = await runWithRetry(session(), {}, scenario, attempt);
    expect(result).toMatchObject({
      status: 'error',
      failedSide: 'expected',
      error: 'localhost:3001 (expected): Results did not load',
    });
  });

  it('records no side for a single-environment failure', async () => {
    const attempt = failingThen(new Error('first'), new Error('second'));
    expect((await runWithRetry(session(), {}, scenario, attempt)).failedSide).toBeNull();
  });

  it('relaunches the browser when it has closed', async () => {
    const closed = {
      ...session(),
      browsers: { both: { connected: false, close: async () => undefined } },
    };
    const result = await runWithRetry(closed, {}, scenario, async () => outcome);
    expect(result.status).toBe('done');
    expect(closed.browsers.both).toEqual({});
  });
});

describe('totalsLine', () => {
  it('lists every total, naming the funds by code', () => {
    const line = totalsLine(runTotals([]), {
      expectedFund: { code: 'cps' },
      actualFund: { code: 'itsmy' },
    });
    expect(line).toBe(
      'Totals: 0 searches (0 errored), 0 rows checked, 0 match, 0 differ, 0 missing itsmy, 0 missing cps, ' +
        '0 missing both, 0 not sold (closed, hidden on both), 0 duplicate, 0 unexpected cards, ' +
        '0 breakdown not read, 0 price not read, ' +
        '0 benefits not read, 0 rows not checked',
    );
  });
});

describe('startLine', () => {
  const expectedFund = { code: 'pho', name: 'Phoenix Health Fund' };
  const actualFund = { code: 'phx', name: 'Phoenix Test' };

  it('names one lead for a single-environment run', () => {
    expect(startLine({ name: 'dev', leadId: '42', expectedFund, actualFund })).toBe(
      'Config "dev": pho (expected) vs phx (actual), lead 42',
    );
  });

  it("names each side's environment and lead in two-environment mode", () => {
    const line = startLine({
      name: 'prod-vs-dev',
      expectedFund: { ...expectedFund, baseUrl: 'http://localhost:3001', leadId: '1' },
      actualFund: { ...actualFund, baseUrl: 'http://localhost:3000/', leadId: '2' },
    });
    expect(line).toBe(
      'Config "prod-vs-dev": pho on localhost:3001, lead 1 (expected) vs phx on localhost:3000, lead 2 (actual)',
    );
  });
});

describe('describeRowSources', () => {
  it('counts the checked rows per rate file and how many of them moved', () => {
    const rows = [
      { sourceFile: 'full.xlsx', movement: 'not in increment' },
      { sourceFile: 'full.xlsx', movement: 'not in increment' },
      { sourceFile: 'inc.xlsx', movement: 'increase' },
      { sourceFile: 'inc.xlsx', movement: 'unchanged' },
    ];
    expect(describeRowSources(rows)).toBe('2 from full.xlsx, 2 from inc.xlsx (1 moved)');
  });
});
