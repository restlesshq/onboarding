import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applySpecChange,
  buildActions,
  checkForSpecChanges,
  cleanRefreshTemp,
  regenerateTarget,
} from '../steps/update-oas.js';
import { describeCheck, describeDashboardGap } from '../steps/update-render.js';
import { compareWithDashboard, fetchDashboardSpec, pushOas } from '../lib/project-sync.js';
import {
  MANAGED_OAS_FILE,
  canonicalOasHash,
  autoCheckKinds,
  noAgentKinds,
} from '../lib/oas-source.js';
import { setGitRoot } from '../lib/pathGuard.js';

/**
 * The whole point of this step is that "refresh my spec" is not one action.
 * These tests pin which action is OFFERED FIRST per provenance, because that
 * default is the difference between re-fetching a URL and running an AI pass
 * over someone's hand-maintained file.
 */
describe('buildActions picks the primary action from provenance', () => {
  const keys = (entry) => buildActions(entry).map((a) => a.key);

  it('re-fetches a spec that came from a URL', () => {
    const actions = buildActions({
      oasFile: '.restless/openapi.json',
      oasSource: { kind: 'url', url: 'https://api.acme.com/openapi.json' },
    });
    expect(actions[0].key).toBe('refetch');
    // The URL is in the label so it's obvious what will be hit.
    expect(actions[0].label).toContain('https://api.acme.com/openapi.json');
  });

  it('only re-checks a file the user maintains, and never regenerates by default', () => {
    for (const kind of ['file', 'found']) {
      const actions = buildActions({
        oasFile: 'docs/openapi.yaml',
        oasSource: { kind, input: 'docs/openapi.yaml', path: 'docs/openapi.yaml' },
      });
      expect(actions[0].key).toBe('revalidate');
      expect(actions[0].key).not.toMatch(/^regenerate/);
    }
  });

  it('replays a described spec without quoting the recorded summary', () => {
    const actions = buildActions({
      oasFile: '.restless/openapi.json',
      oasSource: { kind: 'describe', summary: 'ran npm run openapi via tsx, server URL https://x' },
    });
    expect(actions[0].key).toBe('replay');
    // The label has to fit one picker row, and the summary is model-written
    // prose about build internals. How it gets the spec is our problem.
    expect(actions[0].label).toBe('Get the latest spec');
    expect(actions[0].label).not.toContain('npm run openapi');
  });

  it('regenerates through the framework for a native spec', () => {
    const actions = buildActions({
      oasFile: '.restless/openapi.json',
      oasSource: { kind: 'native', framework: 'Fastify' },
    });
    expect(actions[0].key).toBe('regenerate-native');
    expect(actions[0].label).toContain('Fastify');
  });

  it('regenerates from the routes for a spec we wrote', () => {
    expect(keys({ oasFile: MANAGED_OAS_FILE, oasSource: { kind: 'ai' } })[0]).toBe('regenerate');
    expect(keys({ oasFile: MANAGED_OAS_FILE, oasSource: { kind: 'agent' } })[0]).toBe('regenerate');
  });

  it('falls back to regenerating when no provenance was recorded', () => {
    expect(keys({ oasFile: MANAGED_OAS_FILE })[0]).toBe('regenerate');
  });

  it('always offers pointing at a different spec, and regenerating somewhere', () => {
    for (const kind of ['url', 'file', 'found', 'describe', 'native', 'ai', 'agent']) {
      const k = keys({ oasFile: 'docs/o.yaml', oasSource: { kind, url: 'u', summary: 's' } });
      expect(k).toContain('adopt');
      expect(k.some((x) => x.startsWith('regenerate'))).toBe(true);
    }
  });

  it('re-combines a combined spec, and falls back when its inputs were lost', () => {
    const actions = buildActions({
      oasFile: MANAGED_OAS_FILE,
      oasSource: { kind: 'combined', paths: ['a.yaml', 'b.yaml'] },
    });
    expect(actions[0].key).toBe('recombine');
    expect(actions[0].label).toContain('2 specs');
    expect(keys({ oasFile: MANAGED_OAS_FILE, oasSource: { kind: 'combined' } })[0]).toBe('regenerate');
  });

  it('degrades to regenerating when a url source has lost its url', () => {
    // Half-written provenance must not produce an action that can't run.
    expect(keys({ oasFile: MANAGED_OAS_FILE, oasSource: { kind: 'url' } })[0]).toBe('regenerate');
    expect(keys({ oasFile: MANAGED_OAS_FILE, oasSource: { kind: 'describe' } })[0]).toBe('regenerate');
  });
});

