import { describe, it, expect, vi, beforeEach } from 'vitest';

// The provider's whole job here is to turn the SDK's message stream into
// spinner updates, so the SDK is the thing to fake.
const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args) => queryMock(...args),
}));

const { default: claude } = await import('../providers/claude.js');

function stream(...messages) {
  return async function* () {
    for (const m of messages) yield m;
  }();
}

const blockStart = (name) => ({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name } },
});

describe('private tool-free review', () => {
  it('pins the requested model and disables tools, sessions and payload debug logs', async () => {
    const debug = await import('../lib/debug.js');
    debug.init({ argv: ['node', 'restless', 'context'] });
    const secret = 'synthetic-private-candidate';
    queryMock.mockReturnValue(stream(
      { type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: secret }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ));
    const onError = vi.fn();
    await claude.run(secret, '/tmp/proj', { model: 'claude-sonnet-5-5', toolFree: true, sensitive: true, onError });
    expect(queryMock.mock.calls[0][0].options).toMatchObject({
      model: 'claude-sonnet-5-5', tools: [], allowedTools: [], mcpServers: {}, persistSession: false,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(JSON.stringify(debug.snapshot())).not.toContain(secret);
  });

  it('fails review on model substitution or incomplete completion', async () => {
    queryMock.mockReturnValue(stream(
      { type: 'assistant', message: { model: 'unexpected-model', content: [{ type: 'text', text: '[]' }] } },
    ));
    const onError = vi.fn();
    await claude.run('candidate', '/tmp/proj', { model: 'claude-sonnet-5-5', toolFree: true, sensitive: true, onError });
    expect(onError).toHaveBeenCalledWith('review-provider-failure');
  });
});
const delta = (partial_json) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } },
});
const blockStop = () => ({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });

let statuses;
const onStatus = (s) => statuses.push(s);

beforeEach(() => {
  statuses = [];
  queryMock.mockReset();
});

describe('streaming tool-call progress', () => {
  it('names the tool as soon as its block starts, before the input exists', async () => {
    // The reported bug: a long Write left the PREVIOUS tool's label up. The
    // block-start event is what makes the label correct immediately.
    queryMock.mockReturnValue(stream(blockStart('Write')));
    await claude.run('p', '/tmp/proj', { onStatus });

    expect(statuses[0]).toEqual({ phase: 'Writing files', detail: 'Write…' });
  });

  it('reports bytes generated so far while a big argument streams', async () => {
    queryMock.mockReturnValue(stream(
      blockStart('Write'),
      delta('{"file_path":"/tmp/proj/.restless/openapi.json","content":"'),
      delta('x'.repeat(40000)),
    ));
    await claude.run('p', '/tmp/proj', { onStatus });

    const last = statuses[statuses.length - 1];
    expect(last.phase).toBe('Writing files');
    expect(last.detail).toContain('.restless/openapi.json');
    expect(last.detail).toMatch(/KB so far/);
  });

  it('sniffs file_path out of a partial JSON argument', async () => {
    // file_path precedes the bulk `content`, so the file can be named after a
    // few hundred bytes rather than at the end of a 40KB argument.
    queryMock.mockReturnValue(stream(
      blockStart('Write'),
      delta('{"file_path":"/tmp/proj/src/app.js","content":"'),
      delta('y'.repeat(3000)),
    ));
    await claude.run('p', '/tmp/proj', { onStatus });

    expect(statuses[statuses.length - 1].detail).toContain('src/app.js');
  });

  it('shows a basename when the file is outside the run cwd', async () => {
    queryMock.mockReturnValue(stream(
      blockStart('Write'),
      delta('{"file_path":"/somewhere/else/thing.json","content":"'),
      delta('z'.repeat(3000)),
    ));
    await claude.run('p', '/tmp/proj', { onStatus });
    expect(statuses[statuses.length - 1].detail).toContain('thing.json');
    expect(statuses[statuses.length - 1].detail).not.toContain('/somewhere/else');
  });

  it('throttles paints instead of one per delta', async () => {
    // Thousands of deltas arrive for a large argument, and the plan view
    // redraws the whole screen on each spinner update.
    const deltas = Array.from({ length: 500 }, () => delta('abcdefghij'));
    queryMock.mockReturnValue(stream(blockStart('Write'), ...deltas));
    await claude.run('p', '/tmp/proj', { onStatus });

    // One for block-start, then at most a couple of throttled progress paints.
    expect(statuses.length).toBeLessThan(5);
  });

  it('stops tracking at content_block_stop', async () => {
    queryMock.mockReturnValue(stream(
      blockStart('Write'),
      blockStop(),
      // A stray delta with no open block must not throw or repaint.
      delta('{"orphan":true}'),
    ));
    await claude.run('p', '/tmp/proj', { onStatus });
    expect(statuses).toHaveLength(1);
  });

  it('asks the SDK for partial messages', async () => {
    queryMock.mockReturnValue(stream());
    await claude.run('p', '/tmp/proj', { onStatus });
    expect(queryMock.mock.calls[0][0].options.includePartialMessages).toBe(true);
  });

  it('still records completed tool calls, so the profile stays intact', async () => {
    // Enabling streaming must not disturb the `assistant` branch the timing
    // analysis is built on.
    queryMock.mockReturnValue(stream(
      blockStart('Write'),
      delta('{"file_path":"/tmp/proj/a.json"}'),
      blockStop(),
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/proj/a.json' } }] },
      },
    ));
    const debug = await import('../lib/debug.js');
    debug.init({ argv: ['node', 'restless', 'init'] });
    await claude.run('p', '/tmp/proj', { onStatus });

    const types = debug.snapshot().entries.map((x) => x.type);
    expect(types).toContain('ai.tool_use');
  });
});

describe('API retries', () => {
  it('logs a retry and says so, instead of looking like a slow model', async () => {
    // The profiled run had a 49.5s gap with no explanation in the log. This
    // is the event that names it.
    const debug = await import('../lib/debug.js');
    debug.init({ argv: ['node', 'restless', 'init'] });
    queryMock.mockReturnValue(stream({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 4000,
      error_status: 529,
      error: 'server_error',
    }));

    await claude.run('p', '/tmp/proj', { onStatus });

    const retry = debug.snapshot().entries.find((x) => x.type === 'ai.api-retry');
    expect(retry).toMatchObject({ attempt: 2, maxRetries: 5, errorStatus: 529 });
    expect(statuses[0]).toEqual({ phase: 'Retrying', detail: 'API retry 2/5' });
  });
});
