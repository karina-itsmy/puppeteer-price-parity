const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { formatCents, isPassingStatus } = require('./comparator');
const { benefitLines, checkSummary, coverageGrid } = require('./reportData');
const {
  allLines,
  countRows,
  coverageText,
  differenceLines,
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
  setTotals,
  unexpectedLines,
  verdict,
} = require('./reportLines');

const MONEY_FORMAT = '$#,##0.00;-$#,##0.00';
const PERCENT_FORMAT = '0.00"%";-0.00"%"';
const THUMBNAIL_WIDTH = 560;

const COLOURS = {
  pass: 'FFDCFCE7',
  passText: 'FF166534',
  fail: 'FFFEE2E2',
  failText: 'FF991B1B',
  error: 'FFFEF3C7',
  header: 'FFF1F5F9',
  group: 'FFE2E8F0',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pngSize = file => {
  try {
    const header = Buffer.alloc(24);
    const handle = fs.openSync(file, 'r');
    const bytesRead = fs.readSync(handle, header, 0, 24, 0);
    fs.closeSync(handle);
    if (bytesRead < 24 || !header.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    const size = { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    return size.width && size.height ? size : null;
  } catch {
    return null;
  }
};

const link = file => (file ? { text: path.basename(file), hyperlink: file } : null);

const fill = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const markCell = (cell, same) => {
  if (same === null) return;
  cell.fill = fill(same ? COLOURS.pass : COLOURS.fail);
  cell.font = { color: { argb: same ? COLOURS.passText : COLOURS.failText }, bold: !same };
};

const addSheet = (workbook, name, columns, lines) => {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(([header, key, width = 14, money]) => ({
    header,
    key,
    width,
    style: money ? { numFmt: MONEY_FORMAT } : {},
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = fill(COLOURS.header);
  for (const line of lines) {
    const row = { ...line };
    for (const [, key] of columns) {
      if (/screenshot/i.test(key)) row[key] = link(line[key]);
    }
    sheet.addRow(row);
  }
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return sheet;
};

const rowColumns = [
  ['Product', 'product', 40],
  ['Code', 'code', 12],
  ['State', 'state', 8],
  ['Membership', 'membershipType', 14],
  ['Cover', 'coverType', 10],
  ['Excess', 'excess', 8],
];
const searchColumns = [
  ['Set', 'set', 12],
  ['Search', 'search', 40],
];

const listText = check => {
  if (check.same === null && !check.total) return '—';
  if (!check.total) return 'None';
  return `${check.total - check.differ}/${check.total} same`;
};

const discountText = items =>
  items === null
    ? null
    : items.map(item => `${item.label} ${formatCents(item.value)}`).join(', ') || 'None';

const addRowsSheet = (workbook, name, lines, config, withProfile) => {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 2, xSplit: withProfile ? 8 : 7 }],
  });
  const expected = config.expectedFund.name;
  const actual = config.actualFund.name;
  const lead = [
    ['Status', 18],
    ['Product', 36],
    ['Code', 10],
    ['State', 7],
    ['Membership', 13],
    ['Cover', 10],
    ['Excess', 8],
    ...(withProfile ? [['Profile', 32]] : []),
  ];
  const groups = ['Product name', 'Price', 'Base premium', 'Rebate', 'LHC', 'Discounts'];
  const textGroups = ['Product name', 'Discounts'];
  // Movement columns only appear when the run loaded an increment.
  const withMovementColumns = lines.some(line => line.movementClass);
  const movementColumns = withMovementColumns
    ? [
        ['Previous premium', 12],
        ['Change', 10],
        ['Change %', 10],
        ['Movement', 16],
        ['Source file', 30],
      ]
    : [];
  const tail = [
    ['Hospital items', 16],
    ['Extras benefits', 16],
    ['File price', 11],
    ...movementColumns,
    [`Screenshot ${expected}`, 24],
    [`Screenshot ${actual}`, 24],
    ['Search', 36],
  ];
  const groupRow = sheet.getRow(1);
  const headerRow = sheet.getRow(2);
  lead.forEach(([header, width], index) => {
    headerRow.getCell(index + 1).value = header;
    sheet.getColumn(index + 1).width = width;
  });
  groups.forEach((group, index) => {
    const first = lead.length + index * 3 + 1;
    sheet.mergeCells(1, first, 1, first + 2);
    groupRow.getCell(first).value = group;
    groupRow.getCell(first).alignment = { horizontal: 'center' };
    [expected, actual, 'Same'].forEach((header, offset) => {
      headerRow.getCell(first + offset).value = header;
      sheet.getColumn(first + offset).width =
        offset === 2 ? 7 : group === 'Product name' ? 30 : group === 'Discounts' ? 22 : 12;
    });
  });
  const tailStart = lead.length + groups.length * 3 + 1;
  tail.forEach(([header, width], index) => {
    headerRow.getCell(tailStart + index).value = header;
    sheet.getColumn(tailStart + index).width = width;
  });
  for (const row of [groupRow, headerRow]) {
    row.font = { bold: true };
    row.eachCell(cell => {
      cell.fill = fill(row === groupRow ? COLOURS.group : COLOURS.header);
    });
  }

  for (const line of lines) {
    const byTitle = Object.fromEntries(line.checks.map(check => [check.title, check]));
    const groupValues = groups.flatMap(group => {
      const check = byTitle[group];
      const show = {
        list: discountText,
        text: value => value,
        money: value => (value === null ? null : value / 100),
      }[check.kind];
      const mark = check.expectedDifference ? 'Listed' : check.same ? '✓' : '✗';
      return [show(check.expected), show(check.actual), check.same === null ? '' : mark];
    });
    const row = sheet.addRow([
      line.statusLabel,
      line.product,
      line.code,
      line.state,
      line.membershipType,
      line.coverType,
      line.excess,
      ...(withProfile ? [line.profile] : []),
      ...groupValues,
      listText(byTitle['Hospital items']),
      listText(byTitle['Extras benefits']),
      line.filePrice,
      ...(withMovementColumns
        ? [
            line.previousPremium ?? null,
            line.movementChange ?? null,
            line.movementPercent ?? null,
            line.movementClass ?? null,
            line.sourceFile ?? null,
          ]
        : []),
      link(line.expectedScreenshot),
      link(line.actualScreenshot),
      line.search,
    ]);
    markCell(row.getCell(1), isPassingStatus(line.status));
    groups.forEach((group, index) => {
      const first = lead.length + index * 3 + 1;
      if (!textGroups.includes(group)) {
        row.getCell(first).numFmt = MONEY_FORMAT;
        row.getCell(first + 1).numFmt = MONEY_FORMAT;
      }
      markCell(
        row.getCell(first + 2),
        byTitle[group].expectedDifference ? null : byTitle[group].same,
      );
      row.getCell(first + 2).alignment = { horizontal: 'center' };
    });
    markCell(row.getCell(tailStart), byTitle['Hospital items'].same);
    markCell(row.getCell(tailStart + 1), byTitle['Extras benefits'].same);
    row.getCell(tailStart + 2).numFmt = MONEY_FORMAT;
    if (withMovementColumns) {
      row.getCell(tailStart + 3).numFmt = MONEY_FORMAT;
      row.getCell(tailStart + 4).numFmt = MONEY_FORMAT;
      row.getCell(tailStart + 5).numFmt = PERCENT_FORMAT;
    }
  }
  sheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: tailStart + tail.length - 1 },
  };
  return sheet;
};

