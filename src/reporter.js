const fs = require('fs');
const path = require('path');
const { differenceLines, passed, productGroups, setTotals, verdict } = require('./reportLines');
const { runTotals, timestamp } = require('./runResults');
const { buildSummaryHtml } = require('./summaryPage');
const { buildWorkbook } = require('./workbook');

// Writes the timestamped workbook and summary page; returns whether the run passed.
const writeReport = async (folder, run, generatedAt = new Date()) => {
  const totals = runTotals(run.scenarios);
  const stamp = timestamp(generatedAt);
  const workbookName = `report-${stamp}.xlsx`;
  await buildWorkbook(run, totals, folder).xlsx.writeFile(path.join(folder, workbookName));
  const summaryFile = path.join(folder, `summary-${stamp}.html`);
  fs.writeFileSync(summaryFile, buildSummaryHtml(run, totals, workbookName, folder));
  return {
    workbook: path.join(folder, workbookName),
    summary: summaryFile,
    passed: passed(run, totals),
  };
};

module.exports = { differenceLines, passed, productGroups, setTotals, verdict, writeReport };
