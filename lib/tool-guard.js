import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import path from 'path';
import { isInsideRoot, owningCheckout } from './pathGuard.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);

// Outside-root paths a shell command may still name: devices and scratch space.
const BASH_EXEMPT = ['/dev', '/tmp', os.tmpdir()].map((p) => path.resolve(p));

// Directories programs run from, so `/opt/homebrew/bin/go mod tidy` or a
// `#!/usr/bin/env bash` line isn't read as a path outside the project.
const BIN_DIRS = [
  ...new Set(
    ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/local/go/bin',
      ...(process.env.PATH || '').split(path.delimiter)]
      .filter((d) => path.isAbsolute(d))
      .map((d) => path.resolve(d))
      .filter((d) => d !== path.parse(d).root && d !== os.homedir()),
  ),
];

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
  // Not after a word char, `:`, `/`, `.`, `~` or `}`, so `https://host/x`,
  // `a/b`, `../x`, `~/x` and `${HOME}/x` don't count as absolute.
  const re = /(?<![\w\\:/.~}])(\/[^\s"';|&<>()`$]+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) out.push(m[1]);
  return out;
}

const BOUNDARY = `[\\s=;|&(<>\`'"]`;
const HOME_RE = new RegExp(`(^|${BOUNDARY})(?:"\\$\\{?HOME\\}?"|\\$\\{HOME\\}|\\$HOME\\b|~)(?=/|[\\s"';|&<>()\`]|$)`, 'g');
const REL_RE = new RegExp(`(?<=^|${BOUNDARY})(\\.\\.?(?:/[^\\s"';|&<>()\`$]*)?)`, 'g');
const CD_RE = /(?:^|[;&|(\s])(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g;

const expandHome = (t) => t.replace(HOME_RE, (_, pre) => pre + os.homedir());

/**
 * Walk a command left to right, following each `cd` / `pushd`: where each one
 * lands (`cds`), and where each `..` path points from the directory the
 * command is in by then (`rels`). Targets built from other variables or
 * `$(...)` can't be followed and are skipped.
 */
function walkCommand(cmd, cwd) {
  const events = [
    ...[...cmd.matchAll(CD_RE)].map((m) => ({ at: m.index, end: m.index + m[0].length, cd: m[1] })),
    ...[...cmd.matchAll(REL_RE)].map((m) => ({ at: m.index, rel: m[1] })),
  ].sort((a, b) => a.at - b.at);
  const cds = [];
  const rels = [];
  let dir = cwd;
  let cdEnd = -1;
  for (const e of events) {
    if (e.cd !== undefined) {
      cdEnd = e.end;
      const t = expandHome(e.cd.replace(/^(["'])(.*)\1$/, '$2'));
      if (t === '-' || /[$`*?]/.test(t)) continue;
      dir = path.resolve(dir, t);
      cds.push(dir);
    } else if (e.at >= cdEnd && /(^|\/)\.\.(\/|$)/.test(e.rel)) {
      rels.push(path.resolve(dir, e.rel));
    }
  }
  return { cds, rels };
}

/**
 * Every path a Bash command can reach by spelling: literal absolute paths,
 * `~` / `$HOME` paths, `..` paths and `cd` targets. The last three are how a
 * remembered checkout (`~/code/app`) or its parent gets named, so the
 * other-checkout check uses all of them.
 */
export function reachablePaths(cmd, cwd) {
  if (typeof cmd !== 'string') return [];
  const { cds, rels } = walkCommand(cmd, cwd);
  return [...extractAbsPaths(expandHome(cmd)).map((p) => path.resolve(p)), ...rels, ...cds];
}

/** Where each `cd` / `pushd` in a command lands, following earlier ones. */
export function cdTargets(cmd, cwd) {
  return typeof cmd === 'string' ? walkCommand(cmd, cwd).cds : [];
}

// Does `p` exist spelled exactly so? On a case-insensitive disk `/users` finds
// `/Users`, which would make every `/users/...` API route look like a path.
function existsWithCase(p) {
  const { root } = path.parse(p);
  let dir = root;
  for (const seg of p.slice(root.length).split(path.sep).filter(Boolean)) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return false;
    }
    if (!names.includes(seg)) return false;
    dir = path.join(dir, seg);
  }
  return true;
}

// A token like `/foo/g` inside a `node -e` regex, or a `/users/1` route, is not
// a path. Count it only if it exists, or would be a new entry in an existing
// directory below the top level (`/home/1` is a route; `/home/u/x` is a path).
function looksLikeRealPath(p) {
  if (existsWithCase(p)) return true;
  const parent = path.dirname(p);
  return path.dirname(parent) !== path.parse(p).root && existsWithCase(parent);
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

  const allowedOutside = (p) =>
    [...BASH_EXEMPT, ...BIN_DIRS].some((d) => isInsideRoot(p, d)) ||
    dependencyDirs([cwd, root]).some((d) => isInsideRoot(p, d));
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
      const cmd = input?.command;
      const cds = cdTargets(cmd, cwd);
      for (const p of reachablePaths(cmd, cwd)) {
        const owner = otherCheckout(p);
        if (owner) return deny('Bash', p, owner);
      }
      // Leaving the project with `cd` makes every later relative path unknowable.
      const literal = extractAbsPaths(cmd).map((t) => path.resolve(t));
      for (const p of [...cds, ...literal]) {
        if (isInsideRoot(p, root) || allowedOutside(p)) continue;
        if (looksLikeRealPath(p)) return deny('Bash', p, null);
      }
    }
    return null;
  };
}