const headingRow = (sheet, cells) => {
  const row = sheet.addRow(cells);
  row.font = { bold: true };
  row.eachCell(cell => {
    cell.fill = fill(COLOURS.header);
  });
  return row;
};

const sectionTitle = (sheet, title) => {
  sheet.addRow([]);
  sheet.addRow([title]).font = { bold: true, size: 13 };
};

const checkRows = lines =>
  lines.map(line => [
    line.title,
    line.rowsCompared,
    line.same,
    line.differ,
    line.expectedDiffer || '',
    line.notShown,
    line.list && line.itemsCompared ? line.itemsCompared : '',
    line.list && line.itemsCompared ? line.itemsDiffer : '',
  ]);

const checkHeaders = [
  'Field',
  'Rows compared',
  'Same',
  'Differ',
  'Listed renames',
  'Not on the card',
  'Items compared',
  'Items differ',
];

const addChecks = (summary, run, set) => {
  sectionTitle(summary, `What was checked (${set === 'full-sweep' ? 'full sweep' : 'variations'})`);
  headingRow(summary, checkHeaders);
  for (const values of checkRows(checkSummary(run, set))) {
    const [, rowsCompared, , differ] = values;
    markCell(summary.addRow(values).getCell(4), rowsCompared ? differ === 0 : null);
  }
};

