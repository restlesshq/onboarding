import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setGitRoot } from '../lib/pathGuard.js';
import { loadSettings, saveSettings } from '../lib/settings.js';
import { syncSpecBaseUrl } from '../lib/spec-base-url.js';
import { OAS_SOURCE_KINDS, oasSourceFacets } from '../lib/oas-source.js';

vi.mock('../lib/cli-token.js', () => ({
  getCliToken: vi.fn(async () => ({ ok: true, token: 'tok' })),
  clearCachedToken: vi.fn(),
  loadCachedToken: vi.fn(() => null),
}));
const { default: runFlagUpdate, parseUpdateFlags } = await import('../steps/update-flags.js');

/**
 * A base URL change has to reach the spec's `servers`.
 *
 * The dashboard's docs, try-it, docs chat and MCP calls read the uploaded
 * spec's servers. The settings `baseUrl` only labels the Settings page. Larkspur
 * changed its base URL with `update`, got "synced", and everything still called
 * a host that did not exist.
 */
const OLD = 'https://larkspur.onrender.com';
const NEW = 'https://larkspur-tqme.onrender.com';
const MANAGED = '.restless/openapi.json';
let tmp;

function writeSpec(rel, doc) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2));
}
const readSpec = (rel) => JSON.parse(fs.readFileSync(path.join(tmp, rel), 'utf8'));
const spec = (servers) => ({ openapi: '3.0.0', info: { title: 'L', version: '1' }, servers, paths: { '/pets': { get: {} } } });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-base-url-'));
  setGitRoot(tmp);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('syncSpecBaseUrl', () => {
  it('rewrites servers[0].url in a spec we generated', () => {
    writeSpec(MANAGED, spec([{ url: OLD }, { url: 'https://staging.example.net' }]));
    const res = syncSpecBaseUrl({
      rootDir: tmp, apiEntry: { oasFile: MANAGED, oasSource: { kind: 'agent' } }, baseUrl: NEW,
    });
    expect(res).toEqual({ outcome: 'rewritten', oasFile: MANAGED, from: OLD });
    // Only the first server is the API's base URL; the rest are left alone.
    expect(readSpec(MANAGED).servers).toEqual([{ url: NEW }, { url: 'https://staging.example.net' }]);
  });

  it('adds servers to a generated spec that had none', () => {
    writeSpec(MANAGED, spec(undefined));
    const res = syncSpecBaseUrl({ rootDir: tmp, apiEntry: { oasFile: MANAGED, oasSource: { kind: 'ai' } }, baseUrl: NEW });
    expect(res.outcome).toBe('rewritten');
    expect(readSpec(MANAGED).servers).toEqual([{ url: NEW }]);
  });

  it('drops template variables that belonged to the old URL', () => {
    writeSpec(MANAGED, spec([{ url: 'https://{env}.x.io', description: 'prod', variables: { env: { default: 'api' } } }]));
    syncSpecBaseUrl({ rootDir: tmp, apiEntry: { oasFile: MANAGED, oasSource: { kind: 'ai' } }, baseUrl: NEW });
    expect(readSpec(MANAGED).servers).toEqual([{ url: NEW, description: 'prod' }]);
  });

  it('treats a trailing slash as the same URL and leaves the file untouched', () => {
    writeSpec(MANAGED, spec([{ url: `${NEW}/` }]));
    const before = fs.readFileSync(path.join(tmp, MANAGED), 'utf8');
    const res = syncSpecBaseUrl({ rootDir: tmp, apiEntry: { oasFile: MANAGED, oasSource: { kind: 'ai' } }, baseUrl: NEW });
    expect(res.outcome).toBe('unchanged');
    expect(fs.readFileSync(path.join(tmp, MANAGED), 'utf8')).toBe(before);
  });

  it('treats a legacy entry with no recorded source as ours', () => {
    // Settings written before `oasSource` existed were all AI-generated.
    writeSpec(MANAGED, spec([{ url: OLD }]));
    const res = syncSpecBaseUrl({ rootDir: tmp, apiEntry: { oasFile: MANAGED }, baseUrl: NEW });
    expect(res.outcome).toBe('rewritten');
  });

  it("never edits the developer's own spec, and says what it still has", () => {
    writeSpec('docs/openapi.json', spec([{ url: OLD }]));
    const before = fs.readFileSync(path.join(tmp, 'docs/openapi.json'), 'utf8');
    const res = syncSpecBaseUrl({
      rootDir: tmp,
      apiEntry: { oasFile: 'docs/openapi.json', oasSource: { kind: 'found', path: 'docs/openapi.json' } },
      baseUrl: NEW,
    });
    expect(res).toMatchObject({ outcome: 'not-ours', specUrl: OLD });
    expect(fs.readFileSync(path.join(tmp, 'docs/openapi.json'), 'utf8')).toBe(before);
  });

  it('leaves a copy in .restless/ alone when its source would put the old URL back', () => {
    // A re-fetch or re-combine overwrites the copy, so an edit here would
    // silently revert on the next refresh.
    for (const kind of ['url', 'combined', 'describe', 'native']) {
      writeSpec(MANAGED, spec([{ url: OLD }]));
      const res = syncSpecBaseUrl({ rootDir: tmp, apiEntry: { oasFile: MANAGED, oasSource: { kind } }, baseUrl: NEW });
      expect(res.outcome).toBe('not-ours');
      expect(readSpec(MANAGED).servers[0].url).toBe(OLD);
    }
  });

  it('reports a generated spec it cannot parse instead of throwing', () => {
    fs.mkdirSync(path.join(tmp, '.restless'), { recursive: true });
    fs.writeFileSync(path.join(tmp, MANAGED), '{ not json');
    const res = syncSpecBaseUrl({ rootDir: tmp, apiEntry: { oasFile: MANAGED, oasSource: { kind: 'ai' } }, baseUrl: NEW });
    expect(res.outcome).toBe('unreadable');
  });

  it('has nothing to do without a spec', () => {
    expect(syncSpecBaseUrl({ rootDir: tmp, apiEntry: {}, baseUrl: NEW }).outcome).toBe('no-spec');
  });

  it('declares ownsServers for every source kind', () => {
    for (const kind of OAS_SOURCE_KINDS) {
      expect(typeof oasSourceFacets(kind).ownsServers).toBe('boolean');
    }
  });
});

