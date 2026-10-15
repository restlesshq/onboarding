import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import path from 'path';
import { isInsideRoot, owningCheckout } from './pathGuard.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

// Outside-root paths a shell command may still name: devices and scratch space.
const BASH_EXEMPT = ['/dev', '/tmp', os.tmpdir()].map((p) => path.resolve(p));

const PY_DIRS =
  'import site, sysconfig\n' +
  'p = sysconfig.get_paths()\n' +
  'print("\\n".join([*site.getsitepackages(), site.getusersitepackages(), p["stdlib"], p["platstdlib"], p["purelib"], p["platlib"]]))';

// Where each supported language keeps installed dependencies and its standard
// library, asked of the toolchain only when the project has its manifest.
const TOOLCHAINS = [
  { manifests: ['go.mod', 'go.work'], cmd: 'go', args: ['env', 'GOMODCACHE', 'GOROOT'] },
  { manifests: ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'setup.cfg'], cmd: 'python3', args: ['-c', PY_DIRS] },
  // Poetry and Pipenv keep a project's virtualenv outside it by default.
  { manifests: ['poetry.lock'], cmd: 'poetry', args: ['env', 'info', '--path'] },
  { manifests: ['Pipfile.lock'], cmd: 'pipenv', args: ['--venv'] },
  { manifests: ['Gemfile', 'gems.rb'], cmd: 'ruby', args: ['-e', 'puts Gem.path, RbConfig::CONFIG["rubylibdir"]'] },
  { manifests: ['package.json'], cmd: 'npm', args: ['root', '-g'] },
];

function runToolchain(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
}

const dependencyDirsCache = new Map();

/**
 * Dependency sources a shell command may name: module caches, installed
 * packages and standard libraries for the languages in `projectDirs`.
 * Reading the SDK's own source there is how the model checks its API, and the
 * package manager writes there anyway. Run from the project so version
 * managers (pyenv, rbenv) pick its toolchain. `run` is for tests.
 */
export function dependencyDirs(projectDirs, run = runToolchain) {
  const dirs = [...new Set(projectDirs.filter(Boolean).map((d) => path.resolve(d)))];
  const key = dirs.join('\0');
  if (dependencyDirsCache.has(key)) return dependencyDirsCache.get(key);
  const out = new Set();
  for (const { manifests, cmd, args } of TOOLCHAINS) {
    const dir = dirs.find((d) => manifests.some((m) => fs.existsSync(path.join(d, m))));
    if (!dir) continue;
    let text;
    try {
      text = run(cmd, args, dir);
    } catch {
      continue;
    }
    for (const line of String(text).split('\n')) {
      const p = line.trim();
      // A bare `/` or home directory would exempt everything; never trust one.
      if (!path.isAbsolute(p)) continue;
      const resolved = path.resolve(p);
      if (resolved !== path.parse(resolved).root && resolved !== os.homedir()) out.add(resolved);
    }
  }
  const result = [...out];
  dependencyDirsCache.set(key, result);
  return result;
}

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
        if (!looksLikeRealPath(p) || dependencyDirs([cwd, root]).some((d) => isInsideRoot(p, d))) continue;
        return deny('Bash', p, null);
      }
    }
    return null;
  };
}
