import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * `lib/telemetry.js` resolves its mode once at `init`, and `lib/config.js`
 * computes `IS_LINKED_INSTALL` at import time - so every case re-imports the
 * module with the environment it wants to assert about, the same pattern
 * `tests/env.test.js` uses for `detectAgent`.
 *
 * `RESTLESS_CONFIG_DIR` keeps all of this out of the real `~/.restless`.
 */
async function fresh(env = {}, { argv = ['node', 'restless', 'init'] } = {}) {
  vi.resetModules();
  const saved = { ...process.env };
  const savedArgv = process.argv;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-telemetry-'));

  for (const k of [
    'RESTLESS_TELEMETRY_DEBUG', 'RESTLESS_TELEMETRY_DISABLED', 'RESTLESS_TELEMETRY_FORCE',
    'DO_NOT_TRACK', 'RESTLESS_LINKED', 'CI', 'CLAUDECODE', 'CLAUDE_CODE',
    'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'RESTLESS_AGENT',
  ]) delete process.env[k];

  process.env.RESTLESS_CONFIG_DIR = dir;
  // A published install by default; a linked checkout is its own case.
  process.env.RESTLESS_LINKED = '0';
  Object.assign(process.env, env);
  process.argv = argv;

  const telemetry = await import('../lib/telemetry.js');
  const userConfig = await import('../lib/user-config.js');
  return {
    telemetry,
    userConfig,
    dir,
    restore: () => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
      process.argv = savedArgv;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

let restore;
afterEach(() => { if (restore) restore(); restore = null; vi.unstubAllGlobals(); });

describe('opt-out precedence', () => {
  it('debug mode collects but never sends, and outranks the opt-outs', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_DEBUG: '1', RESTLESS_TELEMETRY_DISABLED: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    expect(t.telemetry.isEnabled()).toBe(true);
    expect(t.telemetry.isSending()).toBe(false);
    expect(t.telemetry.describeStatus().reason).toBe('debug-mode');
  });

  it('RESTLESS_TELEMETRY_DISABLED turns it off for the run', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_DISABLED: '1', RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    expect(t.telemetry.isEnabled()).toBe(false);
    expect(t.telemetry.describeStatus().reason).toBe('env-disabled');
  });

  it('honors DO_NOT_TRACK', async () => {
    const t = await fresh({ DO_NOT_TRACK: '1', RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    expect(t.telemetry.isEnabled()).toBe(false);
    expect(t.telemetry.describeStatus().reason).toBe('do-not-track');
  });

  it('a stored opt-out beats the force flag', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.userConfig.updateConfig({ telemetry: { enabled: false } });
    t.telemetry.init({ argv: process.argv });
    expect(t.telemetry.isEnabled()).toBe(false);
    expect(t.telemetry.describeStatus().reason).toBe('opted-out');
  });

  it('is off in a linked checkout, and the force flag overrides that', async () => {
    const linked = await fresh({ RESTLESS_LINKED: '1' });
    restore = linked.restore;
    linked.telemetry.init({ argv: process.argv });
    expect(linked.telemetry.isEnabled()).toBe(false);
    expect(linked.telemetry.describeStatus().reason).toBe('linked-install');
    restore(); restore = null;

    const forced = await fresh({ RESTLESS_LINKED: '1', RESTLESS_TELEMETRY_FORCE: '1' });
    restore = forced.restore;
    forced.telemetry.init({ argv: process.argv });
    expect(forced.telemetry.isSending()).toBe(true);
  });

  it('is off by default while the rollout gate is closed', async () => {
    const t = await fresh();
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    expect(t.telemetry.isEnabled()).toBe(false);
    expect(t.telemetry.describeStatus().reason).toBe('not-yet-enabled');
  });
});

describe('the payload carries only allowlisted values', () => {
  it('reduces an unrecognized command to `unknown` and never keeps argv', async () => {
    const t = await fresh(
      { RESTLESS_TELEMETRY_FORCE: '1' },
      { argv: ['node', 'restless', '/Users/marc/secret-repo'] },
    );
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    const payload = t.telemetry.buildPayload({});
    expect(payload.command).toBe('unknown');
    expect(JSON.stringify(payload)).not.toContain('secret-repo');
  });

  it('keeps allowlisted flag names and drops their values and unlisted flags', async () => {
    const t = await fresh(
      { RESTLESS_TELEMETRY_FORCE: '1' },
      { argv: ['node', 'restless', 'init', '--dir', '/Users/marc/private/api', '--yes', '--oas=/tmp/spec.json'] },
    );
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    const payload = t.telemetry.buildPayload({});
    expect(payload.flags).toEqual(['--dir', '--oas']);
    // The values are the whole point: assert on the serialized form, so a
    // future field that happens to carry one still fails this.
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('/Users/marc');
    expect(wire).not.toContain('spec.json');
    expect(wire).not.toContain('--yes');
  });

  it('maps unknown detection values to `other` rather than passing them through', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    t.telemetry.recordDetect({
      language: 'Node.js',
      framework: 'some-internal-framework',
      oasSourceKind: 'made-up',
    });
    const payload = t.telemetry.buildPayload({});
    expect(payload.language).toBe('javascript');
    expect(payload.framework).toBe('other');
    expect(payload.oasSourceKind).toBe('other');
    expect(JSON.stringify(payload)).not.toContain('some-internal-framework');
  });

  it('reduces an error to a code, never a message or a stack', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    t.telemetry.recordError('ECONNREFUSED connecting to https://internal.acme.test/api', 1);
    const payload = t.telemetry.buildPayload({ outcome: 'error' });
    expect(payload.errorCode).toBe('unknown');
    expect(payload.errorStep).toBe('install_sdk');
    expect(JSON.stringify(payload)).not.toContain('internal.acme.test');
  });

  it('keeps only the closed set of timing kinds', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    const payload = t.telemetry.buildPayload({
      summary: {
        kinds: [
          { kind: 'ai', ms: 100 },
          { kind: 'step', ms: 50 },
          { kind: '/Users/marc/thing', ms: 5 },
        ],
      },
    });
    expect(payload.byKind).toEqual({ ai: 100 });
  });
});

