/**
 * Guard against a class of React bug that is invisible to `tsc`, invisible to a
 * passing test, and only appears at runtime in one specific transition.
 *
 * THE BUG
 * -------
 * A hook called after an early `return` is a *conditional* hook. React records
 * hook order per render and throws "Rendered fewer hooks than expected" the
 * moment the branch flips. For a component that renders an empty state until
 * data arrives, that flip is the normal path, not an edge case: the component
 * works perfectly right up until its first successful render of real data and
 * then unmounts itself with an exception.
 *
 * WHY A SCRIPT AND NOT A LINTER
 * -----------------------------
 * Every naive version of this check is wrong, and all three wrongnesses were hit
 * while writing it:
 *
 *   1. It attributes a helper's `return` to whichever function comes next.
 *      `impactTone`'s early returns sit above `IncidentsPage` and come back as
 *      "IncidentsPage returns at line 50".
 *   2. It cannot find the body of a function whose signature spans lines.
 *      `export function LatencyChart({ checks }: Props) {` opens a
 *      *destructuring* brace, not a body. Misreading that produces no result at
 *      all, so the check reports "clean" on exactly the file it was written for.
 *   3. It matches `return` only at the body's own statement depth. The common
 *      shape is `if (!ready) { return <Skeleton />; }`, where the `return` sits
 *      a block deeper, so the block form is missed entirely.
 *
 * None of those failures are loud. This script was run against a file holding
 * the real bug and passed, twice, which is the only reason these notes exist: a
 * check that cannot fail is not a check.
 *
 * Run as part of `pnpm verify`; exits non-zero on a real violation.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'src';
/*
 * A hook call.
 *
 * Both a bare \`useEffect(...)\` and a hoisted one matter -- \`const [x, setX] =
 * useState(...)\` is the single most common hook in this codebase, and an
 * earlier version of this pattern only matched the bare form, so it would have
 * reported "clean" against a file containing a conditional \`useState\`.
 */
const HOOK = /\buse[A-Z]\w*\s*\(/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(entry)) yield full;
  }
}

/**
 * Blank out comments and string/template literals, preserving length, so a `}`
 * inside a string or a `{` inside a comment cannot corrupt brace counting.
 */
function neutralise(source) {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') out[i++] = ' ';
    } else if (c === '/' && next === '*') {
      out[i] = out[i++] = ' ';
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') { i++; break; }
        out[i++] = ' ';
      }
      if (i < n) out[i++] = ' ';
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out[i++] = ' ';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          out[i++] = ' ';
          if (i < n) out[i++] = ' ';
          continue;
        }
        if (source[i] === '\n') break; // unterminated; do not eat the rest of the file
        out[i++] = ' ';
      }
      if (i < n && source[i] === quote) out[i++] = ' ';
    } else {
      i++;
    }
  }
  return out.join('');
}

const violations = [];
let functionsSeen = 0;

