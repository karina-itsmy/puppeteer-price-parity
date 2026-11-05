const fs = require('fs');
const path = require('path');
const { formatCents, isPassingStatus } = require('./comparator');
const { checkSummary, coverageGrid } = require('./reportData');
const {
  allLines,
  coverageText,
  differenceLines,
  duration,
  errorLines,
  evidenceEntries,
  expectedDifferenceLines,
  missingLines,
  movementCounts,
  movementLines,
  movementSummary,
  passed,
  productGroups,
  runDetails,
  setsChecked,
  setTotals,
  unexpectedLines,
  plural,
  verdict,
} = require('./reportLines');

// Lines per table on the page; the workbook has them all.
const HTML_ROW_LIMIT = 200;

const escapeHtml = value =>
  String(value ?? '').replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

const money = value =>
  value === null || value === undefined ? '' : formatCents(Math.round(value * 100));

const percent = value =>
  value === null || value === undefined ? '' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

const htmlLink = file => (file ? `<a href="${escapeHtml(file)}">view</a>` : '');

const htmlTable = (headers, rows, total = rows.length) => {
  if (!rows.length) return '<p class="none">None.</p>';
  const head = headers.map(header => `<th>${escapeHtml(header)}</th>`).join('');
  const body = rows
    .slice(0, HTML_ROW_LIMIT)
    .map(cells => `<tr>${cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`)
    .join('\n');
  const more =
    total > HTML_ROW_LIMIT
      ? `<p class="none">Showing ${HTML_ROW_LIMIT} of ${total}. The workbook has every line.</p>`
      : '';
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${more}`;
};

const rowCells = line => [
  escapeHtml(line.product),
  escapeHtml(line.code),
  escapeHtml(`${line.state} · ${line.membershipType} · ${line.coverType}`),
  escapeHtml(line.excess),
];

const badge = (same, text) =>
  same === null
    ? `<span class="muted">${escapeHtml(text)}</span>`
    : `<span class="badge ${same ? 'ok' : 'bad'}">${escapeHtml(text)}</span>`;

const htmlChecks = lines =>
  htmlTable(
    [
      'Field',
      'Result',
      'Rows compared',
      'Same',
      'Differ',
      'Listed renames',
      'Not on the card',
      'Items compared',
    ],
    lines.map(line => [
      escapeHtml(line.title),
      line.rowsCompared
        ? badge(line.differ === 0, line.differ === 0 ? '✓ Same' : `✗ ${line.differ} differ`)
        : badge(null, 'Not on the card'),
      line.rowsCompared,
      line.same,
      line.differ,
      line.expectedDiffer || '',
      line.notShown,
      line.list && line.itemsCompared
        ? `${line.itemsCompared - line.itemsDiffer}/${line.itemsCompared} same`
        : '',
    ]),
  );

const htmlCoverage = grid => {
  if (!grid.rows.length) return '<p class="none">None.</p>';
  const head = ['State', ...grid.columns].map(name => `<th>${escapeHtml(name)}</th>`).join('');
  const body = grid.rows
    .map(
      ({ state, cells }) =>
        `<tr><th>${escapeHtml(state)}</th>${cells
          .map(cell =>
            cell
              ? `<td class="cell ${cell.status}">${escapeHtml(coverageText(cell))}</td>`
              : '<td class="cell"></td>',
          )
          .join('')}</tr>`,
    )
    .join('\n');
  return `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
};

