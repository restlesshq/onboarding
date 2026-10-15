import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { makeToolGuard, extractAbsPaths } from '../lib/tool-guard.js';
import { listCheckouts, owningCheckout } from '../lib/pathGuard.js';

// A main checkout, a sibling worktree (the reported setup: init run in the
// worktree, edits landed in main) and a worktree nested inside main.
let base, main, sibling, nested;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-guard-')));
  main = path.join(base, 'main');
  sibling = path.join(base, 'sibling');
  nested = path.join(main, '.claude', 'worktrees', 'nested');
  fs.mkdirSync(path.join(main, 'cmd'), { recursive: true });
  fs.writeFileSync(path.join(main, 'cmd', 'main.go'), 'package main\n');
  git(main, 'init', '-q');
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', sibling);
  git(main, 'worktree', 'add', '-q', nested);
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('listCheckouts / owningCheckout', () => {
  it('lists the main checkout and every worktree from any of them', () => {
    expect(new Set(listCheckouts(sibling))).toEqual(new Set([main, sibling, nested]));
  });

  it('gives a path inside a nested worktree to the nested worktree', () => {
    expect(owningCheckout(path.join(nested, 'a.go'), [main, nested])).toBe(nested);
    expect(owningCheckout(path.join(main, 'a.go'), [main, nested])).toBe(main);
  });
});

describe('makeToolGuard from a worktree', () => {
  const guard = () => makeToolGuard({ gitRoot: sibling, checkouts: listCheckouts(sibling) });

  it('refuses an Edit in the main checkout and names the worktree to use instead', () => {
    const verdict = guard()('Edit', { file_path: path.join(main, 'cmd', 'main.go') });
    expect(verdict.path).toBe(path.join(main, 'cmd', 'main.go'));
    expect(verdict.message).toContain('different checkout');
    expect(verdict.message).toContain(sibling);
  });

  it('refuses a Read in the main checkout too, so the model never builds on it', () => {
    expect(guard()('Read', { file_path: path.join(main, 'cmd', 'main.go') })).not.toBeNull();
    expect(guard()('Grep', { pattern: 'x', path: main })).not.toBeNull();
    expect(guard()('Glob', { pattern: `${main}/**/*.go` })).not.toBeNull();
  });

  it('allows reads and writes inside its own checkout, absolute or relative', () => {
    expect(guard()('Edit', { file_path: path.join(sibling, 'cmd', 'main.go') })).toBeNull();
    expect(guard()('Write', { file_path: 'cmd/new.go' })).toBeNull();
    expect(guard()('Read', { file_path: 'cmd/main.go' })).toBeNull();
  });

  it('allows reading outside the repo (module caches) but not writing there', () => {
    expect(guard()('Read', { file_path: path.join(os.homedir(), 'go', 'pkg', 'mod', 'x.go') })).toBeNull();
    expect(guard()('Write', { file_path: path.join(base, 'elsewhere.go') })).not.toBeNull();
  });

  it('refuses Bash that names the main checkout', () => {
    const verdict = guard()('Bash', { command: `cd ${main} && go get github.com/restlesshq/go` });
    expect(verdict.path).toBe(main);
  });

  it('lets ordinary Bash through: devices, temp files, URLs, module paths, regexes', () => {
    const g = guard();
    expect(g('Bash', { command: 'go build ./... 2>/dev/null' })).toBeNull();
    expect(g('Bash', { command: `cat ${os.tmpdir()}/out.txt` })).toBeNull();
    expect(g('Bash', { command: 'curl -s https://api.example.com/v1/me' })).toBeNull();
    expect(g('Bash', { command: 'go get github.com/restlesshq/go' })).toBeNull();
    expect(g('Bash', { command: `node -e "s.replace(/foo/g, '')"` })).toBeNull();
    expect(g('Bash', { command: `ls ${sibling}/cmd` })).toBeNull();
  });
});

describe('makeToolGuard from the main checkout', () => {
  const guard = () => makeToolGuard({ gitRoot: main, checkouts: listCheckouts(main) });

  it('refuses writes into a worktree nested inside it', () => {
    expect(guard()('Write', { file_path: path.join(nested, 'x.go') })).not.toBeNull();
    expect(guard()('Write', { file_path: path.join(main, 'x.go') })).toBeNull();
  });
});

describe('makeToolGuard without a git root', () => {
  it('allows everything, as before', () => {
    expect(makeToolGuard({ gitRoot: null })('Write', { file_path: '/anywhere' })).toBeNull();
  });
});

describe('extractAbsPaths', () => {
  it('skips URL paths and repo-relative paths', () => {
    expect(extractAbsPaths('curl https://h.io/a/b && cat /etc/hosts src/x')).toEqual(['/etc/hosts']);
  });
});
