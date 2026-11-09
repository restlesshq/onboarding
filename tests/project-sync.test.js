import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { syncProject } from '../lib/project-sync.js';
import { loadSettings, saveSettings } from '../lib/settings.js';
import { canonicalOasHash } from '../lib/oas-source.js';
import { setGitRoot } from '../lib/pathGuard.js';

vi.mock('../lib/cli-token.js', () => ({
  clearCachedToken: vi.fn(),
  loadCachedToken: vi.fn(() => null),
}));
const { clearCachedToken } = await import('../lib/cli-token.js');

/**
 * Publishing is one sequence with an order that matters: the spec, then the
 * fingerprint of what actually landed, then the settings blob.
 *
 * It lives in one function because both callers used to have it written out by
 * hand, and "remember to fingerprint after pushing" is not something two call
 * sites should each have to get right. The flag-driven one had already
 * forgotten, which is why `--status` on a maintained spec could only ever
 * answer "no record of pushing it".
 */
const SPEC = { openapi: '3.0.0', paths: { '/pets': { get: {} }, '/owners': { get: {} } } };
let tmp;
const apiEntry = { id: 'a1', projectId: 'p-1' };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  setGitRoot(tmp);
  fs.mkdirSync(path.join(tmp, '.restless'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.restless', 'openapi.json'), JSON.stringify(SPEC));
  saveSettings(tmp, {
    version: 1,
    apis: [{ id: 'a1', projectId: 'p-1', name: 'Pets', rootDir: '.', oasFile: '.restless/openapi.json' }],
  });
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Respond to each call in turn, recording the URLs hit in order. */
function mockFetchSequence(responses) {
  const urls = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    urls.push(String(url));
    const next = responses.shift();
    return next ?? { ok: true, status: 200, json: async () => ({}) };
  });
  return { spy, urls };
}

describe('syncProject', () => {
  it('waits for screening approval before fingerprinting or pushing settings', async () => {
    const screeningId = 'a'.repeat(64);
    const { spy, urls } = mockFetchSequence([
      { ok: true, status: 202, json: async () => ({ pending: true, screening_id: screeningId, retry_after_ms: 1000 }) },
      { ok: true, status: 200, json: async () => ({ endpoints: 2 }) },
      { ok: true, status: 200, json: async () => ({}) },
    ]);
    try {
      const res = await syncProject({
        rootDir: tmp, apiEntry, oasFile: '.restless/openapi.json', token: 'tok',
      });
      expect(res).toMatchObject({ ok: true, specSynced: true, settingsSynced: true, endpoints: 2 });
      expect(urls).toHaveLength(3);
      expect(JSON.parse(spy.mock.calls[1][1].body)).toEqual({ token: 'tok', screening_id: screeningId });
      expect(urls[2]).toContain('/sync');
    } finally {
      spy.mockRestore();
    }
  });

  it('pushes the spec, then the settings, and fingerprints what landed', async () => {
    const { spy, urls } = mockFetchSequence([
      { ok: true, status: 200, json: async () => ({ endpoints: 2 }) },
      { ok: true, status: 200, json: async () => ({}) },
    ]);

    const res = await syncProject({
      rootDir: tmp, apiEntry, oasFile: '.restless/openapi.json', token: 'tok',
    });

    expect(res).toMatchObject({ ok: true, specSynced: true, settingsSynced: true, endpoints: 2 });
    expect(urls[0]).toContain('/api/projects/p-1/oas');
    expect(urls[1]).toContain('/api/projects/p-1/sync');

    // The fingerprint is what lets the next run tell a local edit from
    // "nothing has happened since".
    const entry = loadSettings(tmp).apis[0];
    expect(entry.oasHash).toBe(canonicalOasHash(SPEC));
    expect(entry.oasOperationCount).toBe(2);
    spy.mockRestore();
  });

  it('stops on a terminal resumed error without retrying raw content or exposing the response body', async () => {
    const { spy, urls } = mockFetchSequence([
      { ok: true, status: 202, json: async () => ({ pending: true, screening_id: 'a'.repeat(64), retry_after_ms: 1000 }) },
      { ok: false, status: 503, text: async () => 'private-spec-sentinel tok' },
    ]);
    try {
      const res = await syncProject({
        rootDir: tmp, apiEntry, oasFile: '.restless/openapi.json', token: 'tok',
      });
      expect(res).toMatchObject({ ok: false, specSynced: false, settingsSynced: false });
      expect(res.error).toContain('503');
      expect(res.error).not.toContain('private-spec-sentinel');
      expect(urls).toHaveLength(2);
      expect(JSON.parse(spy.mock.calls[1][1].body)).not.toHaveProperty('oas_raw');
      expect(loadSettings(tmp).apis[0].oasHash).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('pushes only the settings when there is no new spec', async () => {
    const { spy, urls } = mockFetchSequence([{ ok: true, status: 200, json: async () => ({}) }]);
    const res = await syncProject({ rootDir: tmp, apiEntry, token: 'tok' });
    expect(res).toMatchObject({ ok: true, specSynced: false, settingsSynced: true });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/sync');
    spy.mockRestore();
  });

  it('does not push settings when the spec push failed', async () => {
    // Half-applied is worse than not applied: the dashboard would report a
    // settings sync it never got a spec for.
    const { spy, urls } = mockFetchSequence([{ ok: false, status: 500, text: async () => 'boom' }]);
    const res = await syncProject({
      rootDir: tmp, apiEntry, oasFile: '.restless/openapi.json', token: 'tok',
    });
    expect(res.ok).toBe(false);
    expect(res.specSynced).toBe(false);
    expect(res.settingsSynced).toBe(false);
    expect(urls).toHaveLength(1);
    spy.mockRestore();
  });

  it('records no fingerprint when the spec never landed', async () => {
    const { spy } = mockFetchSequence([{ ok: false, status: 500, text: async () => '' }]);
    await syncProject({ rootDir: tmp, apiEntry, oasFile: '.restless/openapi.json', token: 'tok' });
    expect(loadSettings(tmp).apis[0].oasHash).toBeUndefined();
    spy.mockRestore();
  });

  it('clears the cached token when the server rejects it', async () => {
    const { spy } = mockFetchSequence([{ ok: false, status: 401 }]);
    const res = await syncProject({
      rootDir: tmp, apiEntry, oasFile: '.restless/openapi.json', token: 'stale',
    });
    expect(res.expired).toBe(true);
    // Otherwise every later run retries a token the server has already refused.
    expect(clearCachedToken).toHaveBeenCalledWith('p-1');
    spy.mockRestore();
  });

  it('clears the cached token when the settings push is the one rejected', async () => {
    const { spy } = mockFetchSequence([
      { ok: true, status: 200, json: async () => ({ endpoints: 2 }) },
      { ok: false, status: 401 },
    ]);
    const res = await syncProject({
      rootDir: tmp, apiEntry, oasFile: '.restless/openapi.json', token: 'stale',
    });
    // The spec did land; say so rather than collapsing both halves into failure.
    expect(res.specSynced).toBe(true);
    expect(res.settingsSynced).toBe(false);
    expect(res.ok).toBe(false);
    expect(clearCachedToken).toHaveBeenCalledWith('p-1');
    spy.mockRestore();
  });

  it('reports an unreadable spec without throwing', async () => {
    const res = await syncProject({
      rootDir: tmp, apiEntry, oasFile: '.restless/missing.json', token: 'tok',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('missing.json');
  });
});
