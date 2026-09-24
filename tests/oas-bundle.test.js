import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setGitRoot } from '../lib/pathGuard.js';
import { loadBundledOas, readSpecForUpload } from '../lib/oas-bundle.js';
import { adoptOasFile, countOasEndpoints, hashOasFile } from '../lib/oas-source.js';
import { pushOas } from '../lib/project-sync.js';

const SPLIT_ROOT = [
  'openapi: 3.0.3',
  'info: { title: Split, version: "1" }',
  'paths:',
  '  /users: { $ref: ./paths/users.yaml }',
  'components:',
  '  schemas:',
  '    Error: { type: object }',
].join('\n');
const USERS = [
  'get:',
  '  responses:',
  '    "200": { description: ok, content: { application/json: { schema: { $ref: ../schemas/User.yaml } } } }',
  '    "400": { description: bad, content: { application/json: { schema: { $ref: "../openapi.yaml#/components/schemas/Error" } } } }',
  'post:',
  '  responses: { "201": { description: made } }',
].join('\n');

describe('bundling a spec split across files', () => {
  let dir;
  const write = (rel, body) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  };
  const split = () => {
    write('docs/paths/users.yaml', USERS);
    write('docs/schemas/User.yaml', 'type: object\nproperties: { id: { type: string } }');
    return write('docs/openapi.yaml', SPLIT_ROOT);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-bundle-'));
    setGitRoot(dir);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends a single-file spec byte for byte, in its own format, exactly as before', () => {
    const yaml = 'openapi: 3.0.3\ninfo: { title: A, version: "1" }\npaths: {}\n# a comment\n';
    const res = readSpecForUpload(write('openapi.yaml', yaml));
    expect(res).toEqual({ ok: true, raw: yaml, format: 'yaml', bundled: false });
  });

  it('sends a split spec as one self-contained JSON document', () => {
    const res = readSpecForUpload(split(), 'docs/openapi.yaml');
    expect(res.ok).toBe(true);
    expect(res.bundled).toBe(true);
    expect(res.format).toBe('json');
    const spec = JSON.parse(res.raw);
    expect(Object.keys(spec.paths['/users'])).toEqual(['get', 'post']);
    const responses = spec.paths['/users'].get.responses;
    expect(responses[200].content['application/json'].schema.properties.id).toEqual({ type: 'string' });
    // A fragment's pointer back into the root file becomes an internal ref.
    expect(responses[400].content['application/json'].schema.$ref).toBe('#/components/schemas/Error');
    expect(res.raw).not.toMatch(/"\$ref":"[^#]/);
  });

  it('refuses a split spec whose refs do not resolve, naming the file', () => {
    const res = readSpecForUpload(write('openapi.yaml', SPLIT_ROOT), 'openapi.yaml');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('openapi.yaml');
  });

  it('counts and hashes a split spec the way the dashboard will see it', () => {
    const abs = split();
    // Before bundling, /users was a bare $ref with no methods under it: 0 endpoints.
    expect(countOasEndpoints(abs)).toBe(2);
    const before = hashOasFile(abs);
    // An edit to a fragment alone has to register as a change to the spec.
    write('docs/paths/users.yaml', USERS.replace('made', 'created'));
    expect(hashOasFile(abs)).not.toBe(before);
  });

  it('falls back to the file as written when its refs do not resolve', () => {
    const doc = loadBundledOas(write('openapi.yaml', SPLIT_ROOT));
    expect(doc.paths['/users']).toEqual({ $ref: './paths/users.yaml' });
  });

  it('uploads the bundled spec', async () => {
    split();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, endpoints: 2 }),
    });
    await pushOas({ rootDir: dir, oasFile: 'docs/openapi.yaml', projectId: 'p-1', token: 'tok' });
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.format).toBe('json');
    expect(Object.keys(JSON.parse(body.oas_raw).paths['/users'])).toEqual(['get', 'post']);
    fetchSpy.mockRestore();
  });

  it('refuses a split spec with broken refs when it is picked, not at claim time', () => {
    const abs = write('openapi.yaml', SPLIT_ROOT);
    const res = adoptOasFile({ absPath: abs, rootDir: dir, destDir: path.join(dir, '.restless') });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('$ref');
  });

  it('copies a split spec from outside the repo bundled, since its fragments stay behind', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-outside-'));
    fs.mkdirSync(path.join(outside, 'paths'));
    fs.writeFileSync(path.join(outside, 'paths/users.yaml'), 'get: { responses: { "200": { description: ok } } }');
    fs.writeFileSync(path.join(outside, 'openapi.yaml'), 'openapi: 3.0.3\ninfo: { title: X, version: "1" }\npaths:\n  /users: { $ref: ./paths/users.yaml }\n');
    const res = adoptOasFile({ absPath: path.join(outside, 'openapi.yaml'), rootDir: dir, destDir: path.join(dir, '.restless') });
    expect(res).toMatchObject({ ok: true, outcome: 'copied', oasFile: path.join('.restless', 'openapi.json') });
    const copied = JSON.parse(fs.readFileSync(path.join(dir, res.oasFile), 'utf8'));
    expect(copied.paths['/users'].get).toBeDefined();
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
