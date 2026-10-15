import fs from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

// Hard boundary set once at startup (in `bin/restless.js`) to the git root of
// the directory the user invoked the CLI from. Every file write performed
// by this CLI - and every Write / Edit / Bash the AI tries to do via the
// Claude Agent SDK - is checked against this boundary. Nothing escapes.
let _gitRoot = null;

export function setGitRoot(root) {
  if (!root) {
    _gitRoot = null;
    return;
  }
  _gitRoot = path.resolve(root);
}

export function getGitRoot() {
  return _gitRoot;
}

/**
 * Pure textual containment check. Returns true iff `target`, after
 * `path.resolve`, is `root` itself or a descendant of `root`. Symlinks
 * are NOT followed - if you need symlink-aware containment, realpath
 * the inputs first.
 */
export function isInsideRoot(target, root = _gitRoot) {
  if (!root) return false;
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t === r) return true;
  const rel = path.relative(r, t);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Throw if `target` is outside the configured git root. Default labels
 * keep the error message meaningful so the user can see which call
 * tried to escape.
 */
export function assertInsideRoot(target, label = 'path') {
  if (!_gitRoot) {
    const err = new Error('pathGuard: git root not configured. Call setGitRoot() at process start.');
    err.code = 'EROOTUNSET';
    throw err;
  }
  if (!isInsideRoot(target, _gitRoot)) {
    const err = new Error(
      `${label} ${target} is outside the git root ${_gitRoot}. ` +
      'The CLI never writes outside the git repository it was run in.',
    );
    err.code = 'EOUTSIDEROOT';
    throw err;
  }
}

/** fs.writeFileSync, but the path must be inside the git root. */
export function safeWriteFileSync(p, data, opts) {
  assertInsideRoot(p, 'writeFileSync');
  return fs.writeFileSync(p, data, opts);
}

/** fs.appendFileSync, but the path must be inside the git root. */
export function safeAppendFileSync(p, data, opts) {
  assertInsideRoot(p, 'appendFileSync');
  return fs.appendFileSync(p, data, opts);
}

/** fs.mkdirSync, but the path must be inside the git root. */
export function safeMkdirSync(p, opts) {
  assertInsideRoot(p, 'mkdirSync');
  return fs.mkdirSync(p, opts);
}

/**
 * Every checkout of the repository at `root` (main checkout plus all git
 * worktrees), as absolute paths. Empty when git can't answer.
 */
export function listCheckouts(root = _gitRoot) {
  if (!root) return [];
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => path.resolve(l.slice('worktree '.length)));
  } catch {
    return [];
  }
}

/**
 * The checkout that owns `target`: the deepest of `checkouts` containing it,
 * so a worktree nested inside the main checkout owns its own files.
 */
export function owningCheckout(target, checkouts) {
  let best = null;
  for (const c of checkouts) {
    if (isInsideRoot(target, c) && (!best || c.length > best.length)) best = c;
  }
  return best;
}