const tile = (label, value, tone = '') =>
  `<div class="tile ${tone}"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;

const evidenceNotes = (more, morePages) => ({
  Failing: more ? `${more} more failing screenshots are in the screenshots folder.` : '',
  'Whole pages': morePages
    ? `${morePages} more whole-page screenshots of failing searches are in the screenshots folder.`
    : '',
});

const htmlEvidence = (entries, more, morePages = 0) => {
  const notes = evidenceNotes(more, morePages);
  const groups = [...new Set(entries.map(entry => entry.group))];
  return groups
    .map(group => {
      const figures = entries
        .filter(entry => entry.group === group)
        .map(
          entry =>
            `<figure><a href="${escapeHtml(entry.file)}"><img src="${escapeHtml(entry.file)}" alt="${escapeHtml(entry.label)}" loading="lazy"></a><figcaption>${escapeHtml(entry.label)}</figcaption></figure>`,
        )
        .join('\n');
      const note = notes[group] ? `<p class="none">${notes[group]}</p>` : '';
      const kind = group === 'Whole pages' ? 'evidence pages' : 'evidence';
      return `<h3>${escapeHtml(group)}</h3><div class="${kind}">${figures}</div>${note}`;
    })
    .join('\n');
};

// Builds the printable HTML summary page.
const buildSummaryHtml = (run, totals, workbookName, folder) => {
  const { config } = run;
  const expected = config.expectedFund.name;
  const actual = config.actualFund.name;
  const result = passed(run, totals) ? 'PASS' : 'FAIL';
  const differences = differenceLines(run);
  const bySet = setTotals(run);
  const variationDifferences = differenceLines(run, 'variations');
  const variationIssues = allLines(run, config, 'variations').filter(
    line => !isPassingStatus(line.status),
  );
  const shown = value => (typeof value === 'number' ? money(value) : escapeHtml(value ?? '—'));
  const missing = totals.missingActual + totals.missingExpected + totals.missingBoth;
  const hasFullSweep = bySet.fullSweep.searches > 0;
  const hasVariations = bySet.variations.searches > 0;

  const evidence = evidenceEntries(run, config);
  const thumbnails = evidence.entries.filter(
    entry => !folder || fs.existsSync(path.join(folder, entry.file)),
  );

  // A set that didn't run gets no sections, so the page only shows what was tested.
  const sections = [
    ...(hasFullSweep
      ? [
          ['What was checked (full sweep)', htmlChecks(checkSummary(run))],
          [
            'Coverage (full sweep)',
            `<p class="note">Rows that match, per search. Red cells have rows that differ, are missing or are unexpected.</p>${htmlCoverage(coverageGrid(run))}`,
          ],
          ...(movementSummary(run)
            ? [
                [
                  'Price movement (full sweep)',
                  `<p class="note">${escapeHtml(movementSummary(run))}. Previous premium is the price each row took over from in an earlier rate file. ${escapeHtml(
                    Object.entries(movementCounts(run))
                      .map(([name, count]) => `${name}: ${count}`)
                      .join(' · '),
                  )}</p>${htmlTable(
                    [
                      'Product',
                      'Movement',
                      'Rows',
                      'Smallest change',
                      'Largest change',
                      'Smallest %',
                      'Largest %',
                      'Matching on both funds',
                    ],
                    movementLines(run).map(line => [
                      escapeHtml(line.product),
                      escapeHtml(line.movement),
                      line.rows,
                      money(line.smallestChange),
                      money(line.largestChange),
                      percent(line.smallestPercent),
                      percent(line.largestPercent),
                      badge(line.matchedOnBoth === line.rows, `${line.matchedOnBoth}/${line.rows}`),
                    ]),
                  )}`,
                ],
              ]
            : []),
          [
            'Differences by product (full sweep)',
            htmlTable(
              ['Product', 'Rows', 'Fields', 'Smallest price delta', 'Largest price delta'],
              productGroups(differences).map(group => [
                escapeHtml(group.product),
                group.rows,
                escapeHtml(group.fields),
                money(group.smallestDelta),
                money(group.largestDelta),
              ]),
            ),
          ],
          [
            'Differences (full sweep)',
            htmlTable(
              [
                'Product',
                'Code',
                'Search',
                'Excess',
                'Field',
                expected,
                actual,
                'Delta',
                'File',
                expected,
                actual,
              ],
              differences.map(line => [
                ...rowCells(line),
                escapeHtml(line.field),
                shown(line.expected),
                shown(line.actual),
                money(line.delta),
                money(line.filePrice),
                htmlLink(line.expectedScreenshot),
                htmlLink(line.actualScreenshot),
              ]),
            ),
          ],
          [
            'Expected differences (listed product renames)',
            htmlTable(
              ['Code', expected, actual, 'Rows', 'Searches', 'Seen'],
              expectedDifferenceLines(run).map(line => [
                escapeHtml(line.code),
                escapeHtml(line.expected),
                escapeHtml(line.actual),
                line.rows,
                line.searches,
                badge(line.rows ? true : null, line.seen),
              ]),
            ),
          ],
          [
            'Missing, duplicate and unread rows (full sweep)',
            htmlTable(
              [
                'Status',
                'Product',
                'Code',
                'Search',
                'Excess',
                'File price',
                'Shown price',
                'Screenshot',
              ],
              missingLines(run, config).map(line => [
                escapeHtml(line.status),
                ...rowCells(line),
                money(line.filePrice),
                money(line.shownPrice),
                htmlLink(line.screenshot),
              ]),
            ),
          ],
          [
            'Unexpected cards (full sweep)',
            htmlTable(
              [
                'Fund',
                'Product',
                'Code',
                'Search',
                'Excess',
                'Card product',
                'Price',
                'Screenshot',
              ],
              unexpectedLines(run, config).map(line => [
                escapeHtml(line.fund),
                ...rowCells(line),
                escapeHtml(line.cardProduct),
                money(line.price),
                htmlLink(line.screenshot),
              ]),
            ),
          ],
        ]
      : []),
    ...(hasVariations
      ? [
          ['What was checked (variations)', htmlChecks(checkSummary(run, 'variations'))],
          [
            'Variations: differences by product',
            htmlTable(
              ['Product', 'Rows', 'Fields', 'Smallest price delta', 'Largest price delta'],
              productGroups(variationDifferences).map(group => [
                escapeHtml(group.product),
                group.rows,
                escapeHtml(group.fields),
                money(group.smallestDelta),
                money(group.largestDelta),
              ]),
            ),
          ],
          [
            'Variations: rows that do not match',
            htmlTable(
              ['Status', 'Product', 'Code', 'Search', 'Excess', 'Profile', expected, actual],
              variationIssues.map(line => [
                escapeHtml(line.statusLabel),
                ...rowCells(line),
                escapeHtml(line.profile),
                htmlLink(line.expectedScreenshot),
                htmlLink(line.actualScreenshot),
              ]),
            ),
          ],
        ]
      : []),
    [
      'Errors',
      htmlTable(
        ['Search', 'Attempts', 'Error', 'Screenshot'],
        errorLines(run).map(line => [
          escapeHtml(line.search),
          escapeHtml(line.attempts),
          escapeHtml(line.error),
          htmlLink(line.screenshot),
        ]),
      ),
    ],
    [
      'Evidence',
      thumbnails.length
        ? htmlEvidence(thumbnails, evidence.more, evidence.morePages)
        : '<p class="none">No screenshots were taken.</p>',
    ],
    [
      'Run details',
      htmlTable(
        ['', ''],
        runDetails(run, totals)
          .slice(1)
          .map(([name, value]) => [escapeHtml(name), escapeHtml(value)]),
      ),
    ],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Price parity ${escapeHtml(config.name)}</title>
<style>
  :root { --ink: #1e293b; --muted: #64748b; --line: #e2e8f0; --head: #f1f5f9;
    --ok: #dcfce7; --ok-ink: #166534; --bad: #fee2e2; --bad-ink: #991b1b; --warn: #fef3c7; }
  * { box-sizing: border-box; }
  body { font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; color: var(--ink); background: #fff; }
  main { max-width: 1200px; margin: 0 auto; padding: 32px 16px 48px; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  h2 { margin: 32px 0 8px; font-size: 18px; border-bottom: 2px solid var(--line); padding-bottom: 4px; break-after: avoid; }
  .sub { color: var(--muted); margin: 0; }
  button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--head); cursor: pointer; }
  .banner { margin: 24px 0 16px; padding: 16px 20px; border-radius: 10px; display: flex; gap: 20px; align-items: center; }
  .banner.PASS { background: var(--ok); color: var(--ok-ink); }
  .banner.FAIL { background: var(--bad); color: var(--bad-ink); }
  .banner .result { font-size: 32px; font-weight: 800; letter-spacing: 1px; }
  .banner .verdict { font-size: 16px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .tile { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .tile .value { font-size: 24px; font-weight: 700; }
  .tile .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  .tile.bad { background: var(--bad); border-color: var(--bad); color: var(--bad-ink); }
  .tile.ok { background: var(--ok); border-color: var(--ok); color: var(--ok-ink); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; margin: 8px 0 16px; font-size: 13px; }
  th, td { border: 1px solid var(--line); padding: 5px 9px; text-align: left; vertical-align: top; }
  th { background: var(--head); }
  tr { break-inside: avoid; }
  .grid { font-size: 12px; }
  .grid th, .grid td { padding: 4px 6px; }
  .grid td.cell { text-align: center; white-space: nowrap; }
  .cell.pass { background: var(--ok); color: var(--ok-ink); }
  .cell.fail { background: var(--bad); color: var(--bad-ink); font-weight: 700; }
  .cell.error { background: var(--warn); }
  .badge { padding: 1px 8px; border-radius: 999px; font-weight: 600; white-space: nowrap; }
  .badge.ok { background: var(--ok); color: var(--ok-ink); }
  .badge.bad { background: var(--bad); color: var(--bad-ink); }
  .muted, .none, .note { color: var(--muted); }
  .evidence { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  figure { margin: 0; border: 1px solid var(--line); border-radius: 8px; padding: 8px; break-inside: avoid; }
  figure img { width: 100%; height: auto; display: block; }
  .evidence.pages img { max-height: 640px; object-fit: cover; object-position: top; }
  figcaption { font-size: 12px; color: var(--muted); margin-top: 6px; }
  @page { size: A4 landscape; margin: 12mm; }
  @media print {
    main { max-width: none; padding: 0; }
    .no-print { display: none; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    a { color: inherit; text-decoration: none; }
    .scroll { overflow: visible; }
  }
</style>
</head>
<body>
<main>
<header>
  <div>
    <h1>Price parity report</h1>
    <p class="sub">${escapeHtml(expected)} (expected) vs ${escapeHtml(actual)} (actual) · prices as at ${escapeHtml(config.priceDate)} · ${escapeHtml(config.rateFiles.map(file => path.basename(file)).join(', '))}</p>
  </div>
  <div class="no-print"><button onclick="window.print()">Print or save as PDF</button> <a href="${escapeHtml(workbookName)}">${escapeHtml(workbookName)}</a></div>
</header>
<div class="banner ${result}"><div class="result">${result}</div><div class="verdict">${escapeHtml(verdict(run, totals))}</div></div>
<div class="tiles">
${tile(`Rows checked (${setsChecked(run)})`, totals.rowsChecked)}
${tile('Match', totals.match, totals.match === totals.rowsChecked && totals.rowsChecked ? 'ok' : '')}
${tile('Differ', totals.difference, totals.difference ? 'bad' : '')}
${tile('Missing', missing, missing ? 'bad' : '')}
${tile('Unexpected cards', totals.unexpected, totals.unexpected ? 'bad' : '')}
${totals.breakdownNotRead ? tile('Breakdown not read', totals.breakdownNotRead, 'bad') : ''}
${totals.priceNotRead ? tile('Price not read', totals.priceNotRead, 'bad') : ''}
${totals.benefitsNotRead ? tile('Benefits not read', totals.benefitsNotRead, 'bad') : ''}
${tile('Searches errored', totals.searchesErrored, totals.searchesErrored ? 'bad' : '')}
${tile('Searches', totals.searches)}
${tile('Run time', duration(run))}
</div>
<p class="note">Totals (${setsChecked(run)}): ${totals.rowsChecked} rows checked: ${totals.match} match, ${totals.difference} differ,
${missing} missing, ${totals.duplicate} duplicate, ${totals.unexpected} unexpected cards, ${totals.breakdownNotRead ? `${totals.breakdownNotRead} breakdown not read, ` : ''}${totals.priceNotRead ? `${totals.priceNotRead} price not read, ` : ''}${totals.benefitsNotRead ? `${totals.benefitsNotRead} benefits not read, ` : ''}${plural(totals.searchesErrored, 'search', 'searches')} errored.</p>
${sections.map(([title, body]) => `<h2>${escapeHtml(title)}</h2>\n<div class="scroll">${body}</div>`).join('\n')}
</main>
</body>
</html>
`;
};

module.exports = { buildSummaryHtml };
