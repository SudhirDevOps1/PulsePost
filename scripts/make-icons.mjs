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
  { size: 48, file: 'favicon-48.png' },
  { size: 180, file: 'apple-touch-icon.png' },
  { size: 192, file: 'icon-192.png' },
  { size: 512, file: 'icon-512.png' },
  { size: 1024, file: 'logo.png' },
];

/**
 * Pack PNGs into a real .ico at /favicon.ico.
 *
 * Why this file has to physically exist
 * ------------------------------------
 * Every browser asks for /favicon.ico by convention, and so do crawlers and
 * bookmark importers. Cloudflare's asset binding here runs with
 * `not_found_handling = "single-page-application"` -- correctly, because
 * client-side routes like /status/my-team must survive a hard refresh. But that
 * setting rewrites *every* unmatched path to index.html, so /favicon.ico came
 * back 200 `text/html` containing "<!doctype". An icon parser handed HTML either
 * renders nothing or falls back to a generic globe, and neither is a bug the
 * `<link rel="icon">` tags can fix, because those tags are a hint and this path
 * is a lookup.
 *
 * The fix is to make the path resolve to an actual file. ICO is the format that
 * path is named after, and it carries several sizes in one file, so a 16px tab
 * and a 48px bookmark both come out crisp.
 *
 * Entries are PNG-compressed, which every browser that understands ICO has
 * understood since IE6. The alternative is BMP-in-ICO, which is roughly four
 * times the bytes for an identical image.
 */
function writeIco() {
  const sizes = [16, 32, 48];
  const images = sizes.map((size) => readFileSync(`public/favicon-${size}.png`));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);

  const directory = Buffer.alloc(16 * sizes.length);
  let offset = header.length + directory.length;

  sizes.forEach((size, i) => {
    const at = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0); // width  (0 == 256)
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1); // height
    directory.writeUInt8(0, at + 2); // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(images[i].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });

  writeFileSync('public/favicon.ico', Buffer.concat([header, directory, ...images]));
  console.log('  public/favicon.ico            16+32+48  ' +
    (readFileSync('public/favicon.ico').length / 1024).toFixed(1) + ' KB');
}

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
  writeIco();
  console.log(`\n[icons] ${TARGETS.length} PNG(s) + favicon.ico written from public/favicon.svg`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
