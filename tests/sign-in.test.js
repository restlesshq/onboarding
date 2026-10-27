import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

// Opening a browser is a side effect on the user's desktop, so it must only follow an explicit keypress.
const calls = vi.hoisted(() => []);
const picked = vi.hoisted(() => ({ items: null }));
vi.mock('child_process', async (orig) => ({
  ...(await orig()),
  execSync: vi.fn((cmd) => { calls.push(`exec:${cmd.split(' ')[0]}`); }),
}));
vi.mock('../lib/ui.js', async (orig) => ({
  ...(await orig()),
  waitForKey: vi.fn(async () => { calls.push('key'); return '\r'; }),
  startSpinner: () => ({ stop() {}, update() {} }),
  singleSelect: vi.fn(async (items) => { picked.items = items; return 0; }),
}));

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// One home for the file: the module resolves the token path once, at first import.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-in-'));
const savedHome = process.env.HOME;
beforeAll(() => { process.env.HOME = home; });
afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

let server, saved, projects;
beforeEach(async () => {
  calls.length = 0;
  picked.items = null;
  projects = [];
  saved = { ...process.env };
  fs.rmSync(path.join(home, '.restless'), { recursive: true, force: true });
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/auth/cli/projects')) return res.end(JSON.stringify({ projects }));
    if (req.url.startsWith('/api/auth/cli/check')) {
      return res.end(JSON.stringify({ status: 'authorized', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
    }
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.RESTLESS_SITE_URL = `http://127.0.0.1:${server.address().port}`;
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.env = saved;
  await new Promise((r) => server.close(r));
});

describe('signIn', () => {
  it('at a terminal, opens the browser only after Enter', async () => {
    const { signIn } = await import('../lib/context-auth.js');
    expect(await signIn({ interactive: true })).toMatchObject({ ok: true, cached: false });
    expect(calls.indexOf('key')).toBeGreaterThanOrEqual(0);
    expect(calls.findIndex((c) => c.startsWith('exec:'))).toBeGreaterThan(calls.indexOf('key'));
  });

  it('for a coding agent, prints the link and never opens a browser', async () => {
    const { signIn } = await import('../lib/context-auth.js');
    const printed = [];
    console.log.mockImplementation((...a) => printed.push(a.join(' ')));
    expect(await signIn({ interactive: false, linkOnly: true })).toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    expect(printed.join('\n')).toContain('/api/auth/cli?token=');
  });

  it('with neither, refuses without starting a sign-in', async () => {
    const { signIn } = await import('../lib/context-auth.js');
    expect(await signIn({ interactive: false })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe('pickProject', () => {
  it('shows names only, with the slug only to tell same-named projects apart', async () => {
    projects = [
      { projectId: '982c01bc-636a-4fe1-a162-1312128b9df0', slug: 'sampling-test', name: 'Sampling Test' },
      { projectId: '8068f443-953f-4302-8807-3a16739c1a77', slug: 'node-test-api', name: 'node-test-api' },
      { projectId: 'af4f5a49-7131-4f64-96f4-da1779b5ea3a', slug: 'node-test-api-2', name: 'node-test-api' },
    ];
    const { pickProject } = await import('../lib/context-auth.js');
    await pickProject({ token: 't', interactive: true });
    expect(picked.items.map((i) => ({ label: i.label, hint: strip(i.hint) }))).toEqual([
      { label: 'Sampling Test', hint: '' },
      { label: 'node-test-api', hint: 'node-test-api' },
      { label: 'node-test-api', hint: 'node-test-api-2' },
    ]);
    expect(JSON.stringify(picked.items)).not.toContain('982c01bc');
  });

  it('skips the question when there is only one project', async () => {
    projects = [{ projectId: 'm1', slug: 'pets', name: 'Pets' }];
    const { pickProject } = await import('../lib/context-auth.js');
    expect(await pickProject({ token: 't', interactive: true })).toMatchObject({ ok: true, project: { slug: 'pets' } });
    expect(picked.items).toBeNull();
  });
});
