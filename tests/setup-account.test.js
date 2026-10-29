import { beforeEach, describe, expect, it, vi } from 'vitest';

// How setup ends: claimed directly with the welcome screen's session, or the claim link when that fails.
const claim = vi.hoisted(() => ({ result: null, calls: [] }));
vi.mock('../lib/context-auth.js', () => ({
  claimWithSession: vi.fn(async (args) => { claim.calls.push(args); return claim.result; }),
}));
vi.mock('../lib/project-init.js', () => ({
  hashWriteKey: () => 'hash',
  stageForClaim: vi.fn(async ({ setupKey }) => ({ artifacts: { oas: 'ok', endpoints: 3 }, setupKey })),
}));
vi.mock('../lib/settings.js', () => ({ loadSettings: () => ({ apis: [{ rootDir: '.' }] }) }));
const env = vi.hoisted(() => ({ interactive: false }));
vi.mock('../lib/env.js', async (orig) => ({ ...(await orig()), isInteractive: () => env.interactive }));

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function run(extra = {}) {
  const updates = [];
  const { default: setupAccount } = await import('../steps/setup-account.js');
  const result = await setupAccount({
    rootDir: '/nowhere',
    update: (u) => updates.push(u),
    apiKey: 'rk_1',
    projectId: 'p1',
    setupKey: 'sk',
    ...extra,
  });
  const last = updates.at(-1);
  return { result, last, text: strip((last?.message || []).filter(Boolean).join('\n')) };
}

beforeEach(() => {
  claim.calls.length = 0;
  env.interactive = false;
  vi.unstubAllGlobals();
});

describe('setupAccount claim', () => {
  it('claims with the welcome session and finishes without a claim link', async () => {
    claim.result = { ok: true, email: 'me@acme.com', slug: 'acme-api' };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { result, last, text } = await run({ sessionToken: 'welcome-token' });

    expect(claim.calls[0]).toEqual({ projectId: 'p1', setupKey: 'sk', token: 'welcome-token' });
    expect(result).toEqual({ apiKey: 'rk_1', email: 'me@acme.com', slug: 'acme-api' });
    expect(last.status).toBe('done');
    expect(text).toContain('Logged in as me@acme.com');
    expect(text).toContain('/api/acme-api');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the claim link when the direct claim fails', async () => {
    claim.result = { ok: false, reason: 'no-session' };
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { result, text } = await run();

    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/api\/auth\/start$/);
    expect(result).toEqual({ apiKey: 'rk_1' });
    expect(text).toMatch(/\/init\/[0-9a-f]{32}/);
  });

  it('stops waiting on the browser claim after the time limit, and says how to finish', async () => {
    claim.result = { ok: false, reason: 'unreachable' };
    env.interactive = true;
    vi.stubGlobal('fetch', vi.fn(async (url) => new Response(
      JSON.stringify(String(url).includes('/api/auth/check') ? { status: 'pending' } : {}),
      { status: 200 },
    )));

    const { result, last, text } = await run({ claimWaitMs: 10 });

    expect(result).toEqual({ apiKey: 'rk_1' });
    expect(last.status).toBe('failed');
    expect(text).toContain('Stopped waiting for the browser');
    expect(text).toContain('npx');
  });
});
