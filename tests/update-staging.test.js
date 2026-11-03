import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setGitRoot } from '../lib/pathGuard.js';
import { canonicalOasHash } from '../lib/oas-source.js';

/**
 * The spec on disk is the developer's, and nothing may write to it before they
 * say so.
 *
 * That is the property this file exists to pin, because it was broken in a way
 * tests couldn't see: the up-front check staged carefully into a scratch
 * directory, while the menu behind it ran a second, unstaged copy of the same
 * refresh. `locateOasWithAi` empties its destination before the model runs, so
 * a replay pointed at the live spec deleted it, and a model that then produced
 * nothing left the run reporting "Nothing changed" with the file gone.
 *
 * The AI engines are mocked. What matters here is not what they produce but
 * WHERE they are pointed and what survives when they fail.
 */
vi.mock('../steps/generate-oas.js', () => ({
  locateOasWithAi: vi.fn(),
  generateOasWithAi: vi.fn(),
  pickOasCandidate: vi.fn(),
  describeCoverageGap: () => [],
}));

const { locateOasWithAi, generateOasWithAi } = await import('../steps/generate-oas.js');
const {
  applySpecChange,
  checkForSpecChanges,
  runAction,
  refreshFromRecordedSource,
  stageRefresh,
} = await import('../steps/update-oas.js');

const V1 = { openapi: '3.0.0', paths: { '/pets': { get: { summary: 'v1' } } } };
const V2 = {
  openapi: '3.0.0',
  paths: { '/pets': { get: { summary: 'v1' } }, '/owners': { get: {} } },
};

const REFRESH_DIR = '.restless/.oas-refresh';
let tmp;

/** Stand in for an AI engine: write `doc` where the caller pointed it. */
function engineWriting(doc, { ok = true } = {}) {
  return async (opts) => {
    const dest = opts.destFile || opts.oasFile;
    writeSpec(dest, doc);
    return ok
      ? { ok: true, oasFile: dest, summary: 's', coverage: { ok: true, missing: [] } }
      : { ok: false, error: 'gave up' };
  };
}

/** Write a spec at a repo-relative path. */
function writeSpec(rel, doc) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2));
  return abs;
}

function readSpec(rel) {
  return JSON.parse(fs.readFileSync(path.join(tmp, rel), 'utf8'));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'));
  setGitRoot(tmp);
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a refresh is always staged, never written in place', () => {
  it('points the locate engine at the scratch directory, not the live spec', async () => {
    // The regression in one assertion. `locateOasWithAi` deletes its
    // destination before it runs, so being handed the live spec is destructive
    // on its own - before anything fails and before anyone is asked.
    writeSpec('.restless/openapi.json', V1);
    locateOasWithAi.mockImplementation(engineWriting(V2));

    await runAction({
      action: 'replay',
      apiEntry: {
        oasFile: '.restless/openapi.json',
        oasSource: { kind: 'describe', summary: 'ran npm run openapi' },
      },
      rootDir: tmp,
      packageDir: tmp,
    });

    const { destFile } = locateOasWithAi.mock.calls[0][0];
    expect(destFile.startsWith(REFRESH_DIR)).toBe(true);
    expect(destFile).not.toBe('.restless/openapi.json');
  });

  it('points the generator at the scratch directory too', async () => {
    writeSpec('.restless/openapi.json', V1);
    generateOasWithAi.mockImplementation(engineWriting(V2));

    await runAction({
      action: 'regenerate',
      apiEntry: { oasFile: '.restless/openapi.json', oasSource: { kind: 'ai' } },
      rootDir: tmp,
      packageDir: tmp,
    });

    expect(generateOasWithAi.mock.calls[0][0].oasFile.startsWith(REFRESH_DIR)).toBe(true);
  });

  it('leaves the spec exactly as it was when the refresh produces nothing', async () => {
    // The reported symptom: "Nothing changed", and the file gone.
    writeSpec('.restless/openapi.json', V1);
    locateOasWithAi.mockResolvedValue({ ok: false, error: "couldn't find it" });

    const res = await runAction({
      action: 'replay',
      apiEntry: {
        oasFile: '.restless/openapi.json',
        oasSource: { kind: 'describe', summary: 'ran npm run openapi' },
      },
      rootDir: tmp,
      packageDir: tmp,
    });

    expect(res.kind).toBe('failed');
    expect(fs.existsSync(path.join(tmp, '.restless/openapi.json'))).toBe(true);
    expect(readSpec('.restless/openapi.json')).toEqual(V1);
  });

  it('cleans up the scratch directory when a refresh fails', async () => {
    writeSpec('.restless/openapi.json', V1);
    locateOasWithAi.mockImplementation(async () => {
      // Whatever it wrote before giving up must not be left behind: `.restless/`
      // is a directory people are told to commit.
      writeSpec(`${REFRESH_DIR}/half-written.json`, { openapi: '3.0.0' });
      return { ok: false, error: 'gave up' };
    });

    await stageRefresh({
      apiEntry: { oasFile: '.restless/openapi.json', oasSource: { kind: 'describe', summary: 's' } },
      rootDir: tmp,
      packageDir: tmp,
      strategy: 'locate',
    });

    expect(fs.existsSync(path.join(tmp, REFRESH_DIR))).toBe(false);
  });

  it('re-fetches a url into the scratch directory, leaving the current spec alone', async () => {
    writeSpec('.restless/openapi.json', V1);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, text: async () => JSON.stringify(V2),
    });

    const check = await checkForSpecChanges({
      rootDir: tmp,
      apiEntry: {
        oasFile: '.restless/openapi.json',
        oasSource: { kind: 'url', url: 'https://api.acme.com/openapi.json' },
      },
    });

    expect(check.kind).toBe('staged');
    expect(check.tempFile.startsWith(REFRESH_DIR)).toBe(true);
    expect(check.diff.added).toEqual(['GET /owners']);
    // Downloaded, diffed, and the developer's file is still v1.
    expect(readSpec('.restless/openapi.json')).toEqual(V1);
    fetchSpy.mockRestore();
  });
});