describe('regenerateTarget never overwrites the user’s own file', () => {
  it('regenerates in place when the spec is one of ours', () => {
    expect(regenerateTarget({ oasFile: MANAGED_OAS_FILE })).toBe(MANAGED_OAS_FILE);
    expect(regenerateTarget({ oasFile: '.restless/openapi.yaml' })).toBe('.restless/openapi.yaml');
  });

  it('writes to .restless/ when the spec is theirs', () => {
    // The alternative is clobbering a hand-written spec with generated output,
    // which is unrecoverable for them and silent for us.
    expect(regenerateTarget({ oasFile: 'docs/openapi.yaml' })).toBe(MANAGED_OAS_FILE);
    expect(regenerateTarget({ oasFile: 'openapi.json' })).toBe(MANAGED_OAS_FILE);
    expect(regenerateTarget({})).toBe(MANAGED_OAS_FILE);
  });
});

describe('pushOas', () => {
  let tmp;
  const OAS = JSON.stringify({ openapi: '3.0.0', paths: { '/pets': { get: {} } } });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-oas-'));
    fs.mkdirSync(path.join(tmp, '.restless'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.restless', 'openapi.json'), OAS);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('sends the device token, not the setup key', async () => {
    // Post-claim, `setup_key` reaches the pre-claim staging branch, which
    // refuses a claimed project. Sending the token is what selects the live
    // write path on the same endpoint.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, endpoints: 1 }),
    });
    const res = await pushOas({
      rootDir: tmp, oasFile: '.restless/openapi.json', projectId: 'p-1', token: 'tok',
    });
    expect(res).toEqual({ ok: true, endpoints: 1 });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.token).toBe('tok');
    expect(body.setup_key).toBeUndefined();
    expect(body.format).toBe('json');
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/projects/p-1/oas');
    fetchSpy.mockRestore();
  });

  it('marks an auth rejection as expired so the caller can clear the cache', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 401 });
    const res = await pushOas({
      rootDir: tmp, oasFile: '.restless/openapi.json', projectId: 'p-1', token: 'tok',
    });
    expect(res.ok).toBe(false);
    expect(res.expired).toBe(true);
    fetchSpy.mockRestore();
  });

  it('reports other HTTP failures without throwing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false, status: 413, text: async () => 'too big',
    });
    const res = await pushOas({
      rootDir: tmp, oasFile: '.restless/openapi.json', projectId: 'p-1', token: 'tok',
    });
    expect(res.ok).toBe(false);
    expect(res.expired).toBeUndefined();
    expect(res.error).toContain('413');
    fetchSpy.mockRestore();
  });

  it('reports a network failure without throwing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const res = await pushOas({
      rootDir: tmp, oasFile: '.restless/openapi.json', projectId: 'p-1', token: 'tok',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNRESET');
    fetchSpy.mockRestore();
  });

  it('sends yaml as yaml', async () => {
    fs.writeFileSync(path.join(tmp, '.restless', 'openapi.yaml'), 'openapi: 3.0.0\n');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }),
    });
    await pushOas({
      rootDir: tmp, oasFile: '.restless/openapi.yaml', projectId: 'p-1', token: 'tok',
    });
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body).format).toBe('yaml');
    fetchSpy.mockRestore();
  });

  it('reports a missing file instead of pushing an empty body', async () => {
    const res = await pushOas({
      rootDir: tmp, oasFile: '.restless/gone.json', projectId: 'p-1', token: 'tok',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('gone.json');
  });
});

