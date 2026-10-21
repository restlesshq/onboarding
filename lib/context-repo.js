import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

/**
 * What repo are we in, where is it now, and what changed since last time.
 *
 * All of it comes from git, and all of it degrades: a repo with no remote
 * still gets a stable identity, a repo with no commits still gets scanned, and
 * a directory that is not a repo at all is still indexable (as a one-off full
 * scan that can never be incremental). `context` is meant to run in whatever
 * repo the developer happens to be in, and refusing to run because the git
 * state is unusual would defeat that.
 *
 * A LEAF module: only crypto and child_process.
 */

/** Resolve symlinks, falling back to the input for a path that isn't there. */
function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Run a git command, returning trimmed stdout or null. Never throws. */
function git(cwd, args) {
  try {
    return execSync(`git ${args}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse a git remote URL into host/owner/repo.
 *
 * Handles the three shapes in the wild: scp-style SSH
 * (`git@github.com:owner/repo.git`), ssh:// and https://. Anything else
 * returns null and the caller falls back to a local identity.
 */
export function parseRemote(url) {
  if (!url) return null;
  const trimmed = url.trim().replace(/\.git$/, '');

  // git@host:owner/repo
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  if (scp) {
    const [, host, pathPart] = scp;
    const segments = pathPart.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return { host, owner: segments.slice(0, -1).join('/'), repo: segments.at(-1) };
  }

  // ssh://host/owner/repo, https://host/owner/repo
  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) return null;
    return {
      host: parsed.hostname,
      owner: segments.slice(0, -1).join('/'),
      repo: segments.at(-1),
    };
  } catch {
    return null;
  }
}

/**
 * Describe the repository at `cwd`.
 *
 * `localId` is the fallback identity for a repo with no remote: a hash of the
 * absolute path of its root. It is deliberately NOT the path itself - the
 * server has no business knowing where on someone's disk their code lives, and
 * a hash is all that is needed to recognise the same checkout twice.
 */
export function describeRepo(cwd) {
  const root = git(cwd, 'rev-parse --show-toplevel') || cwd;
  const remoteUrl = git(cwd, 'remote get-url origin');
  const parsed = parseRemote(remoteUrl);
  const headSha = git(cwd, 'rev-parse HEAD') || '';
  const branch = git(cwd, 'rev-parse --abbrev-ref HEAD') || '';

  // What we are indexing, relative to the repo root. Empty when the CLI was
  // run at the root. Part of the source's identity, because indexing
  // `packages/api` is not the same job as indexing the whole monorepo.
  //
  // Both sides are realpath'd before they are compared. `--show-toplevel`
  // resolves symlinks and `process.cwd()` does not, so on a macOS temp dir
  // (/tmp -> /private/tmp), a symlinked worktree, or a homedir behind an
  // automounter, the two spellings of the same directory don't match and every
  // subdirectory silently reads as the repo root.
  const rel = path.relative(realpath(root), realpath(cwd));
  // `..` means cwd is outside the reported root, which git should never do.
  // Treat it as "no subpath" rather than sending a traversal upward.
  const rootPath = !rel || rel.startsWith('..') ? '' : rel.split(path.sep).join('/');

  return {
    root,
    rootPath,
    isGit: !!git(cwd, 'rev-parse --is-inside-work-tree'),
    headSha,
    branch: branch === 'HEAD' ? '' : branch,
    host: parsed?.host || '',
    owner: parsed?.owner || '',
    repo: parsed?.repo || '',
    localId: parsed
      ? ''
      : crypto.createHash('sha256').update(root).digest('hex').slice(0, 32),
    label: parsed ? `${parsed.owner}/${parsed.repo}` : (path.basename(root) || 'local repo'),
  };
}

/**
 * Files that changed between `sinceSha` and HEAD.
 *
 * Returns `{ ok: true, files }` when git could answer, and `{ ok: false }`
 * when it could not - which is the honest outcome for a commit that is no
 * longer in this clone (a rebase, a squash, a shallow checkout, a branch that
 * never had it). The caller then does a full scan, because a diff against a
 * commit we cannot resolve is not "no changes", it is "no idea", and quietly
 * treating it as the former is how a re-run silently indexes nothing.
 */
export function changedSince(cwd, sinceSha) {
  if (!sinceSha) return { ok: false, reason: 'no-baseline' };
  // Is that commit actually here? `cat-file -e` is the cheap existence check.
  if (git(cwd, `cat-file -e ${sinceSha}^{commit}`) === null) {
    return { ok: false, reason: 'unknown-commit' };
  }
  const out = git(cwd, `diff --name-only ${sinceSha} HEAD`);
  if (out === null) return { ok: false, reason: 'diff-failed' };
  const files = out.split('\n').map((f) => f.trim()).filter(Boolean);
  return { ok: true, files };
}

/** Uncommitted work, so a run can say what it is (and isn't) looking at. */
export function hasUncommittedChanges(cwd) {
  const out = git(cwd, 'status --porcelain');
  return !!out;
}