for (const file of walk(ROOT)) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split(/\r?\n/);
  const cleanLines = neutralise(source).split(/\r?\n/);

  // Brace depth at the start of each line.
  const depthAt = [];
  let depth = 0;
  for (let i = 0; i < cleanLines.length; i++) {
    depthAt[i] = depth;
    for (const ch of cleanLines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }

  /*
   * The `{` that opens a function body, at or after (fromLine, fromCol).
   *
   * Depth counting has to cover `[` as well as `(`, and it must NOT stop the
   * body `{` from being found when the function is an arrow passed as an
   * argument: in `useMemo(() => { ... })` the body brace sits inside
   * `useMemo(`'s parentheses. An earlier version required depth 0 and so
   * resolved no body at all for the most common function shape in this
   * codebase.
   */
  function bodyBrace(fromLine, fromCol) {
    let depth = 0;
    let line = fromLine;
    let col = fromCol;
    while (line < cleanLines.length) {
      const text = cleanLines[line];
      for (; col < text.length; col++) {
        const ch = text[col];
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        else if (ch === ';' && depth <= 0) return null;
        else if (ch === '{' && depth <= 0) return { line, col };
      }
      line++;
      col = 0;
    }
    return null;
  }

  /*
   * Locate every function body, including arrows passed as arguments.
   *
   * Matching only \`function name\` and \`const x = ... => {\` misses the shape that
   * dominates this codebase: \`useMemo(() => { ... return (...); })\`. That return
   * then reads as the component's own early exit, and every hook below it gets
   * reported as conditional. So every \`=>\` followed by a brace counts, plus every
   * \`function\` keyword.
   */
  const functionStarts = [];
  for (let i = 0; i < cleanLines.length; i++) {
    const text = cleanLines[i];
    const fn = text.search(/\bfunction\b/);
    if (fn !== -1) functionStarts.push({ line: i, from: fn });
    let arrow = text.indexOf('=>');
    while (arrow !== -1) {
      functionStarts.push({ line: i, from: arrow });
      arrow = text.indexOf('=>', arrow + 2);
    }
  }

  // Resolve each start to the brace that opens its body, once.
  const bodies = functionStarts
    .map((start) => bodyBrace(start.line, start.from))
    .filter(Boolean)
    .sort((a, b) => a.line - b.line);

  for (const brace of bodies) {
    functionsSeen++;
    /*
     * The depth of statements inside this body.
     *
     * Read from the line AFTER the brace, not from the brace's own line plus
     * one. When the opening brace shares a line with a closing one -- which it
     * does for every multi-line signature, e.g. the `}) {` that ends
     * `function F({ a, b }: Props) {` -- the two cancel and the net depth of
     * that line is unchanged. Adding one to it walks the body at a depth that
     * nothing in the body ever occupies, so no hook and no return is found and
     * the check reports "clean".
     */
    const bodyDepth = depthAt[brace.line + 1] ?? bodyDepthOf(brace.line);

    /*
     * Walk this body, jumping over any function declared inside it. A helper's
     * `return` is not this function's exit and a helper's hooks are not this
     * function's hooks; when a helper is written on one line its braces sit at
     * the same depth as the body's own statements, so depth alone cannot
     * separate them.
     */
    let firstExit = null;
    const hooks = [];

    for (let i = brace.line + 1; i < lines.length; i++) {
      if (depthAt[i] < bodyDepth) break; // this body has closed

      const nested = bodies.find((b) => b.line === i);
      if (nested) {
        // Same off-by-one as above: read the depth from the line after the
        // brace. Getting this wrong by one made the skip a no-op, so a
        // callback's `return` was still counted as the component's exit and
        // every hook below it was falsely reported.
        const nestedDepth = depthAt[nested.line + 1] ?? Number.MAX_SAFE_INTEGER;
        i = nested.line + 1;
        while (i < lines.length && depthAt[i] >= nestedDepth) i++;
        continue;
      }

      const trimmed = lines[i].trim();
      if (HOOK.test(trimmed)) {
        hooks.push({ line: i, name: trimmed.slice(0, trimmed.indexOf('(')) });
      }
      /*
       * Any `return` inside the body counts as an exit, at whatever depth it
       * sits. Requiring an exact depth match finds only `if (x) return y;`
       * written on one line and misses `if (!ready) { return <Skeleton />; }`,
       * which is the shape that actually appears throughout this codebase.
       */
      if (firstExit === null && /^return\b/.test(trimmed)) firstExit = i;
    }

    if (firstExit === null) continue;
    for (const hook of hooks) {
      if (hook.line > firstExit) {
        violations.push(
          `${file}:${hook.line + 1}  ${hook.name}() runs after the early return on line ${firstExit + 1}`,
        );
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`[hooks] clean: no conditional hooks across ${functionsSeen} function bodies`);
} else {
  console.error('[hooks] conditional hook(s) -- React throws when the branch flips:');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
