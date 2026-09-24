import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setGitRoot } from '../lib/pathGuard.js';
import {
  combineSpecs,
  combineSpecFiles,
  combinableSpecs,
  loadSpecFile,
  summarizeSpecList,
} from '../lib/oas-combine.js';

const spec = (over = {}) => ({
  openapi: '3.0.3',
  info: { title: 'T', version: '1' },
  servers: [{ url: 'https://api.acme.com' }],
  paths: {},
  ...over,
});
const ok = (description = 'ok') => ({ responses: { 200: { description } } });
const refTo = (name) => ({
  responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } },
});

describe('combineSpecs', () => {
  it('unions paths and merges methods on a shared path', () => {
    const res = combineSpecs([
      { label: 'users.yaml', spec: spec({ info: { title: 'Users', version: '2' }, paths: { '/users': { get: ok() } } }) },
      { label: 'orgs.yaml', spec: spec({ paths: { '/orgs': { get: ok() }, '/users': { post: ok() } } }) },
    ]);
    expect(res.ok).toBe(true);
    expect(Object.keys(res.spec.paths).sort()).toEqual(['/orgs', '/users']);
    expect(Object.keys(res.spec.paths['/users']).sort()).toEqual(['get', 'post']);
    expect(res.spec.info.title).toBe('Users');
  });

  it('refuses the same operation in two specs rather than picking one', () => {
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec({ paths: { '/users': { get: ok('a') } } }) },
      { label: 'b.yaml', spec: spec({ paths: { '/users': { get: ok('b') } } }) },
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('GET /users is in both a.yaml and b.yaml');
  });

  it('keeps one copy of an identical component', () => {
    const Error = { type: 'object', properties: { message: { type: 'string' } } };
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec({ paths: { '/a': { get: refTo('Error') } }, components: { schemas: { Error } } }) },
      { label: 'b.yaml', spec: spec({ paths: { '/b': { get: refTo('Error') } }, components: { schemas: { Error } } }) },
    ]);
    expect(res.renamed).toEqual([]);
    expect(Object.keys(res.spec.components.schemas)).toEqual(['Error']);
  });

  it('renames a divergent component and every ref that reaches it, transitively', () => {
    const res = combineSpecs([
      {
        label: 'users.yaml',
        spec: spec({
          paths: { '/users': { get: refTo('Page') } },
          components: { schemas: { Error: { type: 'string' }, Page: { properties: { e: { $ref: '#/components/schemas/Error' } } } } },
        }),
      },
      {
        label: 'specs/billing.yaml',
        spec: spec({
          paths: { '/invoices': { get: refTo('Page') } },
          components: {
            schemas: {
              Error: { type: 'object' },
              Page: { properties: { e: { $ref: '#/components/schemas/Error' } } },
              Pet: { discriminator: { propertyName: 't', mapping: { a: 'Error', b: '#/components/schemas/Error' } } },
            },
          },
        }),
      },
    ]);
    expect(res.ok).toBe(true);
    const s = res.spec.components.schemas;
    expect(s.BillingError).toEqual({ type: 'object' });
    // Page is textually identical, but it points at a different Error, so it moves too.
    expect(s.BillingPage.properties.e.$ref).toBe('#/components/schemas/BillingError');
    expect(s.Page.properties.e.$ref).toBe('#/components/schemas/Error');
    expect(res.spec.paths['/invoices'].get.responses[200].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/BillingPage');
    expect(s.Pet.discriminator.mapping).toEqual({ a: 'BillingError', b: '#/components/schemas/BillingError' });
    expect(res.renamed.map((r) => `${r.from}->${r.to}`).sort()).toEqual(['Error->BillingError', 'Page->BillingPage']);
  });

  it('renames a clashing security scheme inside security requirements too', () => {
    const res = combineSpecs([
      {
        label: 'a.yaml',
        spec: spec({ security: [{ key: [] }], paths: { '/a': { get: ok() } }, components: { securitySchemes: { key: { type: 'http', scheme: 'bearer' } } } }),
      },
      {
        label: 'b.yaml',
        spec: spec({ security: [{ key: [] }], paths: { '/b': { get: ok() } }, components: { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'x-key' } } } }),
      },
    ]);
    expect(res.spec.components.securitySchemes.BKey.type).toBe('apiKey');
    // The two roots disagree once renamed, so each moves onto its own operations.
    expect(res.spec.security).toBeUndefined();
    expect(res.spec.paths['/a'].get.security).toEqual([{ key: [] }]);
    expect(res.spec.paths['/b'].get.security).toEqual([{ BKey: [] }]);
  });

  it('keeps a shared root security when every spec agrees', () => {
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec({ security: [{ key: [] }], paths: { '/a': { get: ok() } } }) },
      { label: 'b.yaml', spec: spec({ security: [{ key: [] }], paths: { '/b': { get: ok() } } }) },
    ]);
    expect(res.spec.security).toEqual([{ key: [] }]);
    expect(res.spec.paths['/b'].get.security).toBeUndefined();
  });

  it('does not invent auth for a spec that had none', () => {
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec({ security: [{ key: [] }], paths: { '/a': { get: ok() } } }) },
      { label: 'public.yaml', spec: spec({ paths: { '/health': { get: ok() } } }) },
    ]);
    expect(res.spec.security).toBeUndefined();
    expect(res.spec.paths['/a'].get.security).toEqual([{ key: [] }]);
    expect(res.spec.paths['/health'].get.security).toBeUndefined();
  });

  it('refuses specs on different servers, which are separate APIs', () => {
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec() },
      { label: 'b.yaml', spec: spec({ servers: [{ url: 'https://billing.acme.com' }] }) },
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('different servers');
  });

  it('treats a trailing slash as the same server, and borrows servers when the first has none', () => {
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec({ servers: undefined }) },
      { label: 'b.yaml', spec: spec({ servers: [{ url: 'https://api.acme.com/' }] }) },
      { label: 'c.yaml', spec: spec() },
    ]);
    expect(res.ok).toBe(true);
    expect(res.spec.servers).toEqual([{ url: 'https://api.acme.com/' }]);
  });

  it('refuses mixing OpenAPI 3.0 and 3.1', () => {
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec() },
      { label: 'b.yaml', spec: spec({ openapi: '3.1.0' }) },
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('3.0');
  });

  it('pushes differing path-level parameters onto operations before sharing a path', () => {
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec({ paths: { '/u/{id}': { parameters: [{ name: 'id', in: 'path', required: true }], get: ok() } } }) },
      { label: 'b.yaml', spec: spec({ paths: { '/u/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], delete: ok() } } }) },
    ]);
    const item = res.spec.paths['/u/{id}'];
    expect(item.parameters).toBeUndefined();
    expect(item.get.parameters).toEqual([{ name: 'id', in: 'path', required: true }]);
    expect(item.delete.parameters[0].schema).toEqual({ type: 'integer' });
  });

  it('unions tags by name', () => {
    const res = combineSpecs([
      { label: 'a.yaml', spec: spec({ tags: [{ name: 'Users', description: 'first' }] }) },
      { label: 'b.yaml', spec: spec({ tags: [{ name: 'Users', description: 'second' }, { name: 'Billing' }] }) },
    ]);
    expect(res.spec.tags).toEqual([{ name: 'Users', description: 'first' }, { name: 'Billing' }]);
  });
});