describe('applySpecChange is the only thing that touches the spec', () => {
  it('moves a staged file into place and clears the scratch directory', async () => {
    writeSpec('.restless/openapi.json', V1);
    writeSpec(`${REFRESH_DIR}/openapi.json`, V2);

    const applied = applySpecChange({
      rootDir: tmp,
      check: { kind: 'staged', tempFile: `${REFRESH_DIR}/openapi.json`, targetFile: '.restless/openapi.json' },
    });

    expect(applied).toBe('.restless/openapi.json');
    expect(readSpec('.restless/openapi.json')).toEqual(V2);
    expect(fs.existsSync(path.join(tmp, REFRESH_DIR))).toBe(false);
  });

  it('writes nothing for a result that is already on disk', () => {
    const abs = writeSpec('docs/openapi.json', V1);
    const before = fs.statSync(abs).mtimeMs;
    const applied = applySpecChange({
      rootDir: tmp, check: { kind: 'on-disk', targetFile: 'docs/openapi.json' },
    });
    expect(applied).toBe('docs/openapi.json');
    expect(fs.statSync(abs).mtimeMs).toBe(before);
  });

  it('lands a regenerated spec beside the code rather than on a maintained file', async () => {
    // Their file is the source of truth. A regenerate re-points `oasFile`; it
    // does not overwrite what they wrote.
    writeSpec('docs/openapi.yaml', V1);
    generateOasWithAi.mockImplementation(engineWriting(V2));

    const check = await runAction({
      action: 'regenerate',
      apiEntry: { oasFile: 'docs/openapi.yaml', oasSource: { kind: 'found', path: 'docs/openapi.yaml' } },
      rootDir: tmp,
      packageDir: tmp,
    });
    expect(check.targetFile).toBe('.restless/openapi.json');

    applySpecChange({ rootDir: tmp, check });
    expect(readSpec('docs/openapi.yaml')).toEqual(V1);
    expect(readSpec('.restless/openapi.json')).toEqual(V2);
  });
});

