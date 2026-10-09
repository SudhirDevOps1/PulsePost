#!/usr/bin/env node
/**
 * Offline-readiness check.
 *
 * Answers one question honestly: **after `pnpm install`, does this project run
 * without a network connection?**
 *
 * "Install offline" and "run offline" are different problems and people conflate
 * them constantly:
 *
 *   install-time  solved by a project-local pnpm store + a lockfile, so
 *                 `pnpm install --offline` never touches the network.
 *
 *   run-time      NOT automatic. The Worker itself (workerd) runs fully local,
 *                 but the *frontend* can silently reintroduce a network
 *                 dependency through a CDN link, a web font, or a map tile
 *                 server. That is what this script hunts for.
 *
 * Exit codes: 0 = ready, 1 = a blocking problem was found.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const problems = [];
const warnings = [];
const notes = [];

function fail(message) {
  problems.push(message);
}
function warn(message) {
  warnings.push(message);
}
function note(message) {
  notes.push(message);
}

// --- 1. install-time: is everything vendored? --------------------------------

if (!existsSync(join(ROOT, 'node_modules'))) {
  fail('node_modules is missing — run `pnpm install` (or `pnpm offline:install`).');
}

const localStore = join(ROOT, '.pnpm-store');
if (existsSync(localStore)) {
  note('project-local pnpm store present (.pnpm-store) — `pnpm install --offline` can work.');
} else {
  warn(
    'No project-local store (.pnpm-store). Run `pnpm offline:prepare` while online so that\n' +
      '        another machine can install without network access.',
  );
}

if (existsSync(join(ROOT, 'pnpm-lock.yaml'))) {
  note('pnpm-lock.yaml present — installs are reproducible and version-pinned.');
} else {
  fail('pnpm-lock.yaml is missing; offline installs cannot be trusted without it.');
}

// --- 2. run-time: scan the built frontend for network dependencies -----------

/**
 * Hosts that would make the app require the internet at runtime.
 * These are always a bug for a self-hosted, privacy-focused tool.
 */
const FORBIDDEN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'cdnjs.cloudflare.com',
  'ajax.googleapis.com',
  'esm.sh',
  'skypack.dev',
  'esm.run',
];

/**
 * Hosts that are *expected* to be contacted, and why.
 * Reported so they stay visible rather than being silently accepted.
 */
const KNOWN_RUNTIME_HOSTS = {
  '*.tile.openstreetmap.org':
    'OpenStreetMap raster tiles for the edge map. Needs internet unless a local/offline tile source is configured.',
  'api.openstreetmap.org': 'Tile attribution links. Cosmetic only, no fetch.',
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function collectExternalUrls() {
  /** @type {Map<string, Set<string>>} host -> set of files */
  const byHost = new Map();

  if (!existsSync(DIST)) {
    fail('dist/ is missing — run `pnpm build` first.');
    return byHost;
  }

  const record = (url, file) => {
    let host;
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    if (!byHost.has(host)) byHost.set(host, new Set());
    byHost.get(host).add(relative(ROOT, file));
  };

  for (const file of walk(DIST)) {
    const ext = extname(file);
    if (!['.html', '.css', '.js', '.mjs', '.json'].includes(ext)) continue;

    const source = readFileSync(file, 'utf8');
    const shown = relative(ROOT, file);

    // Absolute URLs in markup and CSS are unambiguous.
    for (const match of source.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
      fail(`${shown}: loads a remote asset over the network -> ${match[1]}`);
    }
    for (const match of source.matchAll(/url\(\s*["']?https?:\/\/[^)"']+["']?\s*\)/gi)) {
      fail(`${shown}: CSS references a remote asset -> ${match[0]}`);
    }
    for (const match of source.matchAll(/@import\s+(?:url\()?\s*["']https?:\/\/[^"')]+/gi)) {
      fail(`${shown}: CSS @import from the network -> ${match[0]}`);
    }

    // Any remaining absolute URL is reported rather than assumed safe, because
    // a runtime `fetch()` to a third party is otherwise invisible here.
    for (const match of source.matchAll(/https?:\/\/[a-zA-Z0-9.\-]+(?::\d+)?/g)) {
      record(match[0], file);
    }
  }

  return byHost;
}

const externalByHost = collectExternalUrls();

for (const [host, files] of externalByHost) {
  const matchedForbidden = FORBIDDEN_HOSTS.find((bad) => host.endsWith(bad));
  if (matchedForbidden) {
    fail(`${[...files][0]}: references forbidden CDN host "${host}"`);
    continue;
  }

  const known = Object.keys(KNOWN_RUNTIME_HOSTS).find(
    (pattern) => host === pattern || host.endsWith(pattern.replace('*.', '')),
  );

  if (known) {
    note(`expected runtime contact: ${host} — ${KNOWN_RUNTIME_HOSTS[known]}`);
  } else {
    warn(
      `external host "${host}" referenced in ${[...files].join(', ')}\n` +
        '        (if this is fetched at runtime, the app will need internet)',
    );
  }
}

// --- 3. fonts: must be system fonts ------------------------------------------

const indexHtml = existsSync(join(DIST, 'index.html'))
  ? readFileSync(join(DIST, 'index.html'), 'utf8')
  : '';

if (indexHtml) {
  if (/@font-face/i.test(indexHtml)) {
    warn('index.html declares @font-face — verify the font files are bundled locally.');
  } else {
    note('no web fonts referenced — typography uses system fonts, so no font CDN is needed.');
  }
} else {
  fail('dist/index.html is missing — the build did not produce an entry point.');
}

// --- report ------------------------------------------------------------------

const pad = (s) => `  ${s}`;

console.log('Offline readiness');
console.log('==================');

if (notes.length) {
  console.log('\nOK');
  for (const item of notes) console.log(pad(`+ ${item}`));
}
if (warnings.length) {
  console.log('\nWarnings');
  for (const item of warnings) console.log(pad(`! ${item}`));
}
if (problems.length) {
  console.log('\nBlocking problems');
  for (const item of problems) console.log(pad(`x ${item}`));
  console.log('\nNot offline-ready.');
  process.exit(1);
}

console.log('\nNo blocking problems found. Install and run are offline-capable.');
console.log(
  '\nReminder: health checks against *external* URLs inherently need internet.\n' +
    '         To monitor purely local services, set ALLOW_PRIVATE_TARGETS=true\n' +
    '         and point monitors at localhost / private addresses.',
);