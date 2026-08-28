const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PAGES = [
  { name: 'homepage', url: 'https://californiacompetes.org/' },
  { name: 'about', url: 'https://californiacompetes.org/about/' },
  { name: 'resources', url: 'https://californiacompetes.org/resources/' },
  { name: 'podcast', url: 'https://californiacompetes.org/podcast/' },
  { name: 'contact', url: 'https://californiacompetes.org/contact/' },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
];

const BASELINE_DIR = path.join(__dirname, '..', 'baselines');
const CURRENT_DIR = path.join(__dirname, '..', 'current');
const RESULTS_FILE = path.join(__dirname, '..', 'results.json');

// A realistic desktop UA helps get past naive bot filtering. It does NOT
// defeat a full Cloudflare challenge — see detectChallenge() below.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Optional: a valid cf_clearance cookie can be supplied via env to run the
// check against the real site from a CI IP that Cloudflare would otherwise
// challenge. Format: CF_CLEARANCE=<cookie value>
const CF_CLEARANCE = process.env.CF_CLEARANCE || '';

/**
 * Detect whether the page we landed on is a bot-protection / interstitial
 * challenge rather than the real site. This is THE fix that stops the tool
 * from happily baselining and "passing" a Cloudflare "verify you are human"
 * screen.
 */
async function detectChallenge(page) {
  return await page.evaluate(() => {
    const title = (document.title || '').toLowerCase();
    const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
    const html = document.documentElement.innerHTML.toLowerCase();

    const signals = [
      'just a moment',
      'verify you are human',
      'performing security verification',
      'checking your browser',
      'attention required',
      'enable javascript and cookies to continue',
      'cf-browser-verification',
      'cf_chl_opt',
      'challenge-platform',
    ];

    const matched = signals.filter(
      (s) => title.includes(s) || bodyText.includes(s) || html.includes(s)
    );

    const hasChallengeForm =
      !!document.querySelector('#challenge-form, #challenge-stage, [id^="cf-chl"]');

    // Real pages have substantial content; challenge pages are tiny.
    const veryShort = bodyText.replace(/\s+/g, ' ').trim().length < 400;

    return {
      blocked: matched.length > 0 || hasChallengeForm,
      matched,
      title: document.title || '',
      textLength: bodyText.length,
      veryShort,
    };
  });
}

/** Wait a bit in case Cloudflare auto-clears the interstitial. */
async function waitForChallengeToClear(page, maxMs = 15000) {
  const start = Date.now();
  let last = await detectChallenge(page);
  while (last.blocked && Date.now() - start < maxMs) {
    await page.waitForTimeout(1500);
    last = await detectChallenge(page);
  }
  return last;
}

async function checkBrokenImages(page) {
  return await page.evaluate(() => {
    const images = Array.from(document.querySelectorAll('img'));
    return images
      .filter((img) => {
        // Only consider images that actually attempted to load a real URL.
        // currentSrc is empty for lazy-load placeholders that never resolved,
        // so those are NOT flagged as broken (that was a false-positive source).
        const src = img.currentSrc || img.getAttribute('src') || '';
        const hasRealSrc =
          src && !src.startsWith('data:') && !src.startsWith('blob:');
        // Broken = finished loading, has a real source, but no pixels.
        return hasRealSrc && img.complete && img.naturalWidth === 0;
      })
      .map((img) => ({
        src: img.currentSrc || img.src,
        alt: img.alt,
        width: img.naturalWidth,
        height: img.naturalHeight,
      }));
  });
}

async function checkBrokenLinks(page) {
  const links = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map((a) => ({
        href: a.href,
        text: a.textContent.trim().substring(0, 50),
      }))
      .filter(
        (link) =>
          link.href.startsWith('http') &&
          !link.href.includes('javascript:') &&
          !link.href.includes('mailto:') &&
          !link.href.includes('tel:')
      );
  });

  const broken = [];
  const checked = new Set();

  for (const link of links.slice(0, 20)) {
    if (checked.has(link.href)) continue;
    checked.add(link.href);

    try {
      const response = await page.request.fetch(link.href, {
        method: 'HEAD',
        timeout: 10000,
      });
      if (response.status() >= 400) {
        broken.push({ ...link, status: response.status() });
      }
    } catch (e) {
      broken.push({ ...link, status: 'error', error: e.message });
    }
  }

  return broken;
}

