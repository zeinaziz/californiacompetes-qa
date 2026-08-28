const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

const BASELINE_DIR = path.join(__dirname, '..', 'baselines');
const CURRENT_DIR = path.join(__dirname, '..', 'current');
const DIFFS_DIR = path.join(__dirname, '..', 'diffs');
const RESULTS_FILE = path.join(__dirname, '..', 'results.json');
const COMPARE_FILE = path.join(__dirname, '..', 'compare-results.json');

const THRESHOLD = 0.001; // 0.1% tolerance for anti-aliasing

function compareImages(baselinePath, currentPath, diffPath) {
  if (!fs.existsSync(currentPath)) {
    return { status: 'no-current', diffPercent: 0 };
  }

  if (!fs.existsSync(baselinePath)) {
    return { status: 'no-baseline', diffPercent: 0 };
  }

  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
  const current = PNG.sync.read(fs.readFileSync(currentPath));

  // Handle size mismatch
  if (baseline.width !== current.width || baseline.height !== current.height) {
    return {
      status: 'size-mismatch',
      baselineSize: { width: baseline.width, height: baseline.height },
      currentSize: { width: current.width, height: current.height },
      diffPercent: 100,
    };
  }

  const { width, height } = baseline;
  const diff = new PNG({ width, height });

  const numDiffPixels = pixelmatch(
    baseline.data,
    current.data,
    diff.data,
    width,
    height,
    { threshold: THRESHOLD }
  );

  const totalPixels = width * height;
  const diffPercent = (numDiffPixels / totalPixels) * 100;

  if (numDiffPixels > 0) {
    fs.mkdirSync(path.dirname(diffPath), { recursive: true });
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
  }

  return {
    status: diffPercent > 0.1 ? 'changed' : 'ok',
    diffPercent: parseFloat(diffPercent.toFixed(4)),
    diffPixels: numDiffPixels,
    totalPixels,
    diffPath: numDiffPixels > 0 ? diffPath : null,
  };
}

// Count functional problems that were previously ignored by the summary.
function countFunctionalIssues(vp) {
  const brokenImages = (vp.brokenImages || []).length;
  const brokenLinks = (vp.brokenLinks || []).length;
  const hoverErrors = (vp.hoverResults || []).filter((h) => h.error).length;
  return { brokenImages, brokenLinks, hoverErrors };
}

function compareResultsFn() {
  console.log('🔍 Comparing screenshots with baselines...');

  [BASELINE_DIR, DIFFS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  let checkResults = {};
  if (fs.existsSync(RESULTS_FILE)) {
    checkResults = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
  }

  const out = {
    timestamp: new Date().toISOString(),
    baselineTimestamp: null,
    pages: [],
    summary: {
      total: 0,
      ok: 0,
      changed: 0,
      noBaseline: 0,
      blocked: 0,
      errors: 0,
      // functional issues found on pages that DID load — these now affect status
      functionalIssues: 0,
      brokenImages: 0,
      brokenLinks: 0,
      hoverErrors: 0,
    },
  };

  // Iterate over the CHECK results (every page × viewport), not just the
  // screenshots that happen to exist — otherwise blocked pages, which produce
  // no screenshot, would silently disappear from the report.
  const viewportNames = ['desktop', 'mobile'];

  for (const page of checkResults.pages || []) {
    for (const viewport of viewportNames) {
      const vp = page.viewports?.[viewport];
      if (!vp) continue;

      const name = `${page.name}-${viewport}`;
      out.summary.total++;

      // Blocked by bot protection — the single most important case to surface.
      if (vp.blocked) {
        out.summary.blocked++;
        console.log(`\n⛔ ${name}: blocked by bot protection`);
        out.pages.push({
          name,
          status: 'blocked',
          challengeTitle: vp.challengeTitle,
          matched: vp.matched || [],
          diffPercent: 0,
        });
        continue;
      }

      // Hard error during capture.
      if (vp.error) {
        out.summary.errors++;
        console.log(`\n❌ ${name}: capture error`);
        out.pages.push({ name, status: 'error', error: vp.error, diffPercent: 0 });
        continue;
      }

      const screenshot = `${name}.png`;
      const baselinePath = path.join(BASELINE_DIR, screenshot);
      const currentPath = path.join(CURRENT_DIR, screenshot);
      const diffPath = path.join(DIFFS_DIR, `${name}-diff.png`);

      const result = compareImages(baselinePath, currentPath, diffPath);
      const fn = countFunctionalIssues(vp);

      out.summary.brokenImages += fn.brokenImages;
      out.summary.brokenLinks += fn.brokenLinks;
      out.summary.hoverErrors += fn.hoverErrors;

      if (result.status === 'ok') out.summary.ok++;
      else if (result.status === 'changed') out.summary.changed++;
      else if (result.status === 'no-baseline') out.summary.noBaseline++;
      else out.summary.errors++;

      console.log(`\n📸 ${name}: ${result.status}` + (result.diffPercent ? ` (${result.diffPercent}%)` : ''));

      out.pages.push({
        name,
        ...result,
        functional: fn,
        brokenImages: vp.brokenImages || [],
        brokenLinks: vp.brokenLinks || [],
        hoverResults: vp.hoverResults || [],
        layoutShifts: vp.layoutShifts || [],
        paddingIssues: vp.paddingIssues || [],
      });
    }
  }

  out.summary.functionalIssues =
    out.summary.brokenImages + out.summary.brokenLinks + out.summary.hoverErrors;

  fs.writeFileSync(COMPARE_FILE, JSON.stringify(out, null, 2));
  console.log(`\n✅ Comparison results saved to: ${COMPARE_FILE}`);
  console.log(
    `   total=${out.summary.total} ok=${out.summary.ok} changed=${out.summary.changed} ` +
      `blocked=${out.summary.blocked} errors=${out.summary.errors} ` +
      `functionalIssues=${out.summary.functionalIssues}`
  );

  return out;
}

if (require.main === module) {
  compareResultsFn();
}

module.exports = { compareResults: compareResultsFn };
