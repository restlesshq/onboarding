import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAI, setProvider, locationPreamble } from '../lib/ai.js';
import { setGitRoot } from '../lib/pathGuard.js';

// Stub provider that captures whatever runAI hands it. Lets us assert on
// the exact prompt the wrapper sends downstream without spinning up a
// real LLM.
function makeStubProvider() {
  const calls = [];
  return {
    name: 'stub',
    async run(prompt, cwd, opts) {
      calls.push({ prompt, cwd, opts });
      return 'stub-result';
    },
    calls,
  };
}

describe('runAI tool-constraints preamble', () => {
  let stub;
  beforeEach(() => {
    stub = makeStubProvider();
    setProvider(stub);
  });
  afterEach(() => {
    // Reset to the default provider for any later tests.
    setProvider('claude');
  });

  it('prepends an Environment block to the user prompt', async () => {
    await runAI('Do the thing.', '/tmp');
    expect(stub.calls).toHaveLength(1);
    const sent = stub.calls[0].prompt;
    expect(sent).toMatch(/^## Environment/);
    expect(sent).toContain('Do the thing.');
  });

  it('forbids python / pip / ruby / gem / perl in the preamble', async () => {
    await runAI('hi', '/tmp');
    const sent = stub.calls[0].prompt;
    expect(sent).toMatch(/Do NOT use[^.]*python/i);
    expect(sent).toContain('python3');
    expect(sent).toContain('pip');
    expect(sent).toContain('ruby');
    expect(sent).toContain('gem');
    expect(sent).toContain('perl');
  });

  it('points the agent at node + POSIX text tools as the allowed set', async () => {
    await runAI('hi', '/tmp');
    const sent = stub.calls[0].prompt;
    expect(sent).toContain('node -e');
    expect(sent).toContain('grep');
    expect(sent).toContain('sed');
    expect(sent).toContain('awk');
    expect(sent).toContain('find');
  });

  it("warns that jq isn't guaranteed either", async () => {
    await runAI('hi', '/tmp');
    expect(stub.calls[0].prompt).toMatch(/jq/);
  });

  it('passes through the cwd unchanged', async () => {
    await runAI('hi', '/some/cwd');
    expect(stub.calls[0].cwd).toBe('/some/cwd');
  });

  it('returns whatever the provider returns', async () => {
    const out = await runAI('hi', '/tmp');
    expect(out).toBe('stub-result');
  });
});

describe('runAI passthrough of maxTurns and onError', () => {
  let stub;
  beforeEach(() => {
    stub = makeStubProvider();
    setProvider(stub);
  });
  afterEach(() => setProvider('claude'));

  it('leaves both undefined when the caller does not ask', () => {
    // Every existing call site omits them, and must keep the provider's own
    // defaults: a 30-turn budget and errors swallowed into a partial result.
    return runAI('p', '/tmp').then(() => {
      expect(stub.calls[0].opts.maxTurns).toBeUndefined();
      expect(stub.calls[0].opts.onError).toBeUndefined();
    });
  });

  it('hands the provider a caller-supplied turn budget', async () => {
    await runAI('p', '/tmp', { maxTurns: 150 });
    expect(stub.calls[0].opts.maxTurns).toBe(150);
  });

  it('hands the provider an onError the provider can invoke', async () => {
    const seen = [];
    await runAI('p', '/tmp', { onError: (e) => seen.push(e) });
    stub.calls[0].opts.onError('Reached maximum number of turns (30)');
    expect(seen).toEqual(['Reached maximum number of turns (30)']);
  });
});

describe('runAI project-location preamble', () => {
  let stub;
  beforeEach(() => {
    stub = makeStubProvider();
    setProvider(stub);
  });
  afterEach(() => {
    setGitRoot(null);
    setProvider('claude');
  });

  it('names the absolute project directory and disowns other checkouts', async () => {
    setGitRoot('/home/u/worktrees/app');
    await runAI('Wire the SDK.', '/home/u/worktrees/app');
    const sent = stub.calls[0].prompt;
    expect(sent).toContain('## Project location');
    expect(sent).toContain('`/home/u/worktrees/app`');
    expect(sent).toMatch(/different checkout/);
    expect(sent.indexOf('## Project location')).toBeLessThan(sent.indexOf('Wire the SDK.'));
  });

  it('names the repository root separately when the run is in a subdirectory', () => {
    const text = locationPreamble('/repo/services/api', '/repo');
    expect(text).toContain('`/repo/services/api`');
    expect(text).toContain('The repository root is `/repo`');
  });

  it('passes onReport through to the provider', async () => {
    const onReport = () => {};
    await runAI('p', '/tmp', { onReport });
    expect(stub.calls[0].opts.onReport).toBe(onReport);
  });
});
