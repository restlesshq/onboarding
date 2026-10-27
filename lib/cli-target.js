import fs from 'fs';
import path from 'path';

/**
 * Which CLI `init cli` is setting up, and what it is built on. Pure reads of
 * the filesystem, so every decision the command makes is testable without
 * running it.
 */

// One package for both Node paths: an SDK to call, and an oclif plugin.
export const SDK_PACKAGE = '@restlessai/cli-sdk';
export const FEEDBACK_DOMAIN = 'restlessdocs.com';

/** Where a native CLI posts its notes; the same URL the npm packages resolve a slug to. */
export function feedbackEndpoint(slug) {
  return `https://${slug}.${FEEDBACK_DOMAIN}/feedback`;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.restless', 'dist', 'build', 'out', 'coverage', '.next', 'vendor',
  '.venv', 'venv', '__pycache__', 'target',
]);
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

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const tomlString = (text, section, key) => {
  const body = text.split(/^\[/m).find((part) => part.startsWith(`${section}]`)) || '';
  return body.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1] || '';
};

const tomlKeys = (text, section) => {
  const body = text.split(/^\[/m).find((part) => part.startsWith(`${section}]`)) || '';
  return [...body.matchAll(/^["']?([A-Za-z0-9_.-]+)["']?\s*=/gm)].map((m) => m[1]);
};

function goCli(dir) {
  const mod = readText(path.join(dir, 'go.mod'));
  if (!/github\.com\/(spf13\/cobra|urfave\/cli|alecthomas\/kong)/.test(mod)) return null;
  const name = mod.match(/^module\s+(\S+)/m)?.[1]?.split('/').pop() || path.basename(dir);
  let bins = [];
  try {
    bins = fs.readdirSync(path.join(dir, 'cmd'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {}
  return { language: 'go', evidence: 'go.mod', name, version: '', bins: bins.length ? bins : [name] };
}

function pythonCli(dir) {
  const py = readText(path.join(dir, 'pyproject.toml'));
  for (const [meta, scripts] of [['project', 'project.scripts'], ['tool.poetry', 'tool.poetry.scripts']]) {
    const bins = tomlKeys(py, scripts);
    if (bins.length) {
      const name = tomlString(py, meta, 'name') || path.basename(dir);
      return { language: 'python', evidence: 'pyproject.toml', name, version: tomlString(py, meta, 'version'), bins };
    }
  }
  for (const file of ['setup.py', 'setup.cfg']) {
    const text = readText(path.join(dir, file));
    if (!/console_scripts/.test(text)) continue;
    const bins = [...text.matchAll(/["']?([A-Za-z0-9_.-]+)\s*=\s*[A-Za-z0-9_.]+:[A-Za-z0-9_]+/g)].map((m) => m[1]);
    const name = text.match(/name\s*[=:]\s*["']?([A-Za-z0-9_.-]+)/)?.[1] || path.basename(dir);
    return { language: 'python', evidence: file, name, version: '', bins: bins.length ? bins : [name] };
  }
  return null;
}

function rustCli(dir) {
  const cargo = readText(path.join(dir, 'Cargo.toml'));
  if (!/^\[\[bin\]\]|^clap\s*=/m.test(cargo)) return null;
  const name = tomlString(cargo, 'package', 'name') || path.basename(dir);
  const bins = [...cargo.matchAll(/^\[\[bin\]\][^[]*?^name\s*=\s*"([^"]+)"/gms)].map((m) => m[1]);
  return { language: 'rust', evidence: 'Cargo.toml', name, version: tomlString(cargo, 'package', 'version'), bins: bins.length ? bins : [name] };
}

function rubyCli(dir) {
  let gemspec;
  try {
    gemspec = fs.readdirSync(dir).find((f) => f.endsWith('.gemspec'));
  } catch {}
  const text = gemspec ? readText(path.join(dir, gemspec)) : '';
  if (!/\.executables\s*=/.test(text)) return null;
  const name = text.match(/\.name\s*=\s*["']([^"']+)["']/)?.[1] || gemspec.replace(/\.gemspec$/, '');
  const exec = text.match(/\.executables\s*=\s*(?:%w\[([^\]]*)\]|\[([^\]]*)\])/);
  const bins = exec ? (exec[1] || exec[2] || '').split(/[\s,]+/).map((b) => b.replace(/["']/g, '')).filter(Boolean) : [];
  return { language: 'ruby', evidence: gemspec, name, version: '', bins: bins.length ? bins : [name] };
}

/**
 * A CLI written in Go, Python, Rust or Ruby, described the way `describeCli`
 * describes a Node one. Only consulted when no Node CLI was found, so a Node
 * CLI with a Go helper alongside it is never mistaken for a Go CLI.
 */
export function describeNativeCli(dirs) {
  for (const dir of [...new Set(dirs)]) {
    const found = goCli(dir) || pythonCli(dir) || rustCli(dir) || rubyCli(dir);
    if (found) return { dir, oclif: false, native: true, ...found };
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
export function packageSpecs(env = process.env) {
  const dir = env.RESTLESS_FEEDBACK_TARBALLS;
  if (!dir) return [SDK_PACKAGE];
  const prefix = SDK_PACKAGE.replace(/^@/, '').replace('/', '-') + '-';
  const tgz = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.tgz')).sort().pop();
  if (!tgz) throw new Error(`No ${SDK_PACKAGE} tarball in ${dir}`);
  return [path.join(path.resolve(dir), tgz)];
}

const NATIVE_SOURCE = { go: /\.go$/, python: /\.py$/, rust: /\.rs$/, ruby: /\.rb$|^[^.]+$/ };

function sourceMentions(dir, needle, files = /\.(c|m)?(j|t)sx?$/) {
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
      } else if (files.test(e.name) && fileHas(full, needle)) {
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
  if (cli.native) {
    const wired = sourceMentions(cli.dir, new RegExp(FEEDBACK_DOMAIN.replace('.', '\\.')), NATIVE_SOURCE[cli.language]);
    return { state: wired ? 'wired' : 'none', project: '' };
  }
  const deps = allDeps(cli.pkg);
  if (cli.oclif) {
    const plugins = Array.isArray(cli.pkg.oclif?.plugins) ? cli.pkg.oclif.plugins : [];
    const block = cli.pkg.restless && typeof cli.pkg.restless === 'object' ? cli.pkg.restless : {};
    const project = typeof block.project === 'string' ? block.project : '';
    const named = Boolean(project || block.docsUrl);
    const listed = plugins.includes(SDK_PACKAGE);
    const installed = Boolean(deps[SDK_PACKAGE]);
    // An explicit `commands` list without feedback means the plugin is wired but the command is opted out.
    const enabled = !Array.isArray(block.commands) || block.commands.includes('feedback');
    if (listed && installed && named && enabled) return { state: 'wired', project };
    return { state: listed || installed || named ? 'partial' : 'none', project };
  }
  const installed = Boolean(deps[SDK_PACKAGE]);
  const called = sourceMentions(cli.dir, /\bsubmitFeedback\s*\(/);
  if (installed && called) return { state: 'wired', project: '' };
  return { state: installed || called ? 'partial' : 'none', project: '' };
}