/**
 * The up-front check is what makes `update` open with the state of your spec
 * instead of a menu that reads as "regenerate with AI". Two properties matter
 * more than the happy path: it must never touch the spec before consent, and a
 * failure must never block someone who only came to edit a setting.
 */
describe('which kinds can be checked, derived from the source table', () => {
  it('covers every kind that has a source to go back to', () => {
    expect([...autoCheckKinds()].sort()).toEqual([
      'combined', 'describe', 'file', 'found', 'native', 'url',
    ]);
  });

  it('excludes exactly the kinds with no source to return to', () => {
    // `ai` and `agent` specs were authored by reading the whole codebase, so
    // re-checking means doing that again from scratch. That's a decision, not
    // a status check, so it stays behind an explicit action.
    for (const kind of ['ai', 'agent']) {
      expect(autoCheckKinds().has(kind)).toBe(false);
    }
  });

  it('is the subset that needs no agent pass', () => {
    expect([...noAgentKinds()].sort()).toEqual(['combined', 'file', 'found', 'url']);
  });

  it('is a strict subset of what the interactive flow checks', () => {
    // `--status` is the cheap probe an agent runs first, so it must never
    // spawn a second agent to answer. The interactive flow goes wider because
    // a human is watching a spinner and can interrupt it.
    for (const kind of noAgentKinds()) expect(autoCheckKinds().has(kind)).toBe(true);
    expect(noAgentKinds().has('describe')).toBe(false);
    expect(noAgentKinds().has('native')).toBe(false);
  });
});

