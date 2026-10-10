/**
 * Validate every relative link in every markdown file, resolved from the
 * directory that file actually lives in.
 *
 * This exists because the docs were reorganised and link rot is silent. A
 * broken relative link still renders as a link, still looks right in the source,
 * and 404s only when someone clicks it on GitHub. Moving files changes the base
 * directory of every relative path at once, so "it looked fine before" is not
 * evidence of anything afterwards.
 *
 * Checks both forms the docs use: `[text](target)` and backticked root-relative
 * paths like `src/worker/db/dialect.ts`, which readers also use as navigation.
 *
 * Exits non-zero on anything unresolvable, so it can gate a commit.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SKIP = /^(https?:|mailto:|data:|#)/i;

function* markdownFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' ||
        entry === '.wrangler' || entry === '_reference_pingflare') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* markdownFiles(full);
    } else if (entry.endsWith('.md')) {
      yield full;
    }
  }
}

const problems = [];
let checked = 0;
let files = 0;

for (const file of markdownFiles('.')) {
  files += 1;
  const text = readFileSync(file, 'utf8');
  const baseDir = dirname(file);

  const targets = [];

  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    targets.push({ ref: m[1], kind: 'link' });
  }
  // The optional `(?:\.\.\/)?` prefix is load-bearing. After the docs migration
  // nearly every reference reads `../src/...`; without it the checker matched
  // none of them and reported success while validating almost nothing. It showed
  // up as 52 references where there had been 70, and every one of the missing
  // 18 was a path that had just been rewritten -- the checker went blind exactly
  // where it was most needed.
  for (const m of text.matchAll(
    /`((?:\.\.\/)?(?:migrations|scripts|public|tests|src|\.github)\/[A-Za-z0-9_.\/-]*)`/g,
  )) {
    targets.push({ ref: m[1], kind: 'path' });
  }
  for (const m of text.matchAll(
    /`((?:\.\.\/)?(?:package\.json|wrangler\.toml|vite\.config\.ts|tsconfig\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml))`/g,
  )) {
    targets.push({ ref: m[1], kind: 'path' });
  }

  for (const { ref, kind } of targets) {
    const clean = ref.split('#')[0].split('?')[0].trim();
    if (!clean || SKIP.test(clean)) continue;
    checked += 1;

    const target = resolve(baseDir, clean);
    if (!existsSync(target)) {
      problems.push(`${file}  [${kind}]  ${ref}  ->  ${target.replace(process.cwd(), '.')}`);
    }
  }
}

if (problems.length === 0) {
  console.log(`[docs] ${checked} local references across ${files} files: all resolve`);
} else {
  console.error(`[docs] ${problems.length} broken reference(s) of ${checked}:`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