describe('steps', () => {
  it('reports the three middle steps and drops the account step', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    t.telemetry.recordStep(0, 'done', 21044);
    t.telemetry.recordStep(1, 'failed', 8020);
    t.telemetry.recordStep(3, 'done', 900); // "Set up account" - not reported
    const payload = t.telemetry.buildPayload({});
    expect(payload.steps).toEqual([
      { step: 'generate_oas', status: 'done', durationMs: 21044 },
      { step: 'install_sdk', status: 'failed', durationMs: 8020 },
    ]);
  });

  it('collapses a re-asserted step instead of double-counting it', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    t.telemetry.recordStep(1, 'started', 0);
    t.telemetry.recordStep(1, 'done', 5000);
    const payload = t.telemetry.buildPayload({});
    expect(payload.steps).toEqual([{ step: 'install_sdk', status: 'done', durationMs: 5000 }]);
  });

  it('is structurally bounded at three entries', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    for (let i = 0; i < 10; i++) t.telemetry.recordStep(i % 4, 'done', 10);
    expect(t.telemetry.buildPayload({}).steps.length).toBeLessThanOrEqual(3);
  });
});

describe('flush', () => {
  it('makes no request at all when disabled', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_DISABLED: '1' });
    restore = t.restore;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    t.telemetry.init({ argv: process.argv });
    t.telemetry.recordStep(0, 'done', 10);
    await t.telemetry.flush({ exitCode: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prints to stderr and sends nothing in debug mode', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_DEBUG: '1' });
    restore = t.restore;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const writes = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((s) => { writes.push(s); return true; });
    t.telemetry.init({ argv: process.argv });
    await t.telemetry.flush({ exitCode: 0 });
    spy.mockRestore();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writes.join('')).toContain('[telemetry]');
  });

  it('posts once when enabled, and is idempotent', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal('fetch', fetchMock);
    t.telemetry.init({ argv: process.argv });
    await t.telemetry.flush({ exitCode: 0 });
    await t.telemetry.flush({ exitCode: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/telemetry$/);
    expect(opts.method).toBe('POST');
  });

  it('swallows a rejecting, a hanging, and a 500 fetch alike', async () => {
    for (const impl of [
      () => Promise.reject(new Error('ENOTFOUND')),
      () => new Promise(() => {}),
      () => Promise.resolve({ ok: false, status: 500 }),
    ]) {
      const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
      vi.stubGlobal('fetch', vi.fn(impl));
      t.telemetry.init({ argv: process.argv });
      // The hanging case resolves because AbortSignal.timeout fires; all
      // three must simply not throw into the caller.
      await expect(t.telemetry.flush({ exitCode: 0 })).resolves.toBeUndefined();
      t.restore();
    }
  });
});

describe('the telemetry setting', () => {
  it('round-trips through the config file and drops the current run on opt-out', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    t.telemetry.recordStep(0, 'done', 10);
    expect(t.telemetry.isSending()).toBe(true);

    expect(t.telemetry.setStatus(false)).toBe(true);
    expect(t.telemetry.isEnabled()).toBe(false);
    expect(t.telemetry.buildPayload({}).steps).toEqual([]);
    expect(t.userConfig.loadConfig().telemetry.enabled).toBe(false);

    expect(t.telemetry.setStatus(true)).toBe(true);
    expect(t.userConfig.loadConfig().telemetry.enabled).toBe(true);
  });

  it('shows the first-run notice once', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    expect(t.telemetry.needsNotice()).toBe(true);
    t.telemetry.markNoticeShown();
    expect(t.telemetry.needsNotice()).toBe(false);
  });

  it('status does not mint an id on a machine that has sent nothing', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_DISABLED: '1' });
    restore = t.restore;
    t.telemetry.init({ argv: process.argv });
    expect(t.telemetry.describeStatus().anonymousId).toBe(null);
  });
});

describe('the anonymous id', () => {
  it('is stable across runs and is not derived from the machine', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    const first = t.userConfig.anonymousId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(t.userConfig.anonymousId()).toBe(first);
    for (const leak of [os.hostname(), os.userInfo().username, process.cwd()]) {
      if (leak) expect(first).not.toContain(leak);
    }
  });

  it('survives a corrupt config file rather than throwing', async () => {
    const t = await fresh({ RESTLESS_TELEMETRY_FORCE: '1' });
    restore = t.restore;
    fs.writeFileSync(path.join(t.dir, 'config.json'), '{ not json');
    expect(t.userConfig.loadConfig()).toEqual({ version: 1, telemetry: {} });
    expect(() => t.userConfig.anonymousId()).not.toThrow();
  });

  it('keeps other sections when one is patched', async () => {
    const t = await fresh();
    restore = t.restore;
    t.userConfig.updateConfig({ telemetry: { anonymousId: 'abc' } });
    t.userConfig.updateConfig({ telemetry: { enabled: false } });
    const cfg = t.userConfig.loadConfig();
    expect(cfg.telemetry).toEqual({ anonymousId: 'abc', enabled: false });
  });
});
