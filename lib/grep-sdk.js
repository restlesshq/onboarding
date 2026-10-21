import fs from 'fs';
import path from 'path';
import { OWNER_ID_PLACEHOLDER, OWNER_ID_TODO_MARKER } from './sdk-writers/contract.js';
import * as timings from './timings.js';

/**
 * Recursive search for `@restlessai/sdk` references inside an install dir,
 * tuned to NOT scan heavyweight directories. The walk is synchronous and
 * blocks the event loop while it runs - if we let it recurse into a
 * populated `node_modules/` (hundreds of MB on a typical Fastify / Next
 * project), the CLI sits frozen for tens of seconds with no spinner update,
 * no cursor, no message. Past incident: users reported the Configure SDK
 * step "got stuck" on first install; root cause was this search walking
 * node_modules synchronously between prepareAccount returning and the
 * "Wiring SDK..." update firing.
 *
 * Pruning excluded directories before descending (not as a post-filter) is
 * the difference between "instant" and "wait, why is this frozen." A
 * post-walk `.filter((f) => !f.includes('node_modules'))` is correctness
 * theater - the cost was already paid by the time we filter.
 *
 * This used to shell out to `grep -rE`. Windows has no `grep` (outside Git
 * Bash), so every search there failed, and failed quietly: the catch below
 * turned "no grep" into "no matches", which reads exactly like "the SDK
 * isn't wired" / "no placeholder left". Walking the tree in Node gives the
 * same answer on every platform, with no shell quoting to get wrong.
 *
 * Also drops noisy build artifact dirs (`dist`, `build`, `.next`,
 * `coverage`) and the `.restless/` working dir. Returns relative paths in
 * sorted directory order; an empty array when nothing matches or the tree
 * can't be read.
 */
const EXCLUDED_DIRS = [
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.restless',
];

const INCLUDE_GLOBS = ['*.js', '*.ts', '*.mjs', '*.cjs'];

/**
 * The writers' search patterns are written as POSIX extended regexes, which
 * is what the old `grep -E` consumed. JavaScript's RegExp understands all of
 * them except the bracket classes (`[[:space:]]`), so translate those; the
 * rest of ERE that the patterns use (groups, alternation, `+`, `\.`) is the
 * same in both dialects.
 */
const POSIX_CLASSES = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  digit: '0-9',
  lower: 'a-z',
  upper: 'A-Z',
  space: '\\s',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  word: '\\w',
  xdigit: '0-9A-Fa-f',
};

export function posixToJsRegex(pattern) {
  const source = String(pattern).replace(/\[:([a-z]+):\]/g, (whole, name) => (
    name in POSIX_CLASSES ? POSIX_CLASSES[name] : whole
  ));
  // `m` so `^` / `$` keep grep's line-at-a-time meaning; `.` already stops
  // at a newline, which is the other half of that.
  return new RegExp(source, 'm');
}

/** `--include` globs are matched against the basename, like grep does. */
function globToRegex(glob) {
  const source = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`);
}

function walk(dir, rootDir, matchers, visit, { maxDepth = Infinity, depth = 1 } = {}) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // Sorted so the result is stable across filesystems; grep's readdir order
  // was whatever the OS felt like, which made "first candidate wins" callers
  // nondeterministic.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    // `-r` never followed symlinks either; a linked node_modules is the
    // classic way to end up back in the frozen-walk incident.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.includes(entry.name)) continue;
      walk(full, rootDir, matchers, visit, { maxDepth, depth: depth + 1 });
    } else if (entry.isFile() && matchers.some((m) => m.test(entry.name))) {
      visit(full, path.relative(rootDir, full));
    }
  }
}

/**
 * Relative paths of the files under `dir` whose basename matches one of
 * `globs`, with the same pruning as the content search. This is what the
 * `find . -name ... -not -path` shell-outs became (the exclusions are the
 * same list):
 * Windows does have a `find`, but it is a string-search tool that rejects
 * those arguments, so `reset` found no manifests or env files to clean and
 * the test step could not read a port out of the project's config.
 *
 * `maxDepth` counts path segments like find's `-maxdepth` (1 = direct
 * children); `limit` caps the result like the `| head -N` that followed.
 */
export function listFiles(dir, globs, { maxDepth = Infinity, limit = Infinity } = {}) {
  const matchers = globs.map(globToRegex);
  const hits = [];
  try {
    walk(dir, dir, matchers, (_full, rel) => {
      if (hits.length < limit) hits.push(rel);
    }, { maxDepth });
  } catch {
    return hits;
  }
  return hits;
}

/**
 * Relative paths of the files under `dir` whose basename matches one of
 * `globs` and whose contents match the POSIX ERE `pattern`. The shared
 * runner, so every search here keeps the same exclude tuning.
 */
export function findFilesMatching(pattern, dir, globs = INCLUDE_GLOBS, { label = 'grep: sdk references' } = {}) {
  const endSpan = timings.start(label, { kind: timings.KINDS.EXEC });
  try {
    const re = posixToJsRegex(pattern);
    const matchers = globs.map(globToRegex);
    const hits = [];
    walk(dir, dir, matchers, (full, rel) => {
      let content;
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        return;
      }
      if (re.test(content)) hits.push(rel);
    });
    return hits;
  } catch {
    return [];
  } finally {
    endSpan();
  }
}

/**
 * Files mentioning the SDK package.
 *
 * `pattern` and `globs` are parameters because both are per-language: the
 * import specifier differs (`@restlessai/sdk`, `restless`,
 * `github.com/restlesshq/go`) and so do the source extensions. Defaults
 * reproduce the JavaScript behaviour exactly, so callers that pass nothing
 * are unaffected.
 */
export function findSdkReferences(installDir, { pattern = '@restlessai/sdk', globs } = {}) {
  return findFilesMatching(pattern, installDir, globs);
}

/**
 * Files still carrying the owner-id placeholder the SDK guide tells
 * installers to leave when no stable id exists (`'NEEDS_CONFIGURATION'` +
 * the `RESTLESS_OWNER_ID_TODO` marker comment). The guide promises "the
 * CLI greps for them and asks the user" - the guided flow keeps that
 * promise in final-checks, and `api verify` keeps it for the agent flow
 * with this. Same include/exclude tuning as above, for the same
 * frozen-walk reasons.
 */
export function findOwnerIdPlaceholders(dir, { globs } = {}) {
  // Both tokens are language-independent policy from `sdk-writers/contract.js`;
  // only which files to look in varies, hence `globs`.
  return findFilesMatching(
    `${OWNER_ID_PLACEHOLDER}|${OWNER_ID_TODO_MARKER}`,
    dir,
    globs,
  );
}
