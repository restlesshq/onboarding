import fs from 'fs';
import os from 'os';
import path from 'path';
import { isInsideRoot, owningCheckout } from './pathGuard.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

// Outside-root paths a shell command may still name: devices and scratch space.
const BASH_EXEMPT = ['/dev', '/tmp', os.tmpdir()].map((p) => path.resolve(p));

/**
 * Absolute path tokens in a Bash command. Best-effort: `cd`, `cat`, `mv` and
 * friends with literal paths, not env-var or `eval` indirection.
 */
export function extractAbsPaths(cmd) {
  if (typeof cmd !== 'string') return [];
  const out = [];
  // Not after a word char, `:` or `/`, so `https://host/x` and `a/b` don't count.
  const re = /(?<![\w\\:/])(\/[^\s"';|&<>()`$]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1]);
  return out;
}

// A token like `/foo/g` inside a `node -e` regex is not a path; require it, or
// a non-root parent, to exist before treating it as one.
function looksLikeRealPath(p) {
  if (fs.existsSync(p)) return true;
  const parent = path.dirname(p);
  return parent !== path.parse(p).root && fs.existsSync(parent);
}

// The literal directory a glob pattern starts in (`/a/b/**/*.go` -> `/a/b`).
function globBase(pattern) {
  const firstMagic = pattern.search(/[*?[{]/);
  if (firstMagic === -1) return pattern;
  return path.dirname(pattern.slice(0, firstMagic) + 'x');
}

function inputPaths(toolName, input, cwd) {
  const abs = (p) => (typeof p === 'string' && p ? path.resolve(cwd, p) : null);
  if (WRITE_TOOLS.has(toolName)) return [abs(input?.file_path || input?.notebook_path)];
  if (toolName === 'Read') return [abs(input?.file_path)];
  if (toolName === 'Grep') return [abs(input?.path)];
  if (toolName === 'Glob') {
    const pattern = input?.pattern;
    return [abs(input?.path), typeof pattern === 'string' && path.isAbsolute(pattern) ? globBase(pattern) : null];
  }
  return [];
}

/**
 * Check for every AI tool call: null allows, `{ path, message }` denies. Edit
 * tools stay inside `gitRoot` (Bash best-effort), and nothing touches another
 * checkout of the repo, which is where a worktree run's remembered paths point.
 */
export function makeToolGuard({ gitRoot, cwd = gitRoot, checkouts = [] }) {
  if (!gitRoot) return () => null;
  const root = path.resolve(gitRoot);
  const others = checkouts.map((c) => path.resolve(c));
  if (!others.includes(root)) others.push(root);

  const otherCheckout = (p) => {
    const owner = owningCheckout(p, others);
    return owner && owner !== root ? owner : null;
  };
  const deny = (toolName, p, owner) => ({
    path: p,
    owner,
    message:
      `${toolName} on ${p} refused: ` +
      (owner
        ? `that is in ${owner}, a different checkout of this repository. `
        : 'it is outside the project. ') +
      `This run works only in ${root}${owner ? ' (a git worktree)' : ''}. ` +
      `Use the same path relative to ${root} instead.`,
  });

  return (toolName, input) => {
    if (WRITE_TOOLS.has(toolName) || READ_TOOLS.has(toolName)) {
      for (const p of inputPaths(toolName, input, cwd)) {
        if (!p) continue;
        const owner = otherCheckout(p);
        if (owner) return deny(toolName, p, owner);
        if (WRITE_TOOLS.has(toolName) && !isInsideRoot(p, root)) return deny(toolName, p, null);
      }
      return null;
    }
    if (toolName === 'Bash') {
      for (const p of extractAbsPaths(input?.command).map((t) => path.resolve(t))) {
        const owner = otherCheckout(p);
        if (owner) return deny('Bash', p, owner);
        if (isInsideRoot(p, root) || BASH_EXEMPT.some((e) => isInsideRoot(p, e))) continue;
        if (looksLikeRealPath(p)) return deny('Bash', p, null);
      }
    }
    return null;
  };
}