describe('spec files on disk', () => {
  let dir;
  const write = (rel, body) => {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body));
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oas-combine-'));
    setGitRoot(dir);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('bundles a spec split across files, including refs back into the root', async () => {
    write('api/openapi.yaml', [
      'openapi: 3.0.3',
      'info: { title: Split, version: "1" }',
      'paths:',
      '  /users: { $ref: ./paths/users.yaml }',
      'components:',
      '  schemas:',
      '    Error: { type: object }',
    ].join('\n'));
    write('api/paths/users.yaml', [
      'get:',
      '  responses:',
      '    "200": { description: ok, content: { application/json: { schema: { $ref: ../schemas/User.yaml } } } }',
      '    "400": { description: bad, content: { application/json: { schema: { $ref: "../openapi.yaml#/components/schemas/Error" } } } }',
    ].join('\n'));
    write('api/schemas/User.yaml', 'type: object');

    const res = await loadSpecFile(path.join(dir, 'api/openapi.yaml'), 'api/openapi.yaml');
    expect(res.ok).toBe(true);
    const responses = res.spec.paths['/users'].get.responses;
    expect(responses[200].content['application/json'].schema).toEqual({ type: 'object' });
    expect(responses[400].content['application/json'].schema.$ref).toBe('#/components/schemas/Error');
  });

  it('refuses a spec whose external ref cannot be resolved', async () => {
    write('a.yaml', 'openapi: 3.0.3\ninfo: { title: A, version: "1" }\npaths:\n  /x: { $ref: ./missing.yaml }\n');
    const res = await loadSpecFile(path.join(dir, 'a.yaml'), 'a.yaml');
    expect(res.ok).toBe(false);
  });

  it('converts Swagger 2.0 so it can be combined with OpenAPI 3', async () => {
    write('legacy.json', {
      swagger: '2.0',
      info: { title: 'Legacy', version: '1' },
      host: 'api.acme.com',
      schemes: ['https'],
      paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } },
    });
    write('users.json', spec({ paths: { '/users': { get: ok() } } }));
    const res = await combineSpecFiles({ rootDir: dir, paths: ['users.json', 'legacy.json'], destFile: '.restless/openapi.json' });
    expect(res.ok).toBe(true);
    expect(res.operations).toBe(2);
    const out = JSON.parse(fs.readFileSync(path.join(dir, '.restless/openapi.json'), 'utf8'));
    expect(out.openapi).toBe('3.0.3');
    expect(Object.keys(out.paths).sort()).toEqual(['/pets', '/users']);
  });

  it('leaves every input untouched', async () => {
    write('a.json', spec({ paths: { '/a': { get: ok() } } }));
    write('b.json', spec({ paths: { '/b': { get: ok() } } }));
    const before = ['a.json', 'b.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    await combineSpecFiles({ rootDir: dir, paths: ['a.json', 'b.json'], destFile: '.restless/openapi.json' });
    expect(['a.json', 'b.json'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))).toEqual(before);
  });

  it('never offers our own combined copy as an input', () => {
    write('a.json', spec());
    write('b.json', spec());
    write('.restless/openapi.json', spec());
    expect(combinableSpecs({ rootDir: dir }).sort()).toEqual(['a.json', 'b.json']);
  });
});

describe('summarizeSpecList', () => {
  it('stays one short line', () => {
    expect(summarizeSpecList(['a', 'b'])).toBe('a, b');
    expect(summarizeSpecList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
  });
});
