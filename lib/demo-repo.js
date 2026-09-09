import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { parseRemote } from './context-repo.js';
import { DEMO_REPO, DEMO_REPO_SSH_URL, DEMO_REPO_HTTPS_URL } from './config.js';
import * as timings from './timings.js';

/**
 * The welcome screen's [d] key: clone the demo repo and run setup in it.
 *
 * The whole module exists to be the equivalent of what we used to print and
 * ask the user to type:
 *
 *     git clone git@github.com:restlesshq/demo.git && cd demo && npx restless init
 *
 * The `cd` half is the caller's job (`bin/restless.js` chdirs and re-points
 * the path guard); this module owns picking the directory and getting the
 * clone onto disk.
 *
 * Everything degrades rather than throws: no git, no SSH key, no network, a
 * `demo/` that's already there. The caller gets a result object and prints
 * the manual commands if we couldn't do it for them.
 *
 * A LEAF module apart from config + the remote parser: fs and child_process.
 */

/** Directory name we clone into, matching the `cd demo` in the command. */
export const DEMO_DIR_NAME = 'demo';

/** Give up rather than litter the cwd with demo-2 … demo-N forever. */
const MAX_DIR_ATTEMPTS = 20;

/**
 * The URLs to try, in order.
 *
 * SSH first (it's the URL we advertise, and the one that works on a dev
 * machine with a key loaded), HTTPS second so a machine with no key - or one
 * behind a firewall that blocks port 22 - still gets the demo. A public repo
 * clones anonymously over HTTPS, so the fallback needs no credentials.
 *
 * `RESTLESS_DEMO_REPO` overrides both with a single URL (any git URL, a local
 * path included) - for tests and for pointing a workshop at a fork.
 */
export function demoCloneUrls() {
  const override = (process.env.RESTLESS_DEMO_REPO || '').trim();
  if (override) return [override];
  return [DEMO_REPO_SSH_URL, DEMO_REPO_HTTPS_URL];
}

/**
 * Run git, never throwing. Returns `{ ok, status, stdout, stderr }`.
 *
 * Non-interactive on purpose: an SSH clone against an unknown host, or an
 * HTTPS clone of something private, otherwise sits on a prompt forever with
 * stdin closed. `BatchMode=yes` / `GIT_TERMINAL_PROMPT=0` turn both into a
 * fast, ordinary failure - which is what lets us fall through to the next URL.
 */
function runGit(args, { cwd, timeout = 120_000 } = {}) {
  const endSpan = timings.start(`git ${args[0]}`, { kind: timings.KINDS.EXEC });
  try {
    const res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes',
      },
    });
    if (res.error) return { ok: false, status: null, stdout: '', stderr: res.error.message };
    return {
      ok: res.status === 0,
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
    };
  } finally {
    endSpan();
  }
}

/** Strip the trailing `.git`, trailing slashes, and case from a remote URL. */
function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
}

/** Is `git` on PATH at all? */
export function hasGit({ run = runGit } = {}) {
  return run(['--version'], {}).ok;
}

/**
 * Does this remote URL point at the demo repo?
 *
 * Two ways to match, because `RESTLESS_DEMO_REPO` can be a local path that
 * `parseRemote` (host/owner/repo shapes only) rightly returns null for:
 * owner/repo equality for a real forge URL, and plain URL equality against
 * whatever we'd clone from.
 */
export function isDemoRemote(url, { urls = demoCloneUrls() } = {}) {
  if (!url) return false;
  const parsed = parseRemote(url);
  if (parsed && `${parsed.owner}/${parsed.repo}`.toLowerCase() === DEMO_REPO.toLowerCase()) return true;
  return urls.some((candidate) => normalizeUrl(candidate) === normalizeUrl(url));
}

/**
 * Is `dir` the top of an existing clone of the demo repo?
 *
 * Both halves matter: `rev-parse --show-toplevel` has to come back as `dir`
 * itself (a `demo/` that happens to sit inside some other repo would
 * otherwise report that repo's root and its remote), and `origin` has to be
 * the demo repo. Anything else - a stale directory, an unrelated project
 * someone already keeps at `./demo` - is not ours to reuse.
 */
export function isDemoClone(dir, { run = runGit } = {}) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const top = run(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (!top.ok) return false;
  try {
    if (fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(dir)) return false;
  } catch {
    return false;
  }
  const origin = run(['remote', 'get-url', 'origin'], { cwd: dir });
  return origin.ok && isDemoRemote(origin.stdout.trim());
}

/**
 * Where to put the clone: `./demo`, or the next free `./demo-N`.
 *
 * An existing clone of the demo repo is reused rather than duplicated -
 * pressing [d] twice should drop you back into the demo you already have,
 * partly set up, instead of leaving a trail of copies. A `./demo` that is
 * something else entirely is left strictly alone.
 *
 * Returns `{ dir, reuse }`, with `dir: null` when every name is taken.
 */
export function pickCloneDir(parentDir, { run = runGit, name = DEMO_DIR_NAME } = {}) {
  for (let i = 1; i <= MAX_DIR_ATTEMPTS; i++) {
    const dir = path.join(parentDir, i === 1 ? name : `${name}-${i}`);
    if (!fs.existsSync(dir)) return { dir, reuse: false };
    if (isDemoClone(dir, { run })) return { dir, reuse: true };
  }
  return { dir: null, reuse: false };
}

/** Last non-empty line of git's stderr - the part that says what went wrong. */
function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) || '';
}

/**
 * Clone the demo repo next to wherever the user ran us from.
 *
 * Returns one of:
 * - `{ ok: true, dir, reused: true }`            - an existing clone to cd into
 * - `{ ok: true, dir, url, reused: false }`      - freshly cloned
 * - `{ ok: false, reason, attempts }`            - `no-git` | `no-dir` | `clone-failed`
 *
 * `onAttempt(url)` fires before each clone so the caller can name the URL in
 * a spinner. A failed attempt's half-written directory is removed before the
 * next URL is tried: git leaves it behind on some failures, and it would
 * otherwise make the retry fail with "already exists".
 */
export function cloneDemoRepo({ parentDir, run = runGit, onAttempt } = {}) {
  if (!hasGit({ run })) return { ok: false, reason: 'no-git', attempts: [] };

  const { dir, reuse } = pickCloneDir(parentDir, { run });
  if (!dir) return { ok: false, reason: 'no-dir', attempts: [] };
  if (reuse) return { ok: true, dir, reused: true, attempts: [] };

  const attempts = [];
  for (const url of demoCloneUrls()) {
    onAttempt?.(url);
    const res = run(['clone', url, dir], { cwd: parentDir });
    if (res.ok) return { ok: true, dir, url, reused: false, attempts };
    attempts.push({ url, error: lastLine(res.stderr) });
    // Only ever a directory this call asked git to create, so removing it
    // can't take anything the user had.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  return { ok: false, reason: 'clone-failed', dir, attempts };
}
