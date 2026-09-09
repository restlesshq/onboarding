import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  DEMO_DIR_NAME,
  cloneDemoRepo,
  demoCloneUrls,
  hasGit,
  isDemoClone,
  isDemoRemote,
  pickCloneDir,
} from '../lib/demo-repo.js';
import { DEMO_REPO_HTTPS_URL, DEMO_REPO_SSH_URL } from '../lib/config.js';

const tmpDirs = [];

function tmpDir() {
  const dir = fs.realpathSync(execSync('mktemp -d', { encoding: 'utf8' }).trim());
  tmpDirs.push(dir);
  return dir;
}

/** A real local repo with one commit, standing in for github.com/restlesshq/demo. */
function fakeDemoOrigin() {
  const dir = tmpDir();
  execSync('git init -q', { cwd: dir, stdio: 'pipe' });
  fs.writeFileSync(path.join(dir, 'server.js'), '// demo api\n');
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync(
    'git -c user.email=demo@example.com -c user.name=Demo commit -q -m "demo"',
    { cwd: dir, stdio: 'pipe' },
  );
  return dir;
}

/** A stub `run` that answers from a table, so no git process is involved. */
function stubRun(answers) {
  const calls = [];
  const run = (args, opts = {}) => {
    calls.push({ args, cwd: opts.cwd });
    for (const [match, result] of answers) {
      if (match(args, opts)) return { ok: true, status: 0, stdout: '', stderr: '', ...result };
    }
    return { ok: false, status: 1, stdout: '', stderr: 'stub: no answer' };
  };
  run.calls = calls;
  return run;
}

const gitVersion = (args) => args[0] === '--version';

afterEach(() => {
  delete process.env.RESTLESS_DEMO_REPO;
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true }); } catch {}
  }
});

describe('demoCloneUrls', () => {
  it('tries SSH first, then HTTPS', () => {
    expect(demoCloneUrls()).toEqual([DEMO_REPO_SSH_URL, DEMO_REPO_HTTPS_URL]);
  });

  it('honours RESTLESS_DEMO_REPO as the only URL', () => {
    process.env.RESTLESS_DEMO_REPO = 'git@github.com:someone/fork.git';
    expect(demoCloneUrls()).toEqual(['git@github.com:someone/fork.git']);
  });
});

describe('isDemoRemote', () => {
  it('recognizes the demo repo in every URL shape', () => {
    expect(isDemoRemote('git@github.com:restlesshq/demo.git')).toBe(true);
    expect(isDemoRemote('https://github.com/restlesshq/demo.git')).toBe(true);
    expect(isDemoRemote('https://github.com/restlesshq/demo')).toBe(true);
    expect(isDemoRemote('ssh://git@github.com/restlesshq/demo.git')).toBe(true);
    expect(isDemoRemote('https://github.com/RestlessHQ/Demo.git')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isDemoRemote('')).toBe(false);
    expect(isDemoRemote(null)).toBe(false);
    expect(isDemoRemote('git@github.com:restlesshq/onboarding.git')).toBe(false);
    expect(isDemoRemote('git@github.com:someone/demo.git')).toBe(false);
  });

  // The override can be a local path, which parses as no owner/repo at all -
  // so URL equality has to carry the match on its own.
  it('matches a local-path override', () => {
    process.env.RESTLESS_DEMO_REPO = '/tmp/fixtures/demo.git';
    expect(isDemoRemote('/tmp/fixtures/demo')).toBe(true);
    expect(isDemoRemote('/tmp/fixtures/other')).toBe(false);
  });
});

describe('pickCloneDir', () => {
  it('picks ./demo when nothing is there', () => {
    const parent = tmpDir();
    const run = stubRun([]);
    expect(pickCloneDir(parent, { run })).toEqual({ dir: path.join(parent, 'demo'), reuse: false });
  });

  it('reuses a ./demo that is already a clone of the demo repo', () => {
    const parent = tmpDir();
    const demo = path.join(parent, 'demo');
    fs.mkdirSync(demo);
    const run = stubRun([
      [(args) => args[0] === 'rev-parse', { stdout: `${demo}\n` }],
      [(args) => args[0] === 'remote', { stdout: `${DEMO_REPO_SSH_URL}\n` }],
    ]);
    expect(pickCloneDir(parent, { run })).toEqual({ dir: demo, reuse: true });
  });

  // Someone else's ./demo is not ours to touch, or to set up in.
  it('steps around a ./demo that is something else', () => {
    const parent = tmpDir();
    fs.mkdirSync(path.join(parent, 'demo'));
    const run = stubRun([
      [(args) => args[0] === 'rev-parse', { ok: false, status: 128 }],
    ]);
    expect(pickCloneDir(parent, { run })).toEqual({ dir: path.join(parent, 'demo-2'), reuse: false });
  });

  it('gives up rather than clone into demo-1000', () => {
    const parent = tmpDir();
    for (let i = 1; i <= 20; i++) {
      fs.mkdirSync(path.join(parent, i === 1 ? 'demo' : `demo-${i}`));
    }
    const run = stubRun([[(args) => args[0] === 'rev-parse', { ok: false, status: 128 }]]);
    expect(pickCloneDir(parent, { run })).toEqual({ dir: null, reuse: false });
  });
});

