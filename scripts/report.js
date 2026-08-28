const fs = require('fs');
const path = require('path');

const COMPARE_FILE = path.join(__dirname, '..', 'compare-results.json');
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function generateReport() {
  console.log('📝 Generating report...');

  if (!fs.existsSync(COMPARE_FILE)) {
    console.error('❌ No comparison results found. Run compare.js first.');
    process.exit(1);
  }

  const results = JSON.parse(fs.readFileSync(COMPARE_FILE, 'utf-8'));
  const s = results.summary;
  const date = new Date(results.timestamp).toISOString().split('T')[0];

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = path.join(REPORTS_DIR, `${date}.md`);

  // ---- Honest status -------------------------------------------------------
  // A run is only "ALL OK" when nothing was blocked, nothing errored, nothing
  // changed visually, no baseline is missing, AND no functional issues (broken
  // images / links / hover errors) were found. Previously the status ignored
  // blocked pages and every functional issue and reported ✅ regardless.
  const hasHardFailure = s.blocked > 0 || s.errors > 0;
  const hasWarnings = s.changed > 0 || s.noBaseline > 0 || s.functionalIssues > 0;

  let status;
  let exitCode = 0;
  if (hasHardFailure) {
    status = '❌ ACTION REQUIRED';
    exitCode = 1;
  } else if (hasWarnings) {
    status = '⚠️ REVIEW NEEDED';
    exitCode = 1;
  } else {
    status = '✅ ALL OK';
  }

  let report = `# QA Report - ${date}\n\n`;

  report += `## Summary\n\n`;
  report += `| Metric | Value |\n`;
  report += `|--------|-------|\n`;
  report += `| Pages Checked | ${s.total} |\n`;
  report += `| OK | ${s.ok} |\n`;
  report += `| Visually Changed | ${s.changed} |\n`;
  report += `| No Baseline | ${s.noBaseline} |\n`;
  report += `| Blocked (bot protection) | ${s.blocked} |\n`;
  report += `| Capture Errors | ${s.errors} |\n`;
  report += `| Broken Images | ${s.brokenImages} |\n`;
  report += `| Broken Links | ${s.brokenLinks} |\n`;
  report += `| Hover Errors | ${s.hoverErrors} |\n`;
  report += `| Timestamp | ${results.timestamp} |\n\n`;

  report += `**Status: ${status}**\n\n`;

  if (s.blocked > 0) {
    report +=
      `> ⛔ **${s.blocked} page capture(s) were blocked by bot protection** and are NOT valid results. ` +
      `The site (Cloudflare) served a "verify you are human" challenge instead of the real page. ` +
      `Provide a valid \`CF_CLEARANCE\` cookie or run from an allow-listed IP, then regenerate baselines.\n\n`;
  }

  report += `## Detailed Results\n\n`;

  for (const page of results.pages) {
    report += `### ${page.name}\n\n`;

    if (page.status === 'blocked') {
      report += `- ⛔ Blocked by bot protection${page.challengeTitle ? ` ("${page.challengeTitle}")` : ''}\n`;
      report += `- This is not a real capture of the page.\n\n`;
      continue;
    }

    if (page.status === 'error') {
      report += `- ❌ Capture error: ${page.error}\n\n`;
      continue;
    }

    if (page.status === 'no-baseline') {
      report += `- ⚠️ No baseline found - run baseline capture first\n\n`;
    } else if (page.status === 'no-current') {
      report += `- ❌ No current screenshot captured\n\n`;
    } else if (page.status === 'ok') {
      report += `- ✅ Visual check passed\n`;
      report += `- Diff: ${page.diffPercent}%\n\n`;
    } else if (page.status === 'changed') {
      report += `- ⚠️ Visual changes detected\n`;
      report += `- Diff: ${page.diffPercent}%\n`;
      report += `- Changed pixels: ${page.diffPixels.toLocaleString()} / ${page.totalPixels.toLocaleString()}\n`;
      if (page.diffPath) report += `- Diff image: \`${page.diffPath}\`\n`;
      report += `\n`;
    } else if (page.status === 'size-mismatch') {
      report += `- ❌ Screenshot size mismatch (page content length changed, or baseline is stale)\n`;
      report += `- Baseline: ${page.baselineSize.width}x${page.baselineSize.height}\n`;
      report += `- Current: ${page.currentSize.width}x${page.currentSize.height}\n\n`;
    }

    if (page.brokenImages && page.brokenImages.length > 0) {
      report += `#### Broken Images (${page.brokenImages.length})\n\n`;
      for (const img of page.brokenImages) {
        report += `- ❌ \`${img.src || '(no src)'}\`\n`;
        if (img.alt) report += `  - Alt: ${img.alt}\n`;
      }
      report += `\n`;
    }

    if (page.brokenLinks && page.brokenLinks.length > 0) {
      report += `#### Broken Links (${page.brokenLinks.length})\n\n`;
      for (const link of page.brokenLinks) {
        report += `- ❌ [${link.text}](${link.href}) - Status: ${link.status}\n`;
      }
      report += `\n`;
    }

    if (page.hoverResults && page.hoverResults.length > 0) {
      const errors = page.hoverResults.filter((h) => h.error);
      const noEffect = page.hoverResults.filter((h) => !h.error && !h.changed);
      const working = page.hoverResults.filter((h) => h.changed);
      report += `#### Hover States (${working.length} working / ${noEffect.length} no-effect / ${errors.length} errors)\n\n`;
      for (const hover of page.hoverResults) {
        if (hover.error) report += `- ❌ ${hover.text}: ${hover.error}\n`;
        else if (hover.changed) report += `- ✅ ${hover.text}\n`;
        else report += `- ⚠️ ${hover.text}: no hover effect\n`;
      }
      report += `\n`;
    }

    if (page.layoutShifts && page.layoutShifts.length > 0) {
      report += `#### Layout Notes (${page.layoutShifts.length})\n\n`;
      for (const shift of page.layoutShifts) {
        report += `- ⚠️ ${shift.type}: ${shift.classes || ''}\n`;
      }
      report += `\n`;
    }

    if (page.paddingIssues && page.paddingIssues.length > 0) {
      report += `#### Padding Notes\n\n`;
      for (const issue of page.paddingIssues) {
        report += `- ⚠️ ${issue.type}: ${issue.patterns} different patterns found\n`;
      }
      report += `\n`;
    }
  }

  report += `## Recommendations\n\n`;
  if (s.blocked > 0) {
    report += `1. The site is behind Cloudflare bot protection. Supply a valid \`CF_CLEARANCE\` cookie (see README) or run from an allow-listed IP.\n`;
    report += `2. Once real pages load, regenerate baselines via the "Generate Baselines" workflow.\n`;
  } else if (s.changed > 0) {
    report += `1. Review the diff images in the \`diffs/\` folder.\n`;
    report += `2. Compare with baseline screenshots in \`baselines/\`.\n`;
    report += `3. If changes are intentional, update baselines:\n`;
    report += `   \`\`\`bash\n   cp current/*.png baselines/\n   \`\`\`\n`;
  } else if (s.functionalIssues > 0) {
    report += `1. Review the broken images / links / hover errors listed above.\n`;
  } else {
    report += `No action needed. All checks passed.\n`;
  }

  report += `\n---\n`;
  report += `*Generated by californiacompetes-qa on ${results.timestamp}*\n`;

  fs.writeFileSync(reportPath, report);
  console.log(`✅ Report saved to: ${reportPath} (status: ${status})`);

  // Surface failures to CI via exit code.
  process.exitCode = exitCode;

  return { reportPath, report, status, exitCode };
}

if (require.main === module) {
  generateReport();
}

module.exports = { generateReport };
