import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSpec, resolveOnPath } from '../lib/portable-exec.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable-exec-')));
}

describe('spawnSpec', () => {
  let bin;
  beforeEach(() => { bin = tmp(); });
  afterEach(() => { fs.rmSync(bin, { recursive: true, force: true }); });

  // Lowercase on purpose: Windows resolves extensions case-insensitively, so
  // the real PATHEXT is upper-case and the shims are lower-case. The test
  // host may be case-sensitive (Linux CI), so spell them the way the files are.
  const winEnv = (extra = {}) => ({
    PATH: bin,
    PATHEXT: '.com;.exe;.bat;.cmd',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    ...extra,
  });

  it('is a passthrough off Windows, whatever is on PATH', () => {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '');
    const spec = spawnSpec('codex', ['exec', '-C', '/tmp/a b'], { platform: 'linux', env: winEnv() });
    expect(spec).toEqual({ file: 'codex', args: ['exec', '-C', '/tmp/a b'], options: {} });
  });

  it('routes an npm .cmd shim through cmd.exe with the line quoted', () => {
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '');
    const cwd = 'C:\\Users\\Eric Smith\\proj';
    const spec = spawnSpec('codex', ['exec', '--json', '-C', cwd, '-'], { platform: 'win32', env: winEnv() });
    const shim = path.join(bin, 'codex.cmd');
    expect(spec.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(spec.args[3]).toBe(`"${shim} exec --json -C "${cwd}" -"`);
    expect(spec.options).toEqual({ windowsVerbatimArguments: true });
  });

  it('leaves a real executable alone so execFile keeps handling the arguments', () => {
    fs.writeFileSync(path.join(bin, 'go.exe'), '');
    const spec = spawnSpec('go', ['list', '-m', 'x'], { platform: 'win32', env: winEnv() });
    expect(spec).toEqual({ file: 'go', args: ['list', '-m', 'x'], options: {} });
  });

  it('leaves a command it cannot find alone, so the caller sees the real ENOENT', () => {
    const spec = spawnSpec('bundle', ['list'], { platform: 'win32', env: winEnv() });
    expect(spec).toEqual({ file: 'bundle', args: ['list'], options: {} });
  });

  it('falls back to cmd.exe when ComSpec is unset', () => {
    fs.writeFileSync(path.join(bin, 'gem.bat'), '');
    const spec = spawnSpec('gem', ['list', '-i', 'restless'], { platform: 'win32', env: winEnv({ ComSpec: undefined }) });
    expect(spec.file).toBe('cmd.exe');
  });
});

describe('resolveOnPath', () => {
  let bin;
  beforeEach(() => { bin = tmp(); });
  afterEach(() => { fs.rmSync(bin, { recursive: true, force: true }); });

  it('tries PATHEXT in order, like cmd.exe', () => {
    fs.writeFileSync(path.join(bin, 'npm.cmd'), '');
    fs.writeFileSync(path.join(bin, 'npm.exe'), '');
    expect(resolveOnPath('npm', { PATH: bin, PATHEXT: '.exe;.cmd' })).toBe(path.join(bin, 'npm.exe'));
    expect(resolveOnPath('npm', { PATH: bin, PATHEXT: '.cmd;.exe' })).toBe(path.join(bin, 'npm.cmd'));
  });

  it('does not second-guess an explicit extension or path', () => {
    fs.writeFileSync(path.join(bin, 'npm.cmd'), '');
    expect(resolveOnPath('npm.cmd', { PATH: bin })).toBeNull();
    expect(resolveOnPath(path.join(bin, 'npm'), { PATH: bin })).toBeNull();
  });
});
