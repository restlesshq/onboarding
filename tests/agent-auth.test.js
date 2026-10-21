import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args) => queryMock(...args),
}));

const fatalErrorMock = vi.fn(() => { throw new Error('fatal'); });
vi.mock('../lib/errors.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fatalError: (...args) => fatalErrorMock(...args),
}));

const { default: claude } = await import('../providers/claude.js');
const { runAI, setProvider } = await import('../lib/ai.js');
const { AgentAuthError } = await import('../lib/errors.js');
const { isSignedOut } = await import('../lib/claude-auth.js');

// What a logged-out Claude Code actually emits (captured from a real run).
function loggedOutStream() {
  return async function* () {
    yield {
      type: 'assistant',
      error: 'authentication_failed',
      message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
    };
    yield { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' };
    throw new Error('Claude Code returned an error result: Not logged in · Please run /login');
  }();
}

beforeEach(() => {
  queryMock.mockReset();
  fatalErrorMock.mockClear();
});

describe('claude provider auth failures', () => {
  it('throws AgentAuthError instead of returning the login text as a result', async () => {
    queryMock.mockReturnValue(loggedOutStream());
    const err = await claude.run('p', '/tmp/proj').catch((e) => e);
    expect(err).toBeInstanceOf(AgentAuthError);
    expect(err.headline).toBe("Claude Code isn't logged in.");
    expect(err.details[0]).toBe('Claude Code said: Not logged in · Please run /login');
  });

  it('keeps swallowing every other SDK error', async () => {
    queryMock.mockReturnValue(async function* () {
      yield { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'slow down' }] } };
      throw new Error('Reached maximum number of turns');
    }());
    const onError = vi.fn();
    await expect(claude.run('p', '/tmp/proj', { onError })).resolves.toBe('slow down');
    expect(onError).toHaveBeenCalledWith('Reached maximum number of turns');
  });
});

describe('runAI on an auth failure', () => {
  afterEach(() => setProvider('claude'));

  it('reports it as fatal and never returns control to the caller', async () => {
    setProvider({ name: 'stub', run: async () => { throw new AgentAuthError('codex'); } });
    let settled = false;
    runAI('p', '/tmp').then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(fatalErrorMock).toHaveBeenCalledWith("Codex isn't logged in.", [
      'Run `codex login` (or set OPENAI_API_KEY),',
      'then run this command again.',
    ]);
  });

  it('still rethrows ordinary errors', async () => {
    setProvider({ name: 'stub', run: async () => { throw new Error('boom'); } });
    await expect(runAI('p', '/tmp')).rejects.toThrow('boom');
    expect(fatalErrorMock).not.toHaveBeenCalled();
  });
});

describe('isSignedOut (preflight verdict from accountInfo)', () => {
  // Shapes captured from Claude Code 2.x with each kind of credential.
  it('flags no credential at all', () => {
    expect(isSignedOut({ tokenSource: 'none', apiProvider: 'firstParty' })).toBe(true);
  });

  it('passes an OAuth login', () => {
    expect(isSignedOut({ email: 'a@b.c', subscriptionType: 'Claude Team', apiProvider: 'firstParty' })).toBe(false);
  });

  it('passes an API key with no OAuth token', () => {
    expect(isSignedOut({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })).toBe(false);
  });

  it('passes third-party backends, which authenticate outside Claude Code', () => {
    expect(isSignedOut({ apiProvider: 'bedrock' })).toBe(false);
  });

  it('fails open on no answer', () => {
    expect(isSignedOut(null)).toBe(false);
  });
});