/**
 * Hover-state check, rewritten to operate on real element handles so the
 * reported label matches the element actually hovered, invisible elements
 * (e.g. the mobile menu toggle on desktop) are skipped instead of timing
 * out, and each button is only tested once.
 */
async function checkHoverStates(page) {
  const handles = await page.$$(
    'a.elementor-button, a.button, button, .elementor-button'
  );

  const results = [];
  const seen = new Set();

  for (const el of handles) {
    if (results.length >= 8) break;
    try {
      // Skip elements that are not actually visible / interactable.
      const box = await el.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;

      const text =
        (await el.evaluate((e) => e.textContent.trim().substring(0, 30))) || '(no text)';
      if (seen.has(text)) continue;
      seen.add(text);

      const before = await el.evaluate((e) => {
        const s = getComputedStyle(e);
        return {
          backgroundColor: s.backgroundColor,
          color: s.color,
          opacity: s.opacity,
          transform: s.transform,
        };
      });

      await el.hover({ timeout: 3000 });
      await page.waitForTimeout(250);

      const after = await el.evaluate((e) => {
        const s = getComputedStyle(e);
        return {
          backgroundColor: s.backgroundColor,
          color: s.color,
          opacity: s.opacity,
          transform: s.transform,
        };
      });

      const changed =
        before.backgroundColor !== after.backgroundColor ||
        before.color !== after.color ||
        before.opacity !== after.opacity ||
        before.transform !== after.transform;

      results.push({ text, changed, before, after });
    } catch (e) {
      // A genuine failure to hover a visible element is worth recording,
      // but keep the message short.
      results.push({ text: '(hover target)', error: e.message.split('\n')[0] });
    }
  }

  return results;
}

async function checkLayoutShifts(page) {
  return await page.evaluate(() => {
    const issues = [];
    const elements = Array.from(document.querySelectorAll('*'));

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const cls = el.className && el.className.toString ? el.className.toString() : '';

      if (
        style.display === 'none' &&
        el.tagName !== 'SCRIPT' &&
        el.tagName !== 'STYLE' &&
        el.tagName !== 'NOSCRIPT'
      ) {
        const responsiveHidden =
          /elementor-hidden-(desktop|tablet|mobile|tablet_extra|laptop|widescreen)/.test(cls) ||
          /hide-on|hidden-/.test(cls);

        // Only flag sections hidden for a reason we can't explain. Sections
        // intentionally hidden per breakpoint are by design, not a bug.
        if (
          !responsiveHidden &&
          (el.classList.contains('elementor-section') ||
            el.classList.contains('elementor-widget'))
        ) {
          issues.push({
            type: 'hidden-section',
            classes: cls.substring(0, 100),
            rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          });
        }
      }

      if (rect.width > window.innerWidth + 10) {
        issues.push({
          type: 'overflow',
          classes: cls.substring(0, 100),
          width: rect.width,
          viewportWidth: window.innerWidth,
        });
      }
    }

    return issues;
  });
}

async function checkPaddingConsistency(page) {
  return await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.elementor-section'));
    const paddings = sections.slice(0, 10).map((section) => {
      const s = getComputedStyle(section);
      return {
        classes: section.className.substring(0, 80),
        paddingTop: s.paddingTop,
        paddingBottom: s.paddingBottom,
        paddingLeft: s.paddingLeft,
        paddingRight: s.paddingRight,
      };
    });

    const issues = [];
    const paddingGroups = {};
    paddings.forEach((p) => {
      const key = `${p.paddingTop}-${p.paddingBottom}`;
      if (!paddingGroups[key]) paddingGroups[key] = [];
      paddingGroups[key].push(p);
    });

    if (Object.keys(paddingGroups).length > 2) {
      issues.push({
        type: 'inconsistent-padding',
        patterns: Object.keys(paddingGroups).length,
        details: paddings,
      });
    }

    return issues;
  });
}