describe('checkForSpecChanges for a spec on disk', () => {
  let tmp;
  const V1 = JSON.stringify({ openapi: '3.0.0', paths: { '/pets': { get: {} } } });
  const V2 = JSON.stringify({
    openapi: '3.0.0',
    paths: { '/pets': { get: {}, post: {} } },
  });

  function entry(over = {}) {
    return {
      id: 'a', projectId: 'p-1', oasFile: 'docs/openapi.json',
      oasSource: { kind: 'found', path: 'docs/openapi.json' }, ...over,
    };
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-oas-'));
    setGitRoot(tmp);
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'openapi.json'), V1);
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports unknown when we have never pushed it', async () => {
    // Honest third state: no fingerprint means we cannot claim it changed,
    // and must not claim it didn't.
    const res = await checkForSpecChanges({ rootDir: tmp, apiEntry: entry() });
    expect(res.kind).toBe('unknown');
    expect(res.endpoints).toBe(1);
  });

  it('reports unchanged when the content matches the fingerprint', async () => {
    const res = await checkForSpecChanges({
      rootDir: tmp, apiEntry: entry({ oasHash: canonicalOasHash(JSON.parse(V1)) }),
    });
    expect(res.kind).toBe('unchanged');
  });

  it('reports changed with a count delta when the content differs', async () => {
    fs.writeFileSync(path.join(tmp, 'docs', 'openapi.json'), V2);
    const res = await checkForSpecChanges({
      rootDir: tmp,
      apiEntry: entry({ oasHash: canonicalOasHash(JSON.parse(V1)), oasOperationCount: 1 }),
    });
    // A hash can say THAT it changed, not which operations moved - so the
    // result is discriminated as living on disk already, and describeCheck
    // must not imply a diff it doesn't have.
    expect(res.kind).toBe('on-disk');
    expect(res.diff).toBeUndefined();
    expect(res.previousEndpoints).toBe(1);
    expect(res.endpoints).toBe(2);
    expect(describeCheck(res).join('\n')).toContain('1 to 2 endpoints');
  });

  it('stages nothing for a spec already on disk', async () => {
    fs.writeFileSync(path.join(tmp, 'docs', 'openapi.json'), V2);
    const res = await checkForSpecChanges({
      rootDir: tmp, apiEntry: entry({ oasHash: canonicalOasHash(JSON.parse(V1)) }),
    });
    expect(res.tempFile).toBeUndefined();
    // applySpecChange is a no-op that just names the target.
    expect(applySpecChange({ rootDir: tmp, check: res })).toBe('docs/openapi.json');
  });

  it('fails soft when the spec is gone', async () => {
    fs.rmSync(path.join(tmp, 'docs', 'openapi.json'));
    const res = await checkForSpecChanges({ rootDir: tmp, apiEntry: entry() });
    expect(res.kind).toBe('failed');
    expect(res.reason).toContain('not on disk');
  });

  it('fails soft when the spec no longer parses', async () => {
    fs.writeFileSync(path.join(tmp, 'docs', 'openapi.json'), '{{{ not json');
    const res = await checkForSpecChanges({
      rootDir: tmp, apiEntry: entry({ oasHash: 'x'.repeat(64) }),
    });
    expect(res.kind).toBe('failed');
    expect(res.reason).toContain('parse');
  });

  it('fails soft for a url source with no url recorded', async () => {
    const res = await checkForSpecChanges({
      rootDir: tmp, apiEntry: entry({ oasSource: { kind: 'url' } }),
    });
    expect(res.kind).toBe('failed');
  });

  describe('a combined spec', () => {
    const combinedEntry = (over = {}) => entry({
      oasFile: MANAGED_OAS_FILE,
      oasSource: { kind: 'combined', paths: ['docs/openapi.json', 'docs/orgs.json'] },
      ...over,
    });
    const orgs = (paths) => fs.writeFileSync(
      path.join(tmp, 'docs', 'orgs.json'),
      JSON.stringify({ openapi: '3.0.0', paths }),
    );

    it('rebuilds from its inputs and stages the result without touching them', async () => {
      orgs({ '/orgs': { get: {} } });
      const before = fs.readFileSync(path.join(tmp, 'docs', 'openapi.json'), 'utf8');
      const res = await checkForSpecChanges({ rootDir: tmp, apiEntry: combinedEntry() });
      expect(res.kind).toBe('staged');
      expect(res.targetFile).toBe(MANAGED_OAS_FILE);
      expect(res.diff.added).toEqual(['GET /orgs', 'GET /pets']);
      expect(res.oasSource).toEqual({ kind: 'combined', paths: ['docs/openapi.json', 'docs/orgs.json'] });
      expect(fs.readFileSync(path.join(tmp, 'docs', 'openapi.json'), 'utf8')).toBe(before);
      expect(applySpecChange({ rootDir: tmp, check: res })).toBe(MANAGED_OAS_FILE);
    });

    it('fails soft, with the reason, when the inputs now conflict', async () => {
      orgs({ '/pets': { get: {} } });
      const res = await checkForSpecChanges({ rootDir: tmp, apiEntry: combinedEntry() });
      expect(res.kind).toBe('failed');
      expect(res.reason).toContain('GET /pets is in both');
    });
  });

  it('cleanRefreshTemp is safe when there is nothing to clean', () => {
    expect(() => cleanRefreshTemp(tmp)).not.toThrow();
  });
});

/**
 * The comparison that answers the question people actually have. Everything
 * else here compares a local file against its own source, which cannot see
 * that the dashboard is serving something older - and got reported as "no
 * endpoint changes" while the dashboard was two endpoints behind.
 */
