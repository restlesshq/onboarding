import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setGitRoot } from '../lib/pathGuard.js';
import { saveSettings } from '../lib/settings.js';
import * as mod from '../lib/project-init.js';

let tmp;
let home;
let realHome;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-proj-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-home-'));
  // Credentials land under the user's home dir, and `credsPath` resolves
  // `os.homedir()` (which honors $HOME on POSIX) per call - so pointing HOME
  // at a temp dir keeps the suite away from the real ~/.restless.
  realHome = process.env.HOME;
  process.env.HOME = home;
  setGitRoot(tmp);
});

afterEach(() => {
  process.env.HOME = realHome;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function settingsWith(api) {
  saveSettings(tmp, { version: 1, apis: [api] });
}

/** A fetch that hands back a new project id every call, like the real one. */
function mintingFetch() {
  let n = 0;
  return vi.fn(async () => ({
    ok: true,
    status: 201,
    json: async () => ({ project_id: `project-${++n}`, setup_key: `setup-${n}` }),
  }));
}

/**
 * The setup-provenance defaults read how this run was driven, and
 * `detectAgent()` caches on first call - so a case that asserts about them
 * re-imports the module with the environment it means to test. Two things
 * have to be pinned, not just the env vars: without the clean slate every
 * default would read 'agent' when the suite is run from inside a coding
 * agent, and without `tty` every default would read 'agent' regardless,
 * because vitest runs us with both streams piped.
 */
async function freshProjectInit(env = {}, { tty = true } = {}) {
  vi.resetModules();
  const saved = { ...process.env };
  const savedTty = { out: process.stdout.isTTY, in: process.stdin.isTTY };
  // Same slate `freshEnv` in env.test.js clears, and it has to stay the same
  // slate. CI is the one that actually bit us: GitHub Actions sets CI=true,
  // `isPipedRun()` refuses to call a CI job agent-driven, and so the piped
  // cases below passed locally and failed only on a runner.
  for (const k of [
    'CLAUDECODE',
    'CLAUDE_CODE',
    'CODEX_SANDBOX',
    'CODEX_SANDBOX_NETWORK_DISABLED',
    'RESTLESS_AGENT',
    'CI',
    'RESTLESS_INTERACTIVE',
    'RESTLESS_NONINTERACTIVE',
  ]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  process.stdout.isTTY = tty;
  process.stdin.isTTY = tty;
  // resetModules gives the fresh graph its own pathGuard too, so the write
  // boundary the outer beforeEach configured has to be re-declared or every
  // settings write throws EROOTUNSET.
  const { setGitRoot: setFreshGitRoot } = await import('../lib/pathGuard.js');
  setFreshGitRoot(tmp);
  const fresh = await import('../lib/project-init.js');
  return {
    mod: fresh,
    restore: () => {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
      process.stdout.isTTY = savedTty.out;
      process.stdin.isTTY = savedTty.in;
    },
  };
}

describe('registerProject', () => {
  let restoreEnv;
  afterEach(() => { if (restoreEnv) restoreEnv(); restoreEnv = null; });

  it('sends only the hash, never the key', async () => {
    const { mod: fresh, restore } = await freshProjectInit(); restoreEnv = restore;
    const fetchImpl = mintingFetch();
    await fresh.registerProject({ writeKeyHash: 'abc123', fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.write_key_hash).toBe('abc123');
    expect(Object.keys(body).sort()).toEqual(['setup_source', 'write_key_hash']);
  });

  it('records the agent the caller picked, over anything in the environment', async () => {
    const { mod: fresh, restore } = await freshProjectInit({ CLAUDECODE: '1' }); restoreEnv = restore;
    const fetchImpl = mintingFetch();
    await fresh.registerProject({ writeKeyHash: 'h', agent: 'codex', fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      setup_source: 'agent',
      setup_agent: 'codex',
    });
  });

  it('falls back to the agent driving the run when the caller picked none', async () => {
    const { mod: fresh, restore } = await freshProjectInit({ CLAUDECODE: '1' }); restoreEnv = restore;
    const fetchImpl = mintingFetch();
    await fresh.registerProject({ writeKeyHash: 'h', fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      setup_source: 'agent',
      setup_agent: 'claude',
    });
  });

  it('reports a plain terminal run as cli with no agent', async () => {
    const { mod: fresh, restore } = await freshProjectInit(); restoreEnv = restore;
    const fetchImpl = mintingFetch();
    await fresh.registerProject({ writeKeyHash: 'h', fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.setup_source).toBe('cli');
    expect(body).not.toHaveProperty('setup_agent');
  });

  it('reports an unidentifiable agent as agent-driven with no name', async () => {
    // A piped run from an agent whose markers we don't know. 'cli' would be
    // the one answer that is definitely wrong.
    const { mod: fresh, restore } = await freshProjectInit({}, { tty: false });
    restoreEnv = restore;
    const fetchImpl = mintingFetch();
    await fresh.registerProject({ writeKeyHash: 'h', fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.setup_source).toBe('agent');
    expect(body).not.toHaveProperty('setup_agent');
  });

  it('reports a self-named agent under its own name', async () => {
    const { mod: fresh, restore } = await freshProjectInit(
      { RESTLESS_AGENT: 'cursor' },
      { tty: false },
    );
    restoreEnv = restore;
    const fetchImpl = mintingFetch();
    await fresh.registerProject({ writeKeyHash: 'h', fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      setup_source: 'agent',
      setup_agent: 'cursor',
    });
  });

  it('carries the picked agent through ensureProject to the registration', async () => {
    const { mod: fresh, restore } = await freshProjectInit(); restoreEnv = restore;
    const fetchImpl = mintingFetch();
    await fresh.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_k', agent: 'claude', fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
      setup_source: 'cli',
      setup_agent: 'claude',
    });
  });

  it('retries once on a 5xx (the metrics service cold-starts)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => 'bad gateway' })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ project_id: 'p', setup_key: 's' }) });
    const res = await mod.registerProject({ writeKeyHash: 'h', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ projectId: 'p', setupKey: 's' });
  });

  it('throws with the server body on a non-retryable failure', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, text: async () => 'nope' }));
    await expect(mod.registerProject({ writeKeyHash: 'h', fetchImpl })).rejects.toThrow(/HTTP 400.*nope/s);
  });
});

describe('project credentials', () => {
  it('round-trips the setup key so a later process can still claim the project', () => {
    mod.saveProjectCreds({ projectId: 'p1', setupKey: 's1', apiKey: 'rstlss_k' });
    expect(mod.loadProjectCreds('p1')).toMatchObject({ projectId: 'p1', setupKey: 's1' });
  });

  it('persists only a hash of the write key, never the plaintext', () => {
    const file = mod.saveProjectCreds({ projectId: 'p1', setupKey: 's1', apiKey: 'rstlss_secret' });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('rstlss_secret');
    expect(mod.loadProjectCreds('p1').apiKeyHash).toBe(mod.hashWriteKey('rstlss_secret'));
  });

  it('scrubs legacy plaintext keys on the next save', () => {
    const file = mod.credsPath('p-legacy');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projectId: 'p-legacy', setupKey: 's', apiKey: 'rstlss_old' }));
    mod.saveProjectCreds({ projectId: 'p-legacy', setupKey: 's2', apiKey: 'rstlss_old' });
    expect(fs.readFileSync(file, 'utf8')).not.toContain('rstlss_old');
  });

  it('keeps credentials out of the repo and readable only by the user', () => {
    const file = mod.saveProjectCreds({ projectId: 'p1', setupKey: 's1', apiKey: 'k' });
    expect(file.startsWith(tmp)).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('returns null for a project we have never seen', () => {
    expect(mod.loadProjectCreds('nope')).toBeNull();
  });
});

describe('ensureProject', () => {
  // The regression this exists for: /api/projects/init is not idempotent, so
  // re-registering an unchanged key mints a second project and orphans the
  // first - the server keeps logging to the old one while the CLI verifies
  // the new, empty one and blames the user's key.
  it('reuses the existing project when the key has not changed', async () => {
    const fetchImpl = mintingFetch();
    settingsWith({ id: 'a', name: 'API', rootDir: '.' });

    const first = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_same', fetchImpl });
    expect(first).toMatchObject({ projectId: 'project-1', reused: false });

    for (const _ of [1, 2, 3]) {
      const again = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_same', fetchImpl });
      expect(again).toMatchObject({ projectId: 'project-1', setupKey: 'setup-1', reused: true });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('mints a new project when the key changes', async () => {
    const fetchImpl = mintingFetch();
    settingsWith({ id: 'a', name: 'API', rootDir: '.' });
    await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_one', fetchImpl });
    const second = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_two', fetchImpl });
    expect(second).toMatchObject({ projectId: 'project-2', reused: false });
  });

  it('mints when settings names a project we hold no setup key for', async () => {
    const fetchImpl = mintingFetch();
    settingsWith({ id: 'a', name: 'API', rootDir: '.', projectId: 'from-a-different-machine' });
    const res = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_k', fetchImpl });
    expect(res).toMatchObject({ projectId: 'project-1', reused: false });
  });

  // Jesse's report: `key` before `register` on a fresh repo registered a
  // project server-side and then wrote nothing, so `register` created the
  // entry without a projectId and `login` said "This project has no Restless
  // project yet - run npx restless key first" about the command that had
  // just run. Both orders have to work: the agent playbook registers first,
  // the README's command table lists `key` first.
  it('creates the API entry when key runs before anything described the API', async () => {
    const fetchImpl = mintingFetch();
    const res = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_k', fetchImpl });
    expect(res).toMatchObject({ projectId: 'project-1' });

    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
    expect(saved.apis).toHaveLength(1);
    expect(saved.apis[0].projectId).toBe('project-1');
    // Every field the schema requires, so `register` merges onto a valid entry.
    expect(saved.apis[0].id).toEqual(expect.any(String));
    expect(saved.apis[0].name).toEqual(expect.any(String));
    expect(saved.apis[0].rootDir).toBe('.');
  });

  it('honours --dir when key runs first in a repo with no entries', async () => {
    const fetchImpl = mintingFetch();
    await mod.ensureProject({ rootDir: tmp, apiRootDir: 'services/api', apiKey: 'rstlss_k', fetchImpl });
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
    expect(saved.apis).toHaveLength(1);
    expect(saved.apis[0]).toMatchObject({ rootDir: 'services/api', projectId: 'project-1' });
  });

  // Falling back to apis[0] here would stamp the new project over svc-a's,
  // orphaning it - the same silent loss the stub creation above exists to stop.
  it('never stamps the project onto an API the requested dir does not name', async () => {
    const fetchImpl = mintingFetch();
    saveSettings(tmp, { version: 1, apis: [
      { id: 'a', name: 'One', rootDir: 'svc-a', projectId: 'proj-A' },
    ]});
    await mod.ensureProject({ rootDir: tmp, apiRootDir: 'svc-b', apiKey: 'rstlss_k', fetchImpl });

    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
    expect(saved.apis.find((a) => a.rootDir === 'svc-a').projectId).toBe('proj-A');
    expect(saved.apis.find((a) => a.rootDir === 'svc-b').projectId).toBe('project-1');
  });

  it('writes to the existing entry when --dir spells its directory differently', async () => {
    const fetchImpl = mintingFetch();
    saveSettings(tmp, { version: 1, apis: [{ id: 'a', name: 'One', rootDir: 'api' }] });
    await mod.ensureProject({ rootDir: tmp, apiRootDir: 'api/', apiKey: 'rstlss_k', fetchImpl });

    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
    expect(saved.apis).toHaveLength(1);
    expect(saved.apis[0]).toMatchObject({ id: 'a', rootDir: 'api', projectId: 'project-1' });
  });

  it('records the project id on the API entry that owns it', async () => {
    const fetchImpl = mintingFetch();
    saveSettings(tmp, { version: 1, apis: [
      { id: 'a', name: 'One', rootDir: 'svc-a' },
      { id: 'b', name: 'Two', rootDir: 'svc-b' },
    ]});
    await mod.ensureProject({ rootDir: tmp, apiRootDir: 'svc-b', apiKey: 'rstlss_k', fetchImpl });
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
    expect(saved.apis.find((a) => a.rootDir === 'svc-b').projectId).toBe('project-1');
    expect(saved.apis.find((a) => a.rootDir === 'svc-a').projectId).toBeUndefined();
  });
});

describe('pollForLandedLog', () => {
  const okResponse = (logs) => ({ ok: true, json: async () => ({ logs }) });

  it('returns true as soon as a log lands', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([{ id: 'log-1' }]));
    const landed = await mod.pollForLandedLog({
      projectId: 'p', setupKey: 's', since: 'now', fetchImpl, sleep: async () => {},
    });
    expect(landed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ projectId: 'p', setupKey: 's', since: 'now' });
  });

  it('keeps polling past empty responses, then reports the landing', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(okResponse([]))
      .mockResolvedValueOnce(okResponse([{ id: 'log-1' }]));
    const landed = await mod.pollForLandedLog({
      projectId: 'p', setupKey: 's', since: 'now', timeoutMs: 10000, fetchImpl, sleep: async () => {},
    });
    expect(landed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns false when nothing lands before the deadline', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse([]));
    const landed = await mod.pollForLandedLog({
      projectId: 'p', setupKey: 's', since: 'now', timeoutMs: 0, fetchImpl, sleep: async () => {},
    });
    expect(landed).toBe(false);
  });

  it('treats network errors as not-landed-yet rather than throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    const landed = await mod.pollForLandedLog({
      projectId: 'p', setupKey: 's', since: 'now', timeoutMs: 0, fetchImpl, sleep: async () => {},
    });
    expect(landed).toBe(false);
  });
});

describe('findCredsByApiKey / key recovery', () => {
  it('finds the creds this machine saved for a key', () => {
    mod.saveProjectCreds({ projectId: 'p-1', setupKey: 's-1', apiKey: 'rstlss_a' });
    expect(mod.findCredsByApiKey('rstlss_a')).toMatchObject({ projectId: 'p-1', setupKey: 's-1' });
    expect(mod.findCredsByApiKey('rstlss_other')).toBe(null);
    expect(mod.findCredsByApiKey(null)).toBe(null);
  });

  it('prefers the OLDEST registration when one key maps to several projects', () => {
    // The duplicate mapping is exactly the orphan bug: ingress routes the
    // key's uploads to the first project registered for it.
    const dir = path.join(home, '.restless', 'projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'p-old.json'), JSON.stringify({
      projectId: 'p-old', setupKey: 's-old', apiKey: 'rstlss_dup', savedAt: '2026-07-25T00:00:00.000Z',
    }));
    fs.writeFileSync(path.join(dir, 'p-new.json'), JSON.stringify({
      projectId: 'p-new', setupKey: 's-new', apiKey: 'rstlss_dup', savedAt: '2026-07-26T00:00:00.000Z',
    }));
    expect(mod.findCredsByApiKey('rstlss_dup')).toMatchObject({ projectId: 'p-old' });
  });

  it('ensureProject adopts local creds when settings has no projectId', async () => {
    // The Greg scenario: key on disk from an earlier run, fresh settings.
    mod.saveProjectCreds({ projectId: 'p-orig', setupKey: 's-orig', apiKey: 'rstlss_k' });
    saveSettings(tmp, { version: 1, apis: [{ id: 'a', name: 'One', rootDir: '.' }] });

    const fetchImpl = vi.fn(); // must never be called - recovery is local
    const res = await mod.ensureProject({ rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_k', fetchImpl });
    expect(res).toMatchObject({ projectId: 'p-orig', setupKey: 's-orig', reused: true, recovered: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.restless', 'settings.json'), 'utf8'));
    expect(saved.apis[0].projectId).toBe('p-orig');
  });

  it('ensureProject returns null for an unknown key when registerUnknown is false', async () => {
    saveSettings(tmp, { version: 1, apis: [{ id: 'a', name: 'One', rootDir: '.' }] });
    const fetchImpl = vi.fn();
    const res = await mod.ensureProject({
      rootDir: tmp, apiRootDir: '.', apiKey: 'rstlss_mystery', registerUnknown: false, fetchImpl,
    });
    expect(res).toBe(null);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('uploadPendingArtifacts', () => {
  const OAS = JSON.stringify({ openapi: '3.0.3', paths: { '/pets': { get: {}, post: {} } } });

  function writeProject() {
    fs.mkdirSync(path.join(tmp, '.restless'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.restless', 'openapi.json'), OAS);
    saveSettings(tmp, { version: 1, apis: [
      { id: 'a', name: 'Pets', rootDir: '.', oasFile: '.restless/openapi.json', projectId: 'p-1' },
    ]});
  }

  it('uploads the OAS and settings for the claiming project', async () => {
    writeProject();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const res = await mod.uploadPendingArtifacts({ rootDir: tmp, projectId: 'p-1', setupKey: 's-1', fetchImpl });
    expect(res).toMatchObject({ oas: 'uploaded', settings: 'uploaded', endpoints: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [oasUrl, oasInit] = fetchImpl.mock.calls[0];
    expect(oasUrl).toContain('/api/projects/p-1/oas');
    expect(JSON.parse(oasInit.body)).toMatchObject({ setup_key: 's-1', format: 'json' });
    expect(fetchImpl.mock.calls[1][0]).toContain('/api/projects/p-1/settings');
  });

  it('reports a failed OAS upload without throwing, and still sends settings', async () => {
    writeProject();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({ ok: true });
    const res = await mod.uploadPendingArtifacts({ rootDir: tmp, projectId: 'p-1', setupKey: 's-1', fetchImpl });
    expect(res.oas).toBe('failed');
    expect(res.error).toContain('HTTP 500');
    expect(res.settings).toBe('uploaded');
  });

  it("quotes the server's reason, so an oversized spec reads as one", async () => {
    // "HTTP 413" alone sent people looking for a network fault. The body is
    // the only part that says what to do about it.
    writeProject();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        text: async () =>
          '{"error":"oas_raw is 3091773 bytes, over the 8388608 byte limit"}',
      })
      .mockResolvedValueOnce({ ok: true });
    const res = await mod.uploadPendingArtifacts({ rootDir: tmp, projectId: 'p-1', setupKey: 's-1', fetchImpl });
    expect(res.oas).toBe('failed');
    expect(res.error).toContain('HTTP 413');
    expect(res.error).toContain('over the 8388608 byte limit');
  });

  it('reports none when there is no spec on disk', async () => {
    saveSettings(tmp, { version: 1, apis: [{ id: 'a', name: 'Pets', rootDir: '.', projectId: 'p-1' }] });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const res = await mod.uploadPendingArtifacts({ rootDir: tmp, projectId: 'p-1', setupKey: 's-1', fetchImpl });
    expect(res.oas).toBe('none');
    expect(res.settings).toBe('uploaded');
  });

  // A claimed project has no pending slot to stage into: the server refuses,
  // and the setup key on disk is spent because claiming deletes the server's
  // copy. That is a different outcome from a failure, and callers branch on
  // it - `setup-account` skips the whole claim ceremony rather than minting a
  // login token for a project that already has an owner.
  it('reports claimed on a 409, not failed', async () => {
    writeProject();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => 'already claimed' })
      .mockResolvedValueOnce({ ok: true });
    const res = await mod.uploadPendingArtifacts({ rootDir: tmp, projectId: 'p-1', setupKey: 's-1', fetchImpl });
    expect(res.oas).toBe('claimed');
    expect(res.error).toBeUndefined();
  });

  it('reports claimed on a 401 - the same state seen from the credential side', async () => {
    writeProject();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' })
      .mockResolvedValueOnce({ ok: true });
    const res = await mod.uploadPendingArtifacts({ rootDir: tmp, projectId: 'p-1', setupKey: 's-1', fetchImpl });
    expect(res.oas).toBe('claimed');
    expect(res.error).toBeUndefined();
  });

  it('still reports the endpoint count when the upload was refused', async () => {
    // The recap line ("mapped N endpoints") is true regardless of whether
    // staging was the right operation to attempt, so the count is read from
    // the local file rather than salvaged from a successful response.
    writeProject();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, text: async () => '' })
      .mockResolvedValueOnce({ ok: true });
    const res = await mod.uploadPendingArtifacts({ rootDir: tmp, projectId: 'p-1', setupKey: 's-1', fetchImpl });
    expect(res.endpoints).toBe(2);
  });

  it('still reports the endpoint count when the upload failed outright', async () => {
    writeProject();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({ ok: true });
    const res = await mod.uploadPendingArtifacts({ rootDir: tmp, projectId: 'p-1', setupKey: 's-1', fetchImpl });
    expect(res.oas).toBe('failed');
    expect(res.endpoints).toBe(2);
  });
});