const addSummarySheet = (workbook, run, totals) => {
  const { config } = run;
  const result = passed(run, totals) ? 'PASS' : 'FAIL';
  const bySet = setTotals(run);
  const summary = workbook.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  summary.columns = [{ width: 36 }, ...Array(13).fill({ width: 16 })];

  summary.addRow(['Price parity report']).font = { bold: true, size: 18 };
  summary.addRow([
    `${config.expectedFund.name} (expected) vs ${config.actualFund.name} (actual)`,
  ]).font = { size: 13 };
  summary.addRow([]);
  const banner = summary.addRow(['Result', result]);
  banner.font = { bold: true, size: 16 };
  banner.getCell(2).fill = fill(result === 'PASS' ? COLOURS.pass : COLOURS.fail);
  banner.getCell(2).font = {
    bold: true,
    size: 16,
    color: { argb: result === 'PASS' ? COLOURS.passText : COLOURS.failText },
  };
  banner.getCell(2).alignment = { horizontal: 'center' };
  summary.addRow(['Verdict', verdict(run, totals)]);

  sectionTitle(summary, 'Run details');
  summary.addRows(runDetails(run, totals).slice(1));

  if (bySet.fullSweep.searches) addChecks(summary, run, 'full-sweep');
  if (bySet.variations.searches) addChecks(summary, run, 'variations');

  sectionTitle(summary, 'Counts');
  headingRow(summary, ['', 'Full sweep', 'Variations']);
  summary.addRows(countRows(bySet, config));

  if (movementSummary(run)) {
    sectionTitle(summary, 'Price movement (full sweep)');
    headingRow(summary, ['Movement', 'Rows']);
    summary.addRows(Object.entries(movementCounts(run)));
  }

  const grid = coverageGrid(run);
  if (grid.rows.length) {
    sectionTitle(summary, 'Coverage (full sweep): rows that match per search');
    headingRow(summary, ['State', ...grid.columns]);
    for (const { state, cells } of grid.rows) {
      const row = summary.addRow([state, ...cells.map(coverageText)]);
      cells.forEach((cell, index) => {
        if (!cell) return;
        const target = row.getCell(index + 2);
        target.fill = fill(
          { pass: COLOURS.pass, fail: COLOURS.fail, error: COLOURS.error }[cell.status],
        );
        target.alignment = { horizontal: 'center' };
      });
    }
  }

  sectionTitle(summary, 'Full sweep differences by product');
  headingRow(summary, ['Product', 'Rows', 'Fields', 'Smallest price delta', 'Largest price delta']);
  const groups = productGroups(differenceLines(run));
  if (!groups.length) summary.addRow(['None']);
  for (const group of groups) {
    const row = summary.addRow([
      group.product,
      group.rows,
      group.fields,
      group.smallestDelta,
      group.largestDelta,
    ]);
    row.getCell(4).numFmt = MONEY_FORMAT;
    row.getCell(5).numFmt = MONEY_FORMAT;
  }
  summary.getColumn(1).font = { bold: true };
};

const addBenefitsSheet = (workbook, run, config) => {
  const sheet = addSheet(
    workbook,
    'Benefits',
    [
      ['Product', 'product', 40],
      ['Type', 'type', 10],
      ['Item', 'item', 50],
      [config.expectedFund.name, 'expected', 14],
      [config.actualFund.name, 'actual', 14],
      ['Same', 'sameMark', 7],
      ['States', 'states', 28],
      ['Rows', 'rows', 7],
    ],
    benefitLines(run).map(line => ({ ...line, sameMark: line.same ? '✓' : '✗' })),
  );
  sheet.eachRow((row, number) => {
    if (number > 1) markCell(row.getCell(6), row.getCell(6).value === '✓');
  });
};

const moreFailing = more =>
  `${more} more failing screenshots are in the screenshots folder and linked from the other sheets.`;

const morePagesNote = morePages =>
  `${morePages} more whole-page screenshots of failing searches are in the screenshots folder.`;

const addEvidenceSheet = (workbook, run, config, folder) => {
  const sheet = workbook.addWorksheet('Evidence', { views: [{ showGridLines: false }] });
  sheet.getColumn(1).width = 110;
  const { entries, more, morePages } = evidenceEntries(run, config);
  sheet.addRow(['Evidence']).font = { bold: true, size: 16 };
  const shown = entries.filter(entry => folder && pngSize(path.join(folder, entry.file)));
  if (!shown.length) {
    sheet.addRow(['No screenshots were taken.']);
    return;
  }
  let group = null;
  for (const entry of shown) {
    if (entry.group !== group) {
      if (group === 'Failing' && more) sheet.addRow([moreFailing(more)]);
      group = entry.group;
      sheet.addRow([]);
      sheet.addRow([group]).font = { bold: true, size: 14 };
    }
    const size = pngSize(path.join(folder, entry.file));
    sheet.addRow([]);
    sheet.addRow([entry.label]).font = { bold: true };
    sheet.addRow([{ text: 'Open full size', hyperlink: entry.file }]).font = {
      color: { argb: 'FF2563EB' },
      underline: true,
    };
    const width = Math.min(size.width, THUMBNAIL_WIDTH);
    const height = Math.round((size.height * width) / size.width);
    const image = workbook.addImage({ filename: path.join(folder, entry.file), extension: 'png' });
    sheet.addImage(image, { tl: { col: 0, row: sheet.rowCount }, ext: { width, height } });
    // Rows are 20 pixels high by default, so leave enough empty rows under the image.
    for (let row = 0; row < Math.ceil(height / 20); row += 1) sheet.addRow([]);
  }
  if (group === 'Failing' && more) sheet.addRow([moreFailing(more)]);
  if (morePages) sheet.addRow([morePagesNote(morePages)]);
};