describe('compareWithDashboard', () => {
  const local = {
    paths: {
      '/pets': { get: {} },
      '/pets/{id}': { get: {} },
      '/feedback': { get: {} },
    },
  };
  const remoteOf = (ops, over = {}) => ({
    ok: true, hasSpec: true, endpoints: ops.length, operations: ops,
    oasHash: 'remote-hash', oasSyncedAt: '2026-07-15T00:00:00.000Z', ...over,
  });

  it('names the endpoints the dashboard is missing', () => {
    const cmp = compareWithDashboard({
      localOas: local,
      localHash: 'local-hash',
      remote: remoteOf(['GET /pets']),
    });
    expect(cmp.status).toBe('behind');
    expect(cmp.missing).toEqual(['GET /feedback', 'GET /pets/{}']);
    expect(cmp.extra).toEqual([]);
    expect(describeDashboardGap(cmp).join('\n')).toContain('missing 2 endpoints');
  });

  it('short-circuits on a matching content hash', () => {
    // Same hash means the dashboard is serving this exact spec, so there is
    // nothing to compute or say.
    const cmp = compareWithDashboard({
      localOas: local,
      localHash: 'same',
      remote: remoteOf(['GET /pets'], { oasHash: 'same' }),
    });
    expect(cmp.status).toBe('in-sync');
    expect(describeDashboardGap(cmp)).toEqual([]);
  });

  it('reports content drift when the operations match but the hash does not', () => {
    // Revised descriptions and schemas still matter: they are what the docs
    // and the AI chat serve.
    const cmp = compareWithDashboard({
      localOas: local,
      localHash: 'local',
      remote: remoteOf(['GET /pets', 'GET /pets/{}', 'GET /feedback']),
    });
    expect(cmp.status).toBe('behind');
    expect(cmp.contentOnly).toBe(true);
    expect(describeDashboardGap(cmp).join('\n')).toContain('older version');
  });

  it('flags a dashboard with no spec at all as pushable', () => {
    const cmp = compareWithDashboard({
      localOas: local, localHash: 'x', remote: { ok: true, hasSpec: false },
    });
    expect(cmp.status).toBe('no-remote-spec');
    expect(describeDashboardGap(cmp).join('\n')).toContain('no spec yet');
  });

  it('reports endpoints the dashboard has that the local spec dropped', () => {
    const cmp = compareWithDashboard({
      localOas: { paths: { '/pets': { get: {} } } },
      localHash: 'a',
      remote: remoteOf(['GET /pets', 'GET /retired']),
    });
    expect(cmp.missing).toEqual([]);
    expect(cmp.extra).toEqual(['GET /retired']);
    expect(describeDashboardGap(cmp).join('\n')).toContain('no longer in your spec');
  });

  it('says nothing at all when the fetch failed', () => {
    // Not knowing what the dashboard has is a reason to say less, never to
    // block someone who came to edit a setting.
    expect(compareWithDashboard({ localOas: local, localHash: 'x', remote: { ok: false } })).toBeNull();
    expect(describeDashboardGap(null)).toEqual([]);
  });

  it('normalizes paths the same way the dashboard does', () => {
    // The dashboard sends `GET /pets/{}`; a parameter rename must not read as
    // an added and a removed endpoint.
    const cmp = compareWithDashboard({
      localOas: { paths: { '/pets/{petId}': { get: {} } } },
      localHash: 'a',
      remote: remoteOf(['GET /pets/{}']),
    });
    expect(cmp.missing).toEqual([]);
    expect(cmp.extra).toEqual([]);
  });
});

describe('fetchDashboardSpec', () => {
  it('sends the token and reads the summary', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        hasSpec: true, endpoints: 2, operations: ['GET /a', 'GET /b'],
        oasHash: 'h', oasSyncedAt: '2026-07-15T00:00:00.000Z',
      }),
    });
    const res = await fetchDashboardSpec({ projectId: 'p-1', token: 'tok' });
    expect(res.ok).toBe(true);
    expect(res.operations).toEqual(['GET /a', 'GET /b']);
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/projects/p-1/oas');
    // The credential belongs in a header. The query parameter is transitional,
    // pending the server reading the header - when that lands, this assertion
    // and the parameter go together.
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    fetchSpy.mockRestore();
  });

  it('marks an auth rejection as expired', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 });
    const res = await fetchDashboardSpec({ projectId: 'p-1', token: 'tok' });
    expect(res.ok).toBe(false);
    expect(res.expired).toBe(true);
    fetchSpy.mockRestore();
  });

  it('never throws on a network failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const res = await fetchDashboardSpec({ projectId: 'p-1', token: 'tok' });
    expect(res).toMatchObject({ ok: false, error: 'offline' });
    fetchSpy.mockRestore();
  });
});
