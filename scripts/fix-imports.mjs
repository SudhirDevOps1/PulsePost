#!/usr/bin/env node
/**
 * Normalise relative imports to carry explicit extensions.
 *
 * The worker is bundled by Wrangler/esbuild, the frontend by Vite, and the
 * tests run on Node's native TypeScript stripping. Only Node demands explicit
 * extensions, but using them everywhere keeps one style across all three and
 * removes a whole class of "works in dev, fails in build" bugs.
 *
 * Run after adding files:  node scripts/fix-imports.mjs
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const TESTS = join(ROOT, 'tests');

const EXTENSION_FOR = {
  '.ts': '.ts',
  '.tsx': '.tsx',
};

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve a specifier that has no extension to the actual file on disk,
 * following the TS convention of `./x` -> `./x.ts`.
 */
function withExtension(fromFile, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  if (/\.(ts|tsx|js|jsx|mjs|json|css)$/.test(specifier)) return specifier;

  const base = resolve(dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return `./${relative(dirname(fromFile), candidate).split(/[\\/]/).join('/')}`;
      }
    } catch {
      // keep looking
    }
  }

  // No file yet — append .ts as the default for worker/shared sources.
  return `${specifier}.ts`;
}

const IMPORT_RE =
  /(from\s+|import\s*\(\s*)(['"])(\.[^'"]*)\2/g;

let changedFiles = 0;

for (const file of [...walk(SRC), ...walk(TESTS)]) {
  const original = readFileSync(file, 'utf8');
  const updated = original.replace(IMPORT_RE, (_match, prefix, quote, specifier) => {
    const resolved = withExtension(file, specifier);
    return `${prefix}${quote}${resolved}${quote}`;
  });

  if (updated !== original) {
    writeFileSync(file, updated, 'utf8');
    changedFiles += 1;
    console.log(`  fixed ${relative(ROOT, file)}`);
  }
}

console.log(changedFiles === 0 ? '[fix-imports] nothing to do' : `[fix-imports] updated ${changedFiles} file(s)`);