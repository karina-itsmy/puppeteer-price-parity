import { describe, expect, it } from 'vitest';
import { runTotals } from './runResults';
import { buildSummaryHtml } from './summaryPage';

const search = { state: 'VIC', membershipType: 'single', coverType: 'hospital' };

const profile = { age: 40, rebateTier: 'base', lhcAge: null };

const config = {
  name: 'local',
  baseUrl: 'http://localhost:3000',
  leadId: '1',
  expectedFund: { code: 'cps', name: 'see-u by HBF' },
  actualFund: { code: 'itsmy', name: 'ItsMy' },
  rateFiles: ['/rate-files/itsmy_FullLoad.xlsx'],
  priceDate: '2026-10-19',
  profile,
  screenshots: 'issues',
};

const card = (code, priceCents, productName) => ({
  ...search,
  productName,
  fundProductCode: code,
  excess: '750',
  priceText: `$${(priceCents / 100).toFixed(2)}`,
  priceCents,
  basePremiumCents: priceCents,
  rebateCents: 0,
  lhcCents: 0,
  discounts: [],
  hospitalItems: [],
  extrasBenefits: null,
});

const differenceResult = (code, productName = 'Bronze Hospital') => ({
  key: `${code}|VIC|single|hospital|750`,
  status: 'difference',
  rateRow: { productName, monthlyPremiumCents: 10000 },
  expected: card(code, 10000, productName),
  actual: card(code, 10079, productName),
  deltaCents: 79,
  fieldDifferences: [{ field: 'price', expected: 10000, actual: 10079, deltaCents: 79 }],
});

const runWith = results => ({
  config,
  startedAt: '2026-10-19T04:00:00.000Z',
  finishedAt: '2026-10-19T04:05:00.000Z',
  stoppedBy: null,
  scenarios: [
    {
      id: 'VIC-single-hospital',
      set: 'full-sweep',
      search,
      profile,
      status: 'done',
      rateRowCount: results.length,
      results,
    },
  ],
});

const summaryOf = run => buildSummaryHtml(run, runTotals(run.scenarios), 'report.xlsx', null);

describe('buildSummaryHtml', () => {
  it('escapes product names so markup in the rate file cannot break the page', () => {
    const html = summaryOf(runWith([differenceResult('S3J-V', 'Gold <b>"Plus"</b> & Co')]));
    expect(html).toContain('Gold &#60;b&#62;&#34;Plus&#34;&#60;/b&#62; &#38; Co');
    expect(html).not.toContain('<b>"Plus"</b>');
  });

  it('escapes the config name in the title', () => {
    const run = { ...runWith([]), config: { ...config, name: '</title><script>' } };
    expect(summaryOf(run)).toContain(
      '<title>Price parity &#60;/title&#62;&#60;script&#62;</title>',
    );
  });

  it('shows at most 200 lines per table and points to the workbook for the rest', () => {
    const results = Array.from({ length: 201 }, (_, index) => differenceResult(`P${index}-V`));
    const html = summaryOf(runWith(results));
    const differences = html.split('<h2>Differences (full sweep)</h2>')[1].split('<h2>')[0];
    expect(differences.match(/<tr>/g)).toHaveLength(201);
    expect(differences).toContain('Showing 200 of 201. The workbook has every line.');
  });

  it('shows every line and no note at exactly 200 lines', () => {
    const results = Array.from({ length: 200 }, (_, index) => differenceResult(`P${index}-V`));
    expect(summaryOf(runWith(results))).not.toContain('Showing 200 of');
  });

  it('labels the totals with the full sweep only when the variations did not run', () => {
    const html = summaryOf(runWith([differenceResult('S3J-V')]));
    expect(html).toContain('Rows checked (full sweep only)');
    expect(html).toContain('Totals (full sweep only):');
    expect(html).not.toContain('variations');
  });

  it('labels the totals with both sets when the variations ran', () => {
    const run = runWith([differenceResult('S3J-V')]);
    const variation = {
      ...run.scenarios[0],
      id: 'VIC-single-hospital-age65-tier3-nolhc',
      set: 'variations',
    };
    const html = summaryOf({ ...run, scenarios: [...run.scenarios, variation] });
    expect(html).toContain('Rows checked (full sweep + variations)');
    expect(html).toContain('Totals (full sweep + variations):');
  });

  it('fails a run with no searches and says nothing was found rather than throwing', () => {
    const html = summaryOf({ ...runWith([]), scenarios: [] });
    expect(html).toContain('<div class="banner FAIL">');
    expect(html).toContain('No rate file rows were checked.');
    expect(html).not.toContain('What was checked (full sweep)');
    expect(html).toContain('No screenshots were taken.');
  });

  it('passes a run where every row matches', () => {
    const match = { ...differenceResult('S3P-V'), status: 'match', fieldDifferences: [] };
    match.actual = match.expected;
    const html = summaryOf(runWith([match]));
    expect(html).toContain('<div class="banner PASS">');
    expect(html).toContain(
      '<h2>Differences (full sweep)</h2>\n<div class="scroll"><p class="none">None.</p>',
    );
  });

  it('says a run that never finished is not finished', () => {
    const html = summaryOf({ ...runWith([]), finishedAt: null });
    expect(html).toContain('not finished');
  });
});
