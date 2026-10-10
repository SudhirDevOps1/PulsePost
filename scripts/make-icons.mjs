/**
 * Rasterise `public/favicon.svg` into the PNG sizes browsers and operating
 * systems actually ask for.
 *
 * WHY THIS EXISTS
 * ---------------
 * An SVG favicon is correct on a modern desktop browser and wrong nearly
 * everywhere else, in ways that are invisible until someone opens the site:
 *
 *   - **iOS ignores `apple-touch-icon` in SVG entirely.** Home-screen shortcuts
 *     fall back to a screenshot of the page. This is not a rendering
 *     difference; the icon is simply not used.
 *   - **Windows taskbar and most desktop launchers** prefer a PNG and will fall
 *     back to a generic globe when only SVG is offered.
 *   - **A GitHub README cannot use the SVG at all.** GitHub rewrites relative
 *     image paths to its camo proxy only for Markdown `![](path)` syntax; a raw
 *     `<img src="public/favicon.svg">` is left as-is, resolves against
 *     `github.com/owner/repo` instead of `.../blob/main/`, and 404s. An SVG
 *     with a `viewBox` and no intrinsic `width`/`height` also has no size for
 *     the browser to lay out.
 *
 * A PNG referenced with Markdown syntax fixes all three at once, so the brand
 * mark is rasterised once here and committed alongside the vector source.
 *
 * The SVG stays the source of truth. Re-run this after changing it:
 *
 *     node scripts/make-icons.mjs
 *
 * Driven through Chrome rather than an image library so the output is exactly
 * what a browser would draw from the same SVG -- same gradient, same
 * anti-aliasing -- rather than a re-implementation of it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No Chrome or Edge binary found; cannot rasterise icons.');
}

/**
 * Sizes worth committing.
 *
 * 32 is what a browser tab actually shows on a 1x display; 16 is what it shows
 * on some Linux and Android launchers; 180 is the iOS home-screen icon; 192
 * and 512 are the PWA sizes the manifest asks for.
 */
const TARGETS = [
  { size: 16, file: 'favicon-16.png' },
  { size: 32, file: 'favicon-32.png' },
  { size: 180, file: 'apple-touch-icon.png' },
  { size: 192, file: 'icon-192.png' },
  { size: 512, file: 'icon-512.png' },
  { size: 1024, file: 'logo.png' },
];

const chrome = findChrome();
const svg = readFileSync('public/favicon.svg', 'utf8');
mkdirSync('public', { recursive: true });

const work = mkdtempSync(join(tmpdir(), 'pulsepost-icons-'));

try {
  for (const { size, file } of TARGETS) {
    /*
     * Chrome screenshots the viewport, so the page has to be exactly the icon.
     * `margin: 0` plus an `svg` sized in vh/vw removes the two things that
     * would otherwise appear in the output: the default 8px body margin, and the
     * intrinsic-size rules that would letterbox the artwork.
     */
    const page = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style>
${svg}`;

    const pagePath = join(work, `icon-${size}.html`);
    // Absolute, because Chrome resolves `--screenshot` against its own working
    // directory rather than the shell's. A relative path makes the command exit
    // 0 while writing nothing at all, which is how this failed first.
    const outPath = resolve('public', file);
    writeFileSync(pagePath, page);

    execFileSync(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        // Required on Windows; without it Chrome exits before rendering.
        '--no-sandbox',
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${outPath}`,
        `file:///${pagePath.replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore' },
    );

    const bytes = readFileSync(outPath).length;
    if (bytes === 0) throw new Error(`Chrome wrote an empty ${file}`);
    console.log(`  public/${file.padEnd(24)} ${size}x${size}  ${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`\n[icons] ${TARGETS.length} PNG(s) written from public/favicon.svg`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
