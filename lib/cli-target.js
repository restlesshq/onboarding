import fs from 'fs';
import path from 'path';

/**
 * Which CLI `init cli` is setting up, and what it is built on. Pure reads of
 * the filesystem, so every decision the command makes is testable without
 * running it.
 */

export const CORE_PACKAGE = '@restlessai/cli-feedback';
export const OCLIF_PACKAGE = '@restlessai/oclif-plugin-feedback';

const SKIP_DIRS = new Set(['node_modules', '.git', '.restless', 'dist', 'build', 'out', 'coverage', '.next', 'vendor']);
const MAX_DEPTH = 4;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function binNames(pkg) {
  if (typeof pkg.bin === 'string' && pkg.bin) return [String(pkg.name || '').replace(/^@[^/]+\//, '')].filter(Boolean);
  if (pkg.bin && typeof pkg.bin === 'object') return Object.keys(pkg.bin);
  return [];
}

function allDeps(pkg) {
  return { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.dependencies };
}

/** True for an oclif CLI: it depends on oclif's runtime, or carries the `oclif` manifest block. */
export function isOclifPackage(pkg) {
  const deps = allDeps(pkg);
  return Boolean(deps['@oclif/core'] || deps['@oclif/command'] || (pkg.oclif && typeof pkg.oclif === 'object'));
}

/** Describe the package at `dir` if it ships a CLI (has a `bin`), else null. */
export function describeCli(dir) {
  const pkg = readJson(path.join(dir, 'package.json'));
  if (!pkg || typeof pkg !== 'object') return null;
  const bins = binNames(pkg);
  if (bins.length === 0) return null;
  return {
    dir,
    name: typeof pkg.name === 'string' ? pkg.name : path.basename(dir),
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    bins,
    oclif: isOclifPackage(pkg),
    pkg,
  };
}

/**
 * The Node CLIs this run could mean. The directory it was run from wins
 * outright; otherwise every package with a `bin` under the repo root.
 */
export function findCliPackages(startDir, rootDir = startDir) {
  const here = describeCli(startDir);
  if (here) return [here];

  const found = [];
  (function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    const cli = describeCli(dir);
    if (cli) found.push(cli);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), depth + 1);
      }
    }
  })(rootDir, 0);
  return found.sort((a, b) => a.dir.localeCompare(b.dir));
}

function fileHas(file, re) {
  try {
    return re.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * A CLI written in something other than Node, which this command cannot set
 * up yet. Only consulted when no Node CLI was found, so a Node CLI with a Go
 * helper alongside it is never refused.
 */
export function detectNonNodeCli(dirs) {
  for (const dir of [...new Set(dirs)]) {
    const at = (f) => path.join(dir, f);
    if (fileHas(at('go.mod'), /github\.com\/(spf13\/cobra|urfave\/cli|alecthomas\/kong)/)) {
      return { language: 'go', evidence: 'go.mod' };
    }
    if (fileHas(at('pyproject.toml'), /^\[(project\.scripts|tool\.poetry\.scripts)\]/m)) {
      return { language: 'python', evidence: 'pyproject.toml' };
    }
    if (fileHas(at('setup.py'), /console_scripts/) || fileHas(at('setup.cfg'), /console_scripts/)) {
      return { language: 'python', evidence: fs.existsSync(at('setup.py')) ? 'setup.py' : 'setup.cfg' };
    }
    if (fileHas(at('Cargo.toml'), /^\[\[bin\]\]|^clap\s*=/m)) {
      return { language: 'rust', evidence: 'Cargo.toml' };
    }
    let gemspec = null;
    try {
      gemspec = fs.readdirSync(dir).find((f) => f.endsWith('.gemspec'));
    } catch {}
    if (gemspec && fileHas(at(gemspec), /\.executables\s*=/)) return { language: 'ruby', evidence: gemspec };
  }
  return null;
}

/** npm, pnpm, yarn or bun: the `packageManager` field first, then the nearest lockfile up to the root. */
export function detectPackageManager(cliDir, rootDir = cliDir) {
  const declared = readJson(path.join(cliDir, 'package.json'))?.packageManager;
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name;
  }
  const stop = path.resolve(rootDir);
  for (let dir = path.resolve(cliDir); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
    if (dir === stop || dir === path.dirname(dir)) return 'npm';
  }
}

/** The install command as one argv, so nothing is ever interpolated into a shell. */
export function installArgs(manager, specs) {
  return manager === 'npm' ? ['npm', ['install', ...specs]] : [manager, ['add', ...specs]];
}

/**
 * What to install for this CLI. `RESTLESS_FEEDBACK_TARBALLS` points at a
 * directory of `npm pack` output, for trying unpublished packages locally.
 */
export function packageSpecs(oclif, env = process.env) {
  const names = oclif ? [OCLIF_PACKAGE, CORE_PACKAGE] : [CORE_PACKAGE];
  const dir = env.RESTLESS_FEEDBACK_TARBALLS;
  if (!dir) return oclif ? [OCLIF_PACKAGE] : [CORE_PACKAGE];
  return names.map((name) => {
    const prefix = name.replace(/^@/, '').replace('/', '-') + '-';
    const tgz = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.tgz')).sort().pop();
    if (!tgz) throw new Error(`No ${name} tarball in ${dir}`);
    return path.join(path.resolve(dir), tgz);
  });
}

function sourceMentions(dir, needle) {
  let hit = false;
  (function walk(d, depth) {
    if (hit || depth > MAX_DEPTH + 2) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && !e.isSymbolicLink()) walk(full, depth + 1);
      } else if (/\.(c|m)?(j|t)sx?$/.test(e.name) && fileHas(full, needle)) {
        hit = true;
      }
    }
  })(dir, 0);
  return hit;
}

/**
 * Whether this CLI already has the command. `wired` is a finished setup;
 * `partial` (a dependency with no wiring, or the reverse) is worth finishing;
 * `none` is a fresh one. `project` is the slug an oclif setup names, if any.
 */
export function feedbackStatus(cli) {
  const deps = allDeps(cli.pkg);
  if (cli.oclif) {
    const plugins = Array.isArray(cli.pkg.oclif?.plugins) ? cli.pkg.oclif.plugins : [];
    const block = cli.pkg.restless && typeof cli.pkg.restless === 'object' ? cli.pkg.restless : {};
    const project = typeof block.project === 'string' ? block.project : '';
    const named = Boolean(project || block.docsUrl);
    const listed = plugins.includes(OCLIF_PACKAGE);
    const installed = Boolean(deps[OCLIF_PACKAGE]);
    if (listed && installed && named) return { state: 'wired', project };
    return { state: listed || installed || named ? 'partial' : 'none', project };
  }
  const installed = Boolean(deps[CORE_PACKAGE]);
  const called = sourceMentions(cli.dir, /\bsubmitFeedback\s*\(/);
  if (installed && called) return { state: 'wired', project: '' };
  return { state: installed || called ? 'partial' : 'none', project: '' };
}
