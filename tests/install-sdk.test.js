import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { nextWiringStatus, describeAiActivity } from '../steps/install-sdk.js';
import { detectNext, nextPluginWiringStatus } from '../lib/next-detect.js';
import { setGitRoot } from '../lib/pathGuard.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'install-sdk-')));
}

describe('nextWiringStatus (Next.js App Router wiring gate)', () => {
  let dir;

  function put(rel, content = '') {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  // A fresh Next 16 App Router app: app/ route handlers + a src/proxy.ts
  // middleware (the file the buggy installer used to clobber).
  function scaffoldAppRouter() {
    put('package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
    put(
      path.join('app', 'pets', 'route.ts'),
      `export async function GET(req) { return Response.json([]); }
export async function POST(req) { return Response.json({}, { status: 201 }); }`,
    );
    put(path.join('src', 'proxy.ts'), 'export function proxy(req) { return; }');
  }

  beforeEach(() => { dir = tmp(); setGitRoot(dir); });
  afterEach(() => { setGitRoot(null); fs.rmSync(dir, { recursive: true, force: true }); });

  it('passes when handlers are wrapped via @restlessai/sdk/next and middleware is untouched', () => {
    scaffoldAppRouter();
    const proxyBefore = fs.readFileSync(path.join(dir, 'src', 'proxy.ts'), 'utf8');

    // Correct wiring: a shared client module + route files that wrap handlers.
    put(
      path.join('lib', 'restless.ts'),
      `import restless from '@restlessai/sdk/next';
export const client = restless(process.env.RESTLESS_KEY);
export const wrap = client.setup(async (req) => ({ apiKey: client.mask(req.headers.get('authorization')) }));`,
    );
    put(
      path.join('app', 'pets', 'route.ts'),
      `import { wrap } from '@/lib/restless';
async function getPets(req) { return Response.json([]); }
async function createPet(req) { return Response.json({}, { status: 201 }); }
export const GET = wrap(getPets);
export const POST = wrap(createPet);`,
    );

    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');

    expect(status.ok).toBe(true);
    // (b) route handlers are wrapped: the handler-side wiring is the lib module.
    expect(status.wiredHandlerSide).toContain(path.join('lib', 'restless.ts'));
    // (a) no middleware file is wired...
    expect(status.wiredMiddleware).toEqual([]);
    // ...and the proxy.ts file on disk is byte-for-byte unchanged.
    expect(fs.readFileSync(path.join(dir, 'src', 'proxy.ts'), 'utf8')).toBe(proxyBefore);
    // Generated code imports the /next adapter and the env ref, not a literal.
    const lib = fs.readFileSync(path.join(dir, 'lib', 'restless.ts'), 'utf8');
    expect(lib).toContain("@restlessai/sdk/next");
    expect(lib).toContain('process.env.RESTLESS_KEY');
  });

  it('fails when the SDK is wired into the Next middleware/proxy file (the bug)', () => {
    scaffoldAppRouter();
    // Reproduce the buggy install: SDK dropped into src/proxy.ts.
    put(
      path.join('src', 'proxy.ts'),
      `import restless from '@restlessai/sdk';
const sdk = restless('rstlss_literalkey');
const restlessMiddleware = sdk.setup(async (req) => ({ apiKey: sdk.mask(req.headers.get('authorization')) }));
export async function proxy(req) { await restlessMiddleware(req); }`,
    );

    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');

    expect(status.ok).toBe(false);
    expect(status.wiredMiddleware).toEqual([path.join('src', 'proxy.ts')]);
    expect(status.wiredHandlerSide).toEqual([]);
  });

  it('fails when nothing has been wired yet', () => {
    scaffoldAppRouter();
    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');
    expect(status.ok).toBe(false);
    expect(status.wired).toEqual([]);
  });
});

// The plugin-style wiring (withRestless + restless.config) has no factory
// call, so it is deliberately INVISIBLE to nextWiringStatus - the composed
// gate in installSdk pairs that status (for the middleware guard and manual
// wraps) with nextPluginWiringStatus (for the plugin files). These tests pin
// the interplay.
describe('nextWiringStatus vs the plugin wiring', () => {
  let dir;

  function put(rel, content = '') {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  beforeEach(() => { dir = tmp(); setGitRoot(dir); });
  afterEach(() => { setGitRoot(null); fs.rmSync(dir, { recursive: true, force: true }); });

  it('a pure plugin install has zero factory wirings but a passing plugin status', () => {
    put('package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
    put(path.join('app', 'pets', 'route.ts'), 'export async function GET() { return Response.json([]); }');
    put('next.config.mjs', `import { withRestless } from '@restlessai/sdk/next';
export default withRestless({});`);
    put('restless.config.ts', `import { defineConfig, mask } from '@restlessai/sdk/next';
export default defineConfig({ setup: async (req) => ({ apiKey: mask(req.headers.get('authorization')) }) });`);

    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');
    // Invisible to the factory-call gate...
    expect(status.wired).toEqual([]);
    expect(status.wiredMiddleware).toEqual([]);
    // ...but fully wired per the plugin gate.
    expect(nextPluginWiringStatus(dir).ok).toBe(true);
  });

  it('a middleware mis-wiring is still caught alongside a plugin install', () => {
    put('package.json', JSON.stringify({ dependencies: { next: '16.0.0' } }));
    put(path.join('app', 'pets', 'route.ts'), 'export async function GET() { return Response.json([]); }');
    put('next.config.mjs', `import { withRestless } from '@restlessai/sdk/next';
export default withRestless({});`);
    put('restless.config.ts', `import { defineConfig } from '@restlessai/sdk/next';
export default defineConfig({ setup: async () => ({}) });`);
    // A stray factory wiring in the middleware file - the crash case.
    put(path.join('src', 'proxy.ts'), `import restless from '@restlessai/sdk/next';
const sdk = restless(process.env.RESTLESS_KEY);
export async function proxy(req) { return sdk.setup(() => ({}))(req); }`);

    const info = detectNext(dir);
    const status = nextWiringStatus(dir, info, 'typescript');
    expect(status.wiredMiddleware).toEqual([path.join('src', 'proxy.ts')]);
    // Plugin status alone says ok - which is exactly why the composed gate
    // in installSdk must ALSO require zero middleware wirings.
    expect(nextPluginWiringStatus(dir).ok).toBe(true);
  });
});

describe('describeAiActivity (what the failure message claims)', () => {
  const dir = '/home/u/wt/app';

  it('says nothing was modified only when nothing was', () => {
    expect(describeAiActivity({}, dir, 'Claude Code')).toEqual([
      'Claude Code read your project but never modified a source file.',
    ]);
  });

  it('names the files it edited, relative to the project', () => {
    const [line] = describeAiActivity({ edited: [`${dir}/cmd/main.go`] }, dir, 'Claude Code');
    expect(line).toBe("Claude Code edited cmd/main.go, but the SDK still isn't wired in.");
  });

  it('names refused writes outside the project by their absolute path', () => {
    const lines = describeAiActivity(
      { edited: [], denied: ['/workspace/app/cmd/main.go', '/workspace/app/go.mod'] },
      dir,
      'Claude Code',
    );
    expect(lines).toEqual([
      'Claude Code tried to change files outside this project (/workspace/app/cmd/main.go, /workspace/app/go.mod), and the CLI refused.',
    ]);
  });

  it('caps a long list', () => {
    const edited = ['a', 'b', 'c', 'd', 'e'].map((f) => `${dir}/${f}.go`);
    const [line] = describeAiActivity({ edited }, dir, 'Codex');
    expect(line).toContain('a.go, b.go, c.go and 2 more');
  });

  it('blames the error, not the agent, when a run died before changing anything', () => {
    expect(describeAiActivity({ error: 'API Error: 529 Overloaded' }, dir, 'Claude Code')).toEqual([
      'Claude Code stopped with an error before changing anything: API Error: 529 Overloaded',
    ]);
  });

  it('still reports edits over an error', () => {
    const lines = describeAiActivity({ edited: [`${dir}/app.js`], error: 'boom' }, dir, 'Claude Code');
    expect(lines).toEqual(["Claude Code edited app.js, but the SDK still isn't wired in."]);
  });
});
