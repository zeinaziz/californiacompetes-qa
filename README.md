# californiacompetes-qa

Weekly visual-regression and health check for **californiacompetes.org**.
It screenshots a set of pages at desktop and mobile widths, compares them
pixel-by-pixel against committed baselines, and also checks for broken images,
broken links, hover states, and layout issues. Output is a Markdown report in
`reports/`.

## ⚠️ Important: the site is behind Cloudflare bot protection

`californiacompetes.org` uses Cloudflare, which serves a **"Verify you are
human" challenge** to automated browsers coming from datacenter/CI IPs. When
that happens, Playwright captures the *challenge page*, not the real site.

The original version of this project did exactly that: the committed baselines
were Cloudflare challenge screenshots, so every weekly run compared one
challenge page to another, got a 0% diff, and reported **"✅ ALL OK"** even
though the real site was never loaded. The baselines have been removed for
that reason — **regenerate them from a run that is not blocked** before
trusting any result.

### How the fixed version handles it

- `scripts/check.js` detects the challenge page (`detectChallenge`) and marks
  that capture `blocked` instead of saving it as a valid result.
- `scripts/report.js` reports **`❌ ACTION REQUIRED`** and exits non-zero when
  any page is blocked, so CI turns red instead of green.
- `.github/workflows/generate-baselines.yml` refuses to commit baselines if any
  page was blocked, so a challenge page can never become a baseline again.

### Getting past the challenge

Provide a valid `cf_clearance` cookie via the `CF_CLEARANCE` environment
variable (locally) or repo secret (CI):

```bash
CF_CLEARANCE="<cookie value from a real browser session>" npm test
```

Get the value by visiting the site in a normal browser, opening DevTools →
Application → Cookies, and copying `cf_clearance`. Note it is IP- and
UA-bound and expires, so it is best for occasional baseline regeneration.
Alternatives: run from an IP Cloudflare allow-lists, or point the checks at a
staging environment without bot protection.

## Usage

```bash
npm ci
npx playwright install chromium --with-deps

npm run check     # capture screenshots + run checks -> results.json
npm run compare   # diff against baselines            -> compare-results.json
npm run report    # write reports/<date>.md
npm test          # all three in sequence
```

First run has no baselines, so every page reports **No Baseline**. Once you
have a run with real (non-blocked) pages, generate baselines:

```bash
# locally
cp current/*.png baselines/
# or in CI: run the "Generate Baselines" workflow (workflow_dispatch)
```

## What each check does

| Check | What it flags | Notes |
|-------|---------------|-------|
| Visual diff | Pages that changed >0.1% vs baseline | `pixelmatch`, saves diff images to `diffs/` |
| Broken images | `<img>` with a real src that loaded 0×0 | Lazy-load placeholders are **not** flagged |
| Broken links | First 20 http links returning ≥400 | HEAD request |
| Hover states | Buttons with no hover style change / hover errors | Only visible elements; invisible ones (e.g. the mobile menu toggle on desktop) are skipped |
| Layout | Unexpected hidden sections and horizontal overflow | Sections hidden per breakpoint (`elementor-hidden-*`) are **not** flagged |

## Report status

- **✅ ALL OK** — nothing blocked, changed, missing, or broken.
- **⚠️ REVIEW NEEDED** — visual changes, missing baselines, or functional
  issues (broken images/links/hover errors). Exit code 1.
- **❌ ACTION REQUIRED** — pages blocked by bot protection, or capture errors.
  Exit code 1.

## Pages checked

Homepage, About, Resources, Podcast, Contact — each at desktop (1440×900) and
mobile (375×812).

## Fixes applied in this copy

- Detect and reject Cloudflare challenge pages (the core bug).
- Report status now reflects blocked pages, broken images, and hover errors —
  it no longer prints "ALL OK" while listing errors in the body.
- CI exits non-zero and uploads the report + diffs even on failure.
- Baseline generation refuses to commit blocked/challenge captures.
- Removed false positives: lazy-load images and responsive-hidden sections are
  no longer reported as problems.
- Hover check rewritten to hover the actual element and skip invisible ones,
  so labels match and it no longer times out on the desktop menu toggle.
