import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

// Opening a browser is a side effect on the user's desktop, so it must only follow an explicit keypress.
const calls = vi.hoisted(() => []);
vi.mock('child_process', async (orig) => ({
  ...(await orig()),
  execSync: vi.fn((cmd) => { calls.push(`exec:${cmd.split(' ')[0]}`); }),
}));
vi.mock('../lib/ui.js', async (orig) => ({
  ...(await orig()),
  waitForKey: vi.fn(async () => { calls.push('key'); return '\r'; }),
  startSpinner: () => ({ stop() {}, update() {} }),
}));

// One home for the file: the module resolves the token path once, at first import.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-in-'));
const savedHome = process.env.HOME;
beforeAll(() => { process.env.HOME = home; });
afterAll(() => {
  process.env.HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

let server, saved;
beforeEach(async () => {
  calls.length = 0;
  saved = { ...process.env };
  fs.rmSync(path.join(home, '.restless'), { recursive: true, force: true });
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
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