describe('--refresh applies without a prompt, because the flag is the consent', () => {
  it('lands the refreshed spec and reports the diff', async () => {
    writeSpec('.restless/openapi.json', V1);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, text: async () => JSON.stringify(V2),
    });

    const res = await refreshFromRecordedSource({
      rootDir: tmp,
      packageDir: tmp,
      apiEntry: {
        oasFile: '.restless/openapi.json',
        oasSource: { kind: 'url', url: 'https://api.acme.com/openapi.json' },
      },
    });

    expect(res.ok).toBe(true);
    expect(res.action).toBe('refetch');
    expect(res.oasFile).toBe('.restless/openapi.json');
    expect(res.diff.added).toEqual(['GET /owners']);
    expect(readSpec('.restless/openapi.json')).toEqual(V2);
    expect(fs.existsSync(path.join(tmp, REFRESH_DIR))).toBe(false);
    fetchSpy.mockRestore();
  });

  it('reports an unchanged spec as a success with nothing to show', async () => {
    writeSpec('.restless/openapi.json', V1);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, text: async () => JSON.stringify(V1),
    });

    const res = await refreshFromRecordedSource({
      rootDir: tmp,
      packageDir: tmp,
      apiEntry: {
        oasFile: '.restless/openapi.json',
        oasSource: { kind: 'url', url: 'https://api.acme.com/openapi.json' },
      },
    });

    expect(res.ok).toBe(true);
    expect(res.unchanged).toBe(true);
    // Callers read `diff` unconditionally; an unchanged refresh has to answer
    // with an empty one rather than making every one of them null-check.
    expect(res.diff).toEqual({ added: [], removed: [], modified: [], changed: false });
    fetchSpy.mockRestore();
  });

  it('keeps the existing spec when the refresh fails', async () => {
    writeSpec('.restless/openapi.json', V1);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 });

    const res = await refreshFromRecordedSource({
      rootDir: tmp,
      packageDir: tmp,
      apiEntry: {
        oasFile: '.restless/openapi.json',
        oasSource: { kind: 'url', url: 'https://api.acme.com/openapi.json' },
      },
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('503');
    expect(readSpec('.restless/openapi.json')).toEqual(V1);
    fetchSpy.mockRestore();
  });
});

describe('revalidate reads and never writes', () => {
  const found = (over = {}) => ({
    oasFile: 'docs/openapi.json',
    oasSource: { kind: 'found', path: 'docs/openapi.json' },
    ...over,
  });
  const revalidate = (apiEntry) => runAction({
    action: 'revalidate', apiEntry, rootDir: tmp, packageDir: tmp,
  });

  it('reports the count without staging anything', async () => {
    writeSpec('docs/openapi.json', V2);
    const check = await revalidate(found());
    expect(check.endpoints).toBe(2);
    expect(check.tempFile).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, REFRESH_DIR))).toBe(false);
  });

  it('answers the same way the automatic check does', async () => {
    // An explicit "re-check my file" and the up-front check read the same
    // fingerprint, so they cannot disagree about whether the file moved. This
    // used to announce "Your spec changed since you last pushed it" for any
    // file that merely parsed - including one nobody had ever pushed.
    writeSpec('docs/openapi.json', V2);
    expect((await revalidate(found())).kind).toBe('unknown');
    expect((await revalidate(found({ oasHash: canonicalOasHash(V2) }))).kind).toBe('unchanged');
    const changed = await revalidate(found({
      oasHash: canonicalOasHash(V1), oasOperationCount: 1,
    }));
    expect(changed.kind).toBe('on-disk');
    expect(changed.previousEndpoints).toBe(1);
    expect(changed.endpoints).toBe(2);
  });

  it('fails soft on a spec that stopped parsing', async () => {
    fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'docs', 'openapi.json'), '{{{ not json');
    const check = await runAction({
      action: 'revalidate',
      apiEntry: { oasFile: 'docs/openapi.json', oasSource: { kind: 'found' } },
      rootDir: tmp,
      packageDir: tmp,
    });
    expect(check.kind).toBe('failed');
    expect(check.reason).toContain('parse');
  });
});

describe('a regenerated spec gets the project base URL', () => {
  // The generator is prompted with a placeholder host. Setup swaps it out;
  // a refresh from `update` used to ship it, pointing docs and MCP calls at
  // example.com and undoing any base URL `update --base-url` had written.
  const withPlaceholder = { ...V2, servers: [{ url: 'https://example.com' }] };

  it('replaces the placeholder in the staged spec', async () => {
    writeSpec('.restless/openapi.json', V1);
    generateOasWithAi.mockImplementation(engineWriting(withPlaceholder));

    const res = await stageRefresh({
      apiEntry: { oasFile: '.restless/openapi.json', oasSource: { kind: 'ai' }, baseUrl: 'https://api.acme.io' },
      rootDir: tmp,
      strategy: 'generate',
    });

    expect(res.ok).toBe(true);
    expect(readSpec(res.oasFile).servers).toEqual([{ url: 'https://api.acme.io' }]);
  });
});
