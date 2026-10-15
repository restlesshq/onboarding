import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { makeToolGuard, extractAbsPaths, dependencyDirs, reachablePaths } from '../lib/tool-guard.js';
import { listCheckouts, owningCheckout } from '../lib/pathGuard.js';

// A main checkout, a sibling worktree (the reported setup: init run in the
// worktree, edits landed in main) and a worktree nested inside main.
let base, main, sibling, nested;
// A file that would be new in a real directory outside the project. Not under
// the temp dir, which Bash may use (and which holds the test repos on Linux).
const outsideFile = path.join(os.homedir(), 'restless-tool-guard-test.go');
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

describe('dependencyDirs', () => {
  // A project dir holding just the given manifests.
  const project = (...manifests) => {
    const dir = fs.mkdtempSync(path.join(base, 'proj-'));
    for (const m of manifests) fs.writeFileSync(path.join(dir, m), '');
    return dir;
  };
  const fakeRun = (outputs) => {
    const calls = [];
    const run = (cmd, args, cwd) => {
      calls.push({ cmd, cwd });
      if (!(cmd in outputs)) throw new Error(`${cmd}: not found`);
      return outputs[cmd];
    };
    return { run, calls };
  };

  it('asks only the toolchains whose manifest the project has, from the project', () => {
    const dir = project('go.mod');
    const { run, calls } = fakeRun({ go: '/gocache/mod\n/usr/local/go\n' });
    expect(dependencyDirs([dir], run)).toEqual(['/gocache/mod', '/usr/local/go']);
    expect(calls).toEqual([{ cmd: 'go', cwd: dir }]);
  });

  it('covers Python, Poetry, Pipenv, Ruby and npm', () => {
    const dir = project('pyproject.toml', 'poetry.lock', 'Pipfile.lock', 'Gemfile', 'package.json');
    const { run, calls } = fakeRun({
      python3: '/py/lib/python3.12\n/py/lib/python3.12/site-packages\n',
      poetry: '/cache/pypoetry/virtualenvs/app-x1\n',
      pipenv: '/venvs/app-y2\n',
      ruby: '/gems/3.3.0\n/ruby/lib/ruby/3.3.0\n',
      npm: '/node/lib/node_modules\n',
    });
    expect(new Set(dependencyDirs([dir], run))).toEqual(new Set([
      '/py/lib/python3.12', '/py/lib/python3.12/site-packages', '/cache/pypoetry/virtualenvs/app-x1',
      '/venvs/app-y2', '/gems/3.3.0', '/ruby/lib/ruby/3.3.0', '/node/lib/node_modules',
    ]));
    expect(calls.map((c) => c.cmd)).toEqual(['python3', 'poetry', 'pipenv', 'ruby', 'npm']);
  });

  it('finds a manifest in the run directory or the repository root', () => {
    const root = project('Gemfile');
    const sub = project();
    const { run, calls } = fakeRun({ ruby: '/gems\n' });
    expect(dependencyDirs([sub, root], run)).toEqual(['/gems']);
    expect(calls).toEqual([{ cmd: 'ruby', cwd: root }]);
  });

  it('skips a missing toolchain, and never exempts / or the home directory', () => {
    const dir = project('go.mod', 'package.json');
    const { run } = fakeRun({ go: `/\n${os.homedir()}\nrelative/dir\nwarning: something\n/ok\n` });
    expect(dependencyDirs([dir], run)).toEqual(['/ok']);
  });

  it('asks each toolchain once per project', () => {
    const dir = project('go.mod');
    const { run, calls } = fakeRun({ go: '/gocache\n' });
    dependencyDirs([dir], run);
    dependencyDirs([dir], run);
    expect(calls).toHaveLength(1);
  });
});

