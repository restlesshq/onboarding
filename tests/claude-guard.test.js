import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setGitRoot } from '../lib/pathGuard.js';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args) => queryMock(...args),
}));

const { default: claude } = await import('../providers/claude.js');

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-guard-')));
  setGitRoot(root);
  queryMock.mockReset();
});
afterEach(() => {
  setGitRoot(null);
  fs.rmSync(root, { recursive: true, force: true });
});

const toolUse = (id, name, input) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, isError) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] },
});

// Plays the SDK: runs the registered PreToolUse hook before "executing" each call.
function sdkRun(calls) {
  return ({ options }) => (async function* () {
    const hook = options.hooks.PreToolUse[0].hooks[0];
    for (const { id, name, input, fails } of calls) {
      yield toolUse(id, name, input);
      const out = await hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id });
      const refused = out.hookSpecificOutput?.permissionDecision === 'deny';
      yield toolResult(id, refused || !!fails);
    }
  })();
}

describe('claude provider root enforcement', () => {
  it('denies a write outside the project through a hook, which runs for auto-allowed tools', async () => {
    let options;
    queryMock.mockImplementation((args) => {
      options = args.options;
      return sdkRun([])(args);
    });
    await claude.run('p', root);

    expect(options.allowedTools).toContain('Edit');
    expect(options.canUseTool).toBeUndefined();
    const out = await options.hooks.PreToolUse[0].hooks[0]({
      tool_name: 'Edit',
      tool_input: { file_path: '/somewhere/else/main.go' },
      tool_use_id: 't1',
    });
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(root);
  });

  it("doesn't load the user's CLAUDE.md or memory, but keeps user settings for auth", async () => {
    let options;
    queryMock.mockImplementation((args) => {
      options = args.options;
      return sdkRun([])(args);
    });
    await claude.run('p', root);

    expect(options.settingSources).toEqual(['user']);
    expect(options.settings.autoMemoryEnabled).toBe(false);
    expect(options.settings.claudeMdExcludes).toContain('**/CLAUDE.md');
  });

  it('reports edits that landed, not ones refused or failed', async () => {
    queryMock.mockImplementation(sdkRun([
      { id: 'a', name: 'Edit', input: { file_path: path.join(root, 'main.go') } },
      { id: 'b', name: 'Edit', input: { file_path: '/elsewhere/main.go' } },
      { id: 'c', name: 'Write', input: { file_path: 'server.go' } },
      { id: 'd', name: 'Edit', input: { file_path: path.join(root, 'stale.go') }, fails: true },
    ]));
    let report;
    await claude.run('p', root, { onReport: (r) => { report = r; } });

    expect(report.edited.sort()).toEqual([path.join(root, 'main.go'), path.join(root, 'server.go')].sort());
    expect(report.denied).toEqual(['/elsewhere/main.go']);
  });
});