async function runChecks() {
  console.log('🚀 Starting visual regression checks...');

  [BASELINE_DIR, CURRENT_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const results = {
    timestamp: new Date().toISOString(),
    pages: [],
  };

  for (const pageConfig of PAGES) {
    console.log(`\n📄 Checking: ${pageConfig.name} (${pageConfig.url})`);

    const pageResult = {
      name: pageConfig.name,
      url: pageConfig.url,
      viewports: {},
    };

    for (const viewport of VIEWPORTS) {
      console.log(`  📐 Viewport: ${viewport.name} (${viewport.width}x${viewport.height})`);

      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        userAgent: USER_AGENT,
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      // Hide the most obvious automation signal.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      if (CF_CLEARANCE) {
        await context.addCookies([
          {
            name: 'cf_clearance',
            value: CF_CLEARANCE,
            domain: '.californiacompetes.org',
            path: '/',
          },
        ]);
      }

      const page = await context.newPage();

      try {
        await page.goto(pageConfig.url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(3000);

        // --- Bot-challenge guard ---------------------------------------
        let challenge = await detectChallenge(page);
        if (challenge.blocked) {
          challenge = await waitForChallengeToClear(page);
        }
        if (challenge.blocked) {
          console.log(
            `    ⛔ Blocked by bot protection (${challenge.matched.join(', ') || 'challenge form'}). ` +
              `Skipping — not a valid capture.`
          );
          pageResult.viewports[viewport.name] = {
            blocked: true,
            challengeTitle: challenge.title,
            matched: challenge.matched,
          };
          await context.close();
          continue;
        }
        // ---------------------------------------------------------------

        // Wait for dynamic content and lazy loading.
        let previousHeight = 0;
        for (let i = 0; i < 10; i++) {
          const currentHeight = await page.evaluate(() => document.body.scrollHeight);
          if (currentHeight === previousHeight) break;
          previousHeight = currentHeight;
          await page.evaluate((h) => window.scrollTo(0, h), currentHeight);
          await page.waitForTimeout(1000);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1000);

        const pageHeight = await page.evaluate(() =>
          Math.max(
            document.body.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.clientHeight,
            document.documentElement.scrollHeight,
            document.documentElement.offsetHeight
          )
        );
        console.log(`    📏 Page height: ${pageHeight}px`);

        const screenshotPath = path.join(
          CURRENT_DIR,
          `${pageConfig.name}-${viewport.name}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`    ✅ Screenshot saved: ${screenshotPath}`);

        const brokenImages = await checkBrokenImages(page);
        if (brokenImages.length > 0) console.log(`    ⚠️  Broken images: ${brokenImages.length}`);

        const brokenLinks = await checkBrokenLinks(page);
        if (brokenLinks.length > 0) console.log(`    ⚠️  Broken links: ${brokenLinks.length}`);

        let hoverResults = [];
        if (viewport.name === 'desktop') {
          hoverResults = await checkHoverStates(page);
          console.log(`    🖱️  Hover states checked: ${hoverResults.length}`);
        }

        const layoutShifts = await checkLayoutShifts(page);
        if (layoutShifts.length > 0) console.log(`    ⚠️  Layout issues: ${layoutShifts.length}`);

        const paddingIssues = await checkPaddingConsistency(page);
        if (paddingIssues.length > 0) console.log(`    ⚠️  Padding issues: ${paddingIssues.length}`);

        pageResult.viewports[viewport.name] = {
          screenshot: screenshotPath,
          blocked: false,
          pageHeight,
          brokenImages,
          brokenLinks,
          hoverResults,
          layoutShifts,
          paddingIssues,
        };
      } catch (error) {
        console.log(`    ❌ Error: ${error.message}`);
        pageResult.viewports[viewport.name] = { error: error.message };
      }

      await context.close();
    }

    results.pages.push(pageResult);
  }

  await browser.close();

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`\n✅ Results saved to: ${RESULTS_FILE}`);

  // Warn loudly if every capture was blocked, but do NOT hard-fail here — we
  // still want compare.js and report.js to run so the report records the
  // blocked state. The final non-zero exit code is set by report.js.
  const allViewports = results.pages.flatMap((p) => Object.values(p.viewports));
  const captured = allViewports.filter((v) => v && !v.blocked && !v.error);
  if (allViewports.length > 0 && captured.length === 0) {
    console.warn('\n⛔ Every page was blocked by bot protection — no valid captures.');
    console.warn('   Set CF_CLEARANCE or run from an allow-listed IP, then regenerate baselines.');
  }

  return results;
}

if (require.main === module) {
  runChecks().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { runChecks, detectChallenge };