// Against the real toolchains on this machine, for whichever are installed.
describe('makeToolGuard and installed toolchains', () => {
  const has = (cmd) => {
    try {
      execFileSync('which', [cmd], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const cases = [
    ['go', 'go.mod'],
    ['python3', 'requirements.txt'],
    ['ruby', 'Gemfile'],
    ['npm', 'package.json'],
  ];

  for (const [cmd, manifest] of cases) {
    it.skipIf(!has(cmd))(`lets Bash read ${cmd}'s dependency dirs from a project with ${manifest}`, () => {
      const dir = fs.mkdtempSync(path.join(base, `${cmd}-`));
      fs.writeFileSync(path.join(dir, manifest), '');
      const dirs = dependencyDirs([dir]);
      expect(dirs.length).toBeGreaterThan(0);
      const guard = makeToolGuard({ gitRoot: dir });
      for (const d of dirs) {
        expect(guard('Bash', { command: `ls ${d}` })).toBeNull();
        expect(guard('Bash', { command: `cat ${path.join(d, 'x', 'README.md')}` })).toBeNull();
      }
      expect(guard('Bash', { command: `echo x >> ${outsideFile}` })).not.toBeNull();
    });
  }

  it('still refuses Bash naming other real paths outside the project', () => {
    const guard = makeToolGuard({ gitRoot: sibling, checkouts: listCheckouts(sibling) });
    expect(guard('Bash', { command: `echo x >> ${outsideFile}` })).not.toBeNull();
  });
});

describe('Bash paths that only look absolute, or only look relative', () => {
  const guard = () => makeToolGuard({ gitRoot: sibling, checkouts: listCheckouts(sibling) });
  // `/Users` on macOS, `/home` on Linux: a top-level dir an API route can echo.
  const top = os.homedir().split(path.sep)[1];
  const flipped = top === top.toUpperCase() ? top.toLowerCase() : top.toUpperCase();

  it('treats API routes as routes, even where a case-insensitive disk has that dir', () => {
    expect(guard()('Bash', { command: `grep -rn "/${flipped}/1" src` })).toBeNull();
    expect(guard()('Bash', { command: `curl -s localhost:8080/${top}/1 -d '{"next":"/${top}/2"}'` })).toBeNull();
    expect(guard()('Bash', { command: `sed -i 's|/${flipped}|/v1/${flipped}|' routes.go` })).toBeNull();
  });

  it('lets programs run by absolute path, including shebang lines', () => {
    expect(guard()('Bash', { command: '/usr/bin/env go build ./...' })).toBeNull();
    expect(guard()('Bash', { command: "cat > run.sh <<'X'\n#!/usr/bin/env bash\ngo run .\nX" })).toBeNull();
  });

  it('does not read `../..`, `./a`, `~/a` or `${HOME}/a` as absolute paths', () => {
    expect(extractAbsPaths('cd ../.. && cat ./a/b ~/c ${HOME}/d')).toEqual([]);
    expect(guard()('Bash', { command: 'cd cmd && go vet . && cd ..' })).toBeNull();
  });

  it('expands ~ and $HOME and resolves .. paths when looking for other checkouts', () => {
    const home = os.homedir();
    expect(reachablePaths('cat ~/code/app/x "$HOME"/y ${HOME}/z $HOME/w', '/work')).toEqual(
      expect.arrayContaining([`${home}/code/app/x`, `${home}/y`, `${home}/z`, `${home}/w`]),
    );
    expect(reachablePaths('cd a/b && cat ../../../c', '/work/repo')).toContain('/work/c');
  });

  it('refuses reaching another checkout through .. or cd, from a sibling or nested worktree', () => {
    expect(guard()('Bash', { command: 'cat ../main/cmd/main.go' }).owner).toBe(main);
    expect(guard()('Bash', { command: 'cd .. && cd main && go get x' }).owner).toBe(main);
    const fromNested = makeToolGuard({ gitRoot: nested, checkouts: listCheckouts(nested) });
    expect(fromNested('Bash', { command: 'cd ../../.. && go get x' }).owner).toBe(main);
    expect(fromNested('Bash', { command: 'sed -i s/a/b/ ../../../cmd/main.go' }).owner).toBe(main);
    expect(fromNested('Bash', { command: 'cd a/b && cat ../../go.mod' })).toBeNull();
  });

  it('refuses cd out of the project', () => {
    expect(guard()('Bash', { command: `cd ${os.homedir()} && ls` })).not.toBeNull();
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