describe('isDemoClone', () => {
  it('is false for a path that does not exist, and for a file', () => {
    const parent = tmpDir();
    const file = path.join(parent, 'demo');
    fs.writeFileSync(file, 'not a directory');
    const run = stubRun([]);
    expect(isDemoClone(path.join(parent, 'nope'), { run })).toBe(false);
    expect(isDemoClone(file, { run })).toBe(false);
  });

  // A plain `demo/` inside some other repo reports THAT repo's root and
  // remote. Without the toplevel check we'd happily "reuse" it.
  it('is false for a directory that merely sits inside another repo', () => {
    const parent = tmpDir();
    const demo = path.join(parent, 'demo');
    fs.mkdirSync(demo);
    const run = stubRun([
      [(args) => args[0] === 'rev-parse', { stdout: `${parent}\n` }],
      [(args) => args[0] === 'remote', { stdout: `${DEMO_REPO_SSH_URL}\n` }],
    ]);
    expect(isDemoClone(demo, { run })).toBe(false);
  });
});

describe('cloneDemoRepo', () => {
  it('reports no-git when git is missing', () => {
    const run = stubRun([]); // even `git --version` fails
    const result = cloneDemoRepo({ parentDir: tmpDir(), run });
    expect(result).toMatchObject({ ok: false, reason: 'no-git' });
  });

  it('falls back to HTTPS when the SSH clone fails', () => {
    const parent = tmpDir();
    const run = stubRun([
      [gitVersion, {}],
      [(args) => args[0] === 'clone' && args[1] === DEMO_REPO_HTTPS_URL, {}],
    ]);
    const result = cloneDemoRepo({ parentDir: parent, run });
    expect(result).toMatchObject({
      ok: true,
      dir: path.join(parent, DEMO_DIR_NAME),
      url: DEMO_REPO_HTTPS_URL,
      reused: false,
    });
    expect(result.attempts).toEqual([{ url: DEMO_REPO_SSH_URL, error: 'stub: no answer' }]);
    expect(run.calls.filter((c) => c.args[0] === 'clone').map((c) => c.args[1]))
      .toEqual([DEMO_REPO_SSH_URL, DEMO_REPO_HTTPS_URL]);
  });

  it('reports clone-failed with what each URL said', () => {
    const run = stubRun([[gitVersion, {}]]);
    const result = cloneDemoRepo({ parentDir: tmpDir(), run });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('clone-failed');
    expect(result.attempts.map((a) => a.url)).toEqual([DEMO_REPO_SSH_URL, DEMO_REPO_HTTPS_URL]);
  });

  it('reports no-dir when there is nowhere to clone into', () => {
    const parent = tmpDir();
    for (let i = 1; i <= 20; i++) {
      fs.mkdirSync(path.join(parent, i === 1 ? 'demo' : `demo-${i}`));
    }
    const run = stubRun([
      [gitVersion, {}],
      [(args) => args[0] === 'rev-parse', { ok: false, status: 128 }],
    ]);
    expect(cloneDemoRepo({ parentDir: parent, run })).toMatchObject({ ok: false, reason: 'no-dir' });
  });

  // The end-to-end shape, with a real `git clone` against a local origin:
  // ./demo appears, and pressing [d] again lands back in it instead of
  // making a second copy.
  it('clones for real, then reuses the clone on a second run', () => {
    if (!hasGit()) return;
    const origin = fakeDemoOrigin();
    process.env.RESTLESS_DEMO_REPO = origin;
    const parent = tmpDir();

    const first = cloneDemoRepo({ parentDir: parent });
    expect(first).toMatchObject({ ok: true, dir: path.join(parent, 'demo'), reused: false });
    expect(fs.existsSync(path.join(first.dir, 'server.js'))).toBe(true);
    expect(isDemoClone(first.dir)).toBe(true);

    const second = cloneDemoRepo({ parentDir: parent });
    expect(second).toMatchObject({ ok: true, dir: first.dir, reused: true });
    expect(fs.existsSync(path.join(parent, 'demo-2'))).toBe(false);
  });

  // A failed attempt can leave a half-written directory behind; the HTTPS
  // retry then dies with "already exists" unless we clear it first.
  it('clears a partial clone before trying the next URL', () => {
    const parent = tmpDir();
    const demo = path.join(parent, DEMO_DIR_NAME);
    const seen = [];
    const run = (args, opts = {}) => {
      if (args[0] === '--version') return { ok: true, status: 0, stdout: '', stderr: '' };
      if (args[0] === 'clone') {
        seen.push({ url: args[1], existedBefore: fs.existsSync(demo) });
        fs.mkdirSync(path.join(demo, '.git'), { recursive: true }); // partial clone
        return { ok: false, status: 128, stdout: '', stderr: 'fatal: Could not read from remote' };
      }
      return { ok: false, status: 1, stdout: '', stderr: '' };
    };
    cloneDemoRepo({ parentDir: parent, run });
    expect(seen.map((s) => s.existedBefore)).toEqual([false, false]);
    expect(fs.existsSync(demo)).toBe(false);
  });

  it('names each URL as it tries it', () => {
    const attempted = [];
    const run = stubRun([[gitVersion, {}]]);
    cloneDemoRepo({ parentDir: tmpDir(), run, onAttempt: (url) => attempted.push(url) });
    expect(attempted).toEqual([DEMO_REPO_SSH_URL, DEMO_REPO_HTTPS_URL]);
  });
});
