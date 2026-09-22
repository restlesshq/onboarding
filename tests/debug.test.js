import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// debug.js holds a module-level singleton (the CLI is one-shot), so each
// test re-imports a fresh copy via resetModules to start from clean state.
async function freshDebug() {
  vi.resetModules();
  return import('../lib/debug.js');
}

let tmpDir;
let fetchSpy;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-debug-'));
  process.env.RESTLESS_DEBUG_DIR = tmpDir;
  // Default: a successful upload. Individual tests assert call count.
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  global.fetch = fetchSpy;
  // The uploader/finalize write status lines to stderr - silence them.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  delete process.env.RESTLESS_DEBUG_DIR;
  vi.restoreAllMocks();
});

function jsonFiles() {
  return fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
}

describe('finalize (always-write, conditional upload)', () => {
  it('writes a local copy on a normal run and does NOT upload', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    debug.log('hello', { foo: 'bar' });
    await debug.finalize({ exitCode: 0 });

    const files = jsonFiles();
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/-init\.json$/);
    expect(fetchSpy).not.toHaveBeenCalled();

    const body = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
    expect(body.entries.some((e) => e.type === 'hello' && e.foo === 'bar')).toBe(true);
    expect(body.meta.exitCode).toBe(0);
    expect(body.meta.finishedAt).toBeTruthy();
  });

  it('records events even without --debug (log is no longer gated)', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    debug.log('one');
    debug.log('two');
    await debug.finalize({ exitCode: 0 });

    const body = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFiles()[0]), 'utf8'));
    const types = body.entries.map((e) => e.type);
    expect(types).toContain('one');
    expect(types).toContain('two');
  });

  it('writes AND uploads when --debug is set', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init', '--debug'] });
    debug.log('hello');
    await debug.finalize({ exitCode: 0 });

    expect(jsonFiles().length).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/debug$/);
    expect(opts.method).toBe('POST');
  });

  it('is idempotent - a second finalize neither rewrites nor re-uploads', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init', '--debug'] });
    await debug.finalize({ exitCode: 0 });
    await debug.finalize({ exitCode: 0 });

    expect(jsonFiles().length).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('findLatestLocalLog', () => {
  it('returns null when no logs exist', async () => {
    const debug = await freshDebug();
    expect(debug.findLatestLocalLog()).toBe(null);
  });

  it('returns the newest log, skipping submit-debug logs', async () => {
    const debug = await freshDebug();
    const stub = '{"meta":{},"entries":[]}';
    fs.writeFileSync(path.join(tmpDir, '2026-01-01T00-00-00-000Z-init.json'), stub);
    fs.writeFileSync(path.join(tmpDir, '2026-01-02T00-00-00-000Z-update.json'), stub);
    // Newest by timestamp, but it's a submit-debug run and must be ignored.
    fs.writeFileSync(path.join(tmpDir, '2026-01-03T00-00-00-000Z-submit-debug.json'), stub);

    const latest = debug.findLatestLocalLog();
    expect(path.basename(latest)).toBe('2026-01-02T00-00-00-000Z-update.json');
  });

  it('skips the timings command\'s own logs', async () => {
    // `restless timings` writes a log of itself, which would always be the
    // newest on disk - so a bare `restless timings` would profile the
    // reader instead of the run being asked about.
    const debug = await freshDebug();
    const stub = '{"meta":{},"entries":[]}';
    fs.writeFileSync(path.join(tmpDir, '2026-01-01T00-00-00-000Z-init.json'), stub);
    fs.writeFileSync(path.join(tmpDir, '2026-01-04T00-00-00-000Z-timings.json'), stub);

    expect(path.basename(debug.findLatestLocalLog())).toBe('2026-01-01T00-00-00-000Z-init.json');
  });
});

describe('listLocalLogs', () => {
  it('lists newest first with the command parsed out of the filename', async () => {
    const debug = await freshDebug();
    const stub = '{"meta":{},"entries":[]}';
    fs.writeFileSync(path.join(tmpDir, '2026-01-01T00-00-00-000Z-init.json'), stub);
    fs.writeFileSync(path.join(tmpDir, '2026-01-02T00-00-00-000Z-update.json'), stub);

    expect(debug.listLocalLogs().map((l) => l.command)).toEqual(['update', 'init']);
  });

  it('honors the limit', async () => {
    const debug = await freshDebug();
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `2026-01-0${i}T00-00-00-000Z-init.json`), '{}');
    }
    expect(debug.listLocalLogs({ limit: 2 })).toHaveLength(2);
  });

  it('returns an empty list rather than throwing when the dir is missing', async () => {
    const debug = await freshDebug();
    process.env.RESTLESS_DEBUG_DIR = path.join(tmpDir, 'does-not-exist');
    expect(debug.listLocalLogs()).toEqual([]);
  });
});