// Builds the Excel report workbook.
const buildWorkbook = (run, totals, folder) => {
  const { config } = run;
  const expected = config.expectedFund.name;
  const actual = config.actualFund.name;
  const workbook = new ExcelJS.Workbook();

  addSummarySheet(workbook, run, totals);
  addSheet(
    workbook,
    'Differences',
    [
      ...rowColumns,
      ['Field', 'field', 30],
      [`Expected (${expected})`, 'expected', 14, true],
      [`Actual (${actual})`, 'actual', 14, true],
      ['Delta', 'delta', 10, true],
      ['File price', 'filePrice', 12, true],
      ...searchColumns,
      [`Screenshot ${expected}`, 'expectedScreenshot', 30],
      [`Screenshot ${actual}`, 'actualScreenshot', 30],
    ],
    differenceLines(run),
  );
  addSheet(
    workbook,
    'Expected differences',
    [
      ['Code', 'code', 12],
      [`Name (${expected})`, 'expected', 40],
      [`Name (${actual})`, 'actual', 40],
      ['Rows', 'rows', 8],
      ['Searches', 'searches', 10],
      ['Seen', 'seen', 20],
    ],
    expectedDifferenceLines(run),
  );
  if (movementSummary(run)) {
    addSheet(
      workbook,
      'Price movement',
      [
        ['Product', 'product', 40],
        ['Movement', 'movement', 14],
        ['Rows', 'rows', 8],
        ['Smallest change', 'smallestChange', 14, true],
        ['Largest change', 'largestChange', 14, true],
        ['Smallest %', 'smallestPercent', 11],
        ['Largest %', 'largestPercent', 11],
        ['Rows matching on both funds', 'matchedOnBoth', 16],
      ],
      movementLines(run),
    );
  }
  addSheet(
    workbook,
    'Missing',
    [
      ['Status', 'status', 22],
      ...rowColumns,
      ['File price', 'filePrice', 12, true],
      ['Shown price', 'shownPrice', 12, true],
      ...searchColumns,
      ['Screenshot', 'screenshot', 30],
    ],
    missingLines(run, config),
  );
  addSheet(
    workbook,
    'Unexpected',
    [
      ['Fund', 'fund', 16],
      ...rowColumns,
      ['Card product', 'cardProduct', 40],
      ['Price', 'price', 12, true],
      ...searchColumns,
      ['Screenshot', 'screenshot', 30],
    ],
    unexpectedLines(run, config),
  );
  addRowsSheet(workbook, 'All rows', allLines(run, config), config, false);
  addBenefitsSheet(workbook, run, config);
  addSheet(
    workbook,
    'Variation differences',
    [
      ...rowColumns,
      ['Profile', 'profile', 34],
      ['Field', 'field', 30],
      [`Expected (${expected})`, 'expected', 14, true],
      [`Actual (${actual})`, 'actual', 14, true],
      ['Delta', 'delta', 10, true],
      ['Search', 'search', 40],
      [`Screenshot ${expected}`, 'expectedScreenshot', 30],
      [`Screenshot ${actual}`, 'actualScreenshot', 30],
    ],
    differenceLines(run, 'variations'),
  );
  addRowsSheet(workbook, 'Variation rows', allLines(run, config, 'variations'), config, true);
  addSheet(
    workbook,
    'Errors',
    [
      ['Search', 'search', 40],
      ['Set', 'set', 12],
      ['Attempts', 'attempts', 10],
      ['Error', 'error', 80],
      ['Screenshot', 'screenshot', 30],
    ],
    errorLines(run),
  );
  addEvidenceSheet(workbook, run, config, folder);
  return workbook;
};

module.exports = { buildWorkbook };