describe('update --base-url', () => {
  /** Record each request, answer 200. */
  function mockFetch() {
    const calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ endpoints: 1 }), text: async () => '' };
    });
    return calls;
  }

  function setUp({ baseUrl, oasFile = MANAGED, kind = 'agent' }) {
    writeSpec(oasFile, spec([{ url: OLD }]));
    const entry = { id: 'a1', projectId: 'p-1', name: 'Larkspur', rootDir: '.', oasFile, oasSource: { kind }, baseUrl };
    saveSettings(tmp, { version: 1, apis: [entry] });
    return entry;
  }

  const run = async (apiEntry, ...args) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { flags } = parseUpdateFlags(['node', 'restless', 'update', ...args, '--json']);
    return runFlagUpdate({ rootDir: tmp, packageDir: tmp, apiEntry, flags });
  };

  it('rewrites the generated spec and pushes it with the settings', async () => {
    const entry = setUp({ baseUrl: OLD });
    const calls = mockFetch();

    expect(await run(entry, '--base-url', NEW)).toBe(0);

    expect(readSpec(MANAGED).servers[0].url).toBe(NEW);
    expect(loadSettings(tmp).apis[0].baseUrl).toBe(NEW);
    expect(calls.map((c) => c.url.replace(/^https?:\/\/[^/]+/, ''))).toEqual([
      '/api/projects/p-1/oas',
      '/api/projects/p-1/sync',
    ]);
    expect(calls[0].body.oas_raw).toContain(NEW);
  });

  it('repairs a stale spec when the setting already matches', async () => {
    // Larkspur's state after the bug: settings right, spec wrong. Repeating
    // the command has to fix it, not report "already matched" and stop.
    const entry = setUp({ baseUrl: NEW });
    const calls = mockFetch();

    expect(await run(entry, '--base-url', NEW)).toBe(0);

    expect(readSpec(MANAGED).servers[0].url).toBe(NEW);
    expect(calls[0].url).toContain('/api/projects/p-1/oas');
  });

  it("leaves the developer's spec alone, warns, and still syncs settings", async () => {
    const entry = setUp({ baseUrl: OLD, oasFile: 'openapi.json', kind: 'found' });
    const calls = mockFetch();

    expect(await run(entry, '--base-url', NEW)).toBe(0);

    expect(readSpec('openapi.json').servers[0].url).toBe(OLD);
    expect(calls.map((c) => c.url)).toEqual([expect.stringContaining('/api/projects/p-1/sync')]);
    const out = JSON.parse(console.log.mock.calls.at(-1)[0]);
    expect(out.specServers).toBe('not-ours');
  });

  it('does not touch the spec when the base URL is not being set', async () => {
    const entry = setUp({ baseUrl: NEW });
    const calls = mockFetch();

    expect(await run(entry, '--name', 'Larkspur API')).toBe(0);

    expect(readSpec(MANAGED).servers[0].url).toBe(OLD);
    expect(calls.map((c) => c.url)).toEqual([expect.stringContaining('/sync')]);
  });
});