describe('snapshot', () => {
  it('returns the log as it stands, in the on-disk shape', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    debug.log('mid-run', { n: 1 });

    const snap = debug.snapshot();
    expect(snap.meta.command).toBe('init');
    expect(snap.entries.map((e) => e.type)).toContain('mid-run');
  });

  it('hands back a copy, so a caller sorting it cannot reorder the log', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    debug.log('first');
    debug.log('second');

    debug.snapshot().entries.reverse();
    expect(debug.snapshot().entries.map((e) => e.type)).toEqual(['init', 'first', 'second']);
  });
});

describe('addFinalizeHook', () => {
  it('runs hooks before the body is written, so their entries land in it', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    debug.addFinalizeHook(() => debug.log('from-hook', { late: true }));
    await debug.finalize({ exitCode: 0 });

    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFiles()[0]), 'utf8'));
    expect(written.entries.map((e) => e.type)).toContain('from-hook');
  });

  it('makes a second finalize wait for the first, so an exit cannot cut off the local copy', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    let release;
    debug.addFinalizeHook(() => new Promise((r) => { release = r; }));

    const first = debug.finalize({ exitCode: 1 });
    let secondDone = false;
    const second = debug.finalize({ exitCode: 1 }).then(() => { secondDone = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(secondDone).toBe(false);

    release();
    await Promise.all([first, second]);
    expect(jsonFiles().length).toBe(1);
  });

  it('swallows a throwing hook rather than failing the exit', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    debug.addFinalizeHook(() => { throw new Error('hook exploded'); });
    debug.addFinalizeHook(() => debug.log('still-ran'));

    await expect(debug.finalize({ exitCode: 0 })).resolves.toBeUndefined();
    const written = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFiles()[0]), 'utf8'));
    expect(written.entries.map((e) => e.type)).toContain('still-ran');
  });
});

describe('abortExit', () => {
  it('marks the run interrupted before exiting', async () => {
    const debug = await freshDebug();
    debug.init({ argv: ['node', 'api', 'init'] });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {});
    expect(debug.wasInterrupted()).toBe(false);
    await debug.abortExit(130);
    expect(debug.wasInterrupted()).toBe(true);
    expect(exit).toHaveBeenCalledWith(130);
  });
});

describe('submitLocalLog', () => {
  it('reads the file and POSTs its contents verbatim', async () => {
    const debug = await freshDebug();
    const file = path.join(tmpDir, '2026-01-01T00-00-00-000Z-init.json');
    const contents = '{"meta":{"cli":"api"},"entries":[{"type":"x"}]}';
    fs.writeFileSync(file, contents);

    const res = await debug.submitLocalLog(file);
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1].body).toBe(contents);
  });

  it('returns not-ok and does not POST when the file is missing', async () => {
    const debug = await freshDebug();
    const res = await debug.submitLocalLog(path.join(tmpDir, 'nope.json'));
    expect(res.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a server failure as not-ok', async () => {
    const debug = await freshDebug();
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const file = path.join(tmpDir, 'log.json');
    fs.writeFileSync(file, '{"meta":{},"entries":[]}');

    const res = await debug.submitLocalLog(file);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });
});
