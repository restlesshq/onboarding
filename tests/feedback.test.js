import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { parseFeedbackArgs, describeOutcome, postFeedback, runFeedback } from '../lib/feedback.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'restless.js');

const UUID = '3f1c2a7e-8d4b-4c1e-9a2e-5b6f7c8d9e0f';
const argv = (...rest) => ['node', 'restless', 'feedback', ...rest];

// Strip ANSI so assertions read the words, not the colours.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function response(status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  };
}

let out;
beforeEach(() => {
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { out.push(plain(args.join(' '))); });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseFeedbackArgs', () => {
  it('reads the id and every flag', () => {
    const args = parseFeedbackArgs(argv(UUID, '--message', 'confusing', '--context', 'GET /pets', '--email', 'dev@example.com', '--json'));
    expect(args).toEqual({ id: UUID, message: 'confusing', context: 'GET /pets', email: 'dev@example.com', json: true });
  });

  it('strips a display prefix from the id', () => {
    expect(parseFeedbackArgs(argv(`pets-${UUID}`, '--message', 'x')).id).toBe(UUID);
  });

  it('leaves a non-uuid id alone for the server to refuse', () => {
    expect(parseFeedbackArgs(argv('not-an-id', '--message', 'x')).id).toBe('not-an-id');
  });

  it('is a usage error with no id, or a flag as the id', () => {
    expect(parseFeedbackArgs(argv()).error).toMatch(/missing request id/i);
    expect(parseFeedbackArgs(argv('--message', 'x')).error).toMatch(/missing request id/i);
  });

  it('is a usage error when a flag has no value', () => {
    expect(parseFeedbackArgs(argv(UUID, '--message')).error).toMatch(/--message needs a value/);
    expect(parseFeedbackArgs(argv(UUID, '--message', '--json')).error).toMatch(/--message needs a value/);
    expect(parseFeedbackArgs(argv(UUID, '--email')).error).toMatch(/--email needs a value/);
  });

  it('refuses an email that does not look like one', () => {
    expect(parseFeedbackArgs(argv(UUID, '--message', 'x', '--email', 'nope')).error).toMatch(/doesn't look like an email/);
  });

  it('defaults the optional fields to empty', () => {
    const args = parseFeedbackArgs(argv(UUID));
    expect(args).toEqual({ id: UUID, message: '', context: '', email: '', json: false });
  });
});

describe('postFeedback', () => {
  it('posts the note with the CLI user agent and only the fields given', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true, message: 'Thanks' }));
    const res = await postFeedback({ id: UUID, message: 'hi', context: '', email: '', version: '1.2.3', fetchImpl, siteUrl: 'https://x.test' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true, message: 'Thanks' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://x.test/api/logs/${UUID}/feedback`);
    expect(init.method).toBe('POST');
    expect(init.headers['User-Agent']).toBe('restless-cli/1.2.3');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ message: 'hi' });
  });

  it('includes context and email when present', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true }));
    await postFeedback({ id: UUID, message: 'hi', context: 'GET /pets', email: 'dev@example.com', version: '1', fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ message: 'hi', context: 'GET /pets', email: 'dev@example.com' });
  });

  it('reads Retry-After off a 429', async () => {
    const fetchImpl = vi.fn(async () => response(429, { error: 'slow down' }, { 'retry-after': '42' }));
    const res = await postFeedback({ id: UUID, message: 'hi', version: '1', fetchImpl });
    expect(res).toMatchObject({ status: 429, retryAfter: 42 });
  });

  it('never throws when the server is unreachable', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const res = await postFeedback({ id: UUID, message: 'hi', version: '1', fetchImpl });
    expect(res).toEqual({ status: 0, error: 'unreachable' });
  });
});

describe('describeOutcome', () => {
  const line = (r) => plain(describeOutcome(r).line);

  it('201 is sent', () => {
    expect(describeOutcome({ status: 201, body: { ok: true } })).toMatchObject({ ok: true });
    expect(line({ status: 201, body: { ok: true } })).toMatch(/sent/i);
  });

  it("404 says the id didn't match and to check it was copied whole", () => {
    const r = describeOutcome({ status: 404, body: { error: 'Log not found' } });
    expect(r.ok).toBe(false);
    expect(r.skipReport).toBeTruthy();
    expect(plain(r.line)).toMatch(/didn't match a logged request/);
    expect(plain(r.line)).toMatch(/copied whole/);
  });

  it('400 and 500 repeat what the server said, and are not skipped as reports', () => {
    const bad = describeOutcome({ status: 400, body: { error: 'Missing `message`.' } });
    expect(plain(bad.line)).toMatch(/rejected.*Missing `message`\./);
    expect(bad.skipReport).toBeUndefined();
    const boom = describeOutcome({ status: 500, body: { error: 'It was not saved.' } });
    expect(plain(boom.line)).toMatch(/nothing was sent.*It was not saved\./);
    expect(boom.skipReport).toBeUndefined();
  });

  it('413 says to shorten it', () => {
    expect(line({ status: 413, body: { error: 'Body too large' } })).toMatch(/too long.*32KB/);
  });

  it('429 says when to retry', () => {
    expect(line({ status: 429, body: {}, retryAfter: 30 })).toMatch(/Try again in 30 seconds/);
    expect(line({ status: 429, body: {}, retryAfter: null })).toMatch(/Try again in a minute/);
  });

  it('unreachable says to check the connection', () => {
    expect(line({ status: 0, error: 'timed out' })).toMatch(/Couldn't reach Restless \(timed out\)/);
  });

  it('anything else names the status', () => {
    expect(line({ status: 502, body: null })).toMatch(/HTTP 502/);
  });
});

describe('runFeedback under an agent (non-interactive)', () => {
  const noPrompts = {
    ask: vi.fn(async () => { throw new Error('prompted'); }),
  };

  it('with no --message tells the agent what to collect and the command, exits 1, sends nothing, prompts nothing', async () => {
    const fetchImpl = vi.fn();
    const r = await runFeedback(argv(`pets-${UUID}`), { interactive: false, agent: true, fetchImpl, prompts: noPrompts });
    expect(r.exitCode).toBe(1);
    expect(r.skipReport).toMatch(/Missing --message/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(noPrompts.ask).not.toHaveBeenCalled();
    const lines = out.filter((l) => l.trim());
    // Addressed to the agent: what to ask its user, and the command to run.
    expect(lines[0]).toMatch(/^\s*For .*ask your user what to tell/);
    expect(lines.join('\n')).toMatch(/their email/);
    // (The CLI name is read off argv, so under vitest it isn't "restless".)
    expect(lines.join('\n')).toMatch(new RegExp(`npx \\S+ feedback ${UUID} --message "<their feedback>" --email <their email>`));
    expect(lines.join('\n')).toMatch(/--context/);
    // It sits in the agent's context and the user's transcript: keep it short.
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it('with no --message in CI or a pipe (no agent) says so in one line', async () => {
    const fetchImpl = vi.fn();
    const r = await runFeedback(argv(UUID), { interactive: false, agent: false, fetchImpl, prompts: noPrompts });
    expect(r.exitCode).toBe(1);
    expect(r.skipReport).toMatch(/Missing --message/);
    expect(fetchImpl).not.toHaveBeenCalled();
    const lines = out.filter((l) => l.trim());
    expect(lines[0]).toMatch(/Missing --message/);
    expect(lines).toHaveLength(2); // the reason and the usage line
  });

  it('with --message sends it and prints one outcome line', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true, message: 'Thanks' }));
    const r = await runFeedback(argv(`pets-${UUID}`, '--message', 'confusing'), { version: '9.9.9', interactive: false, agent: true, fetchImpl, prompts: noPrompts });
    expect(r.exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toMatch(`/api/logs/${UUID}/feedback`);
    expect(fetchImpl.mock.calls[0][1].headers['User-Agent']).toBe('restless-cli/9.9.9');
    expect(noPrompts.ask).not.toHaveBeenCalled();
    expect(out.filter((l) => l.trim())).toEqual([expect.stringMatching(/✓ Feedback sent/)]);
  });

  it('maps a 404 to exit 1 and the copied-whole hint', async () => {
    const fetchImpl = vi.fn(async () => response(404, { error: 'Log not found' }));
    const r = await runFeedback(argv(UUID, '--message', 'x'), { interactive: false, fetchImpl, prompts: noPrompts });
    expect(r.exitCode).toBe(1);
    expect(r.skipReport).toMatch(/not found/);
    expect(out.join('\n')).toMatch(/copied whole/);
  });

  it('--json prints the server JSON verbatim and exits by status', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true, message: 'Thanks' }));
    const r = await runFeedback(argv(UUID, '--message', 'x', '--json'), { interactive: false, fetchImpl, prompts: noPrompts });
    expect(r.exitCode).toBe(0);
    expect(out).toEqual(['{"ok":true,"message":"Thanks"}']);

    out.length = 0;
    const fail = vi.fn(async () => response(404, { error: 'Log not found' }));
    const r2 = await runFeedback(argv(UUID, '--message', 'x', '--json'), { interactive: false, fetchImpl: fail, prompts: noPrompts });
    expect(r2.exitCode).toBe(1);
    expect(r2.skipReport).toBeTruthy(); // nothing may print after the JSON
    expect(out).toEqual(['{"error":"Log not found"}']);
  });

  it('--json reports a usage error and an unreachable server as JSON too, even under an agent', async () => {
    const r = await runFeedback(argv(UUID, '--json'), { interactive: false, agent: true, fetchImpl: vi.fn(), prompts: noPrompts });
    expect(r.exitCode).toBe(1);
    expect(out).toHaveLength(1); // the agent instructions would corrupt the JSON
    expect(JSON.parse(out[0]).error).toMatch(/Missing --message/);

    out.length = 0;
    const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const r2 = await runFeedback(argv(UUID, '--message', 'x', '--json'), { interactive: false, fetchImpl: down, prompts: noPrompts });
    expect(r2.exitCode).toBe(1);
    expect(JSON.parse(out[0])).toMatchObject({ status: 0, error: expect.stringMatching(/Couldn't reach/) });
  });

  it('--json never prompts, even at a terminal', async () => {
    const r = await runFeedback(argv(UUID, '--json'), { interactive: true, fetchImpl: vi.fn(), prompts: noPrompts });
    expect(r.exitCode).toBe(1);
    expect(noPrompts.ask).not.toHaveBeenCalled();
  });
});

describe('runFeedback at a terminal (interactive)', () => {
  function prompts({ answers = [] } = {}) {
    const queue = [...answers];
    return {
      ask: vi.fn(async (prompt, { defaultValue = '' } = {}) => {
        const next = queue.shift();
        return next === undefined ? defaultValue : next;
      }),
    };
  }

  it('asks for the message and the email, then sends with no confirm', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true }));
    const p = prompts({ answers: ['the pagination params are confusing', 'dev@example.com'] });
    const r = await runFeedback(argv(UUID), { interactive: true, agent: false, fetchImpl, prompts: p });
    expect(r.exitCode).toBe(0);
    expect(p.ask).toHaveBeenCalledTimes(2);
    expect(plain(p.ask.mock.calls[0][0])).toMatch(/Your feedback/);
    expect(plain(p.ask.mock.calls[1][0])).toMatch(/Your email/);

    // No summary and no "Send it?": the email answer is the last thing
    // before the request leaves.
    const text = out.join('\n');
    expect(text).not.toMatch(/what will be sent/i);
    expect(text).not.toMatch(/Send it\?/);
    expect(p.ask.mock.invocationCallOrder[1]).toBeLessThan(fetchImpl.mock.invocationCallOrder[0]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ message: 'the pagination params are confusing', email: 'dev@example.com' });
    expect(text).toMatch(/✓ Feedback sent/);
    expect(text).toMatch(/they'll write to dev@example.com/);
  });

  it('a blank email sends none', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true }));
    const p = prompts({ answers: ['hello', ''] });
    await runFeedback(argv(UUID), { interactive: true, agent: false, fetchImpl, prompts: p });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ message: 'hello' });
    expect(out.join('\n')).not.toMatch(/write to/);
  });

  it('asks nothing when --message and --email are both given, and just sends', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true }));
    const p = prompts();
    await runFeedback(argv(UUID, '--message', 'given', '--email', 'dev@example.com'), { interactive: true, agent: false, fetchImpl, prompts: p });
    expect(p.ask).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('asks only for the email when --message is given', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true }));
    const p = prompts({ answers: ['dev@example.com'] });
    await runFeedback(argv(UUID, '--message', 'given'), { interactive: true, agent: false, fetchImpl, prompts: p });
    expect(p.ask).toHaveBeenCalledTimes(1);
    expect(plain(p.ask.mock.calls[0][0])).toMatch(/Your email/);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ message: 'given', email: 'dev@example.com' });
  });

  it('gives up after three blank messages without sending', async () => {
    const fetchImpl = vi.fn();
    const p = prompts({ answers: ['', '  ', ''] });
    const r = await runFeedback(argv(UUID), { interactive: true, agent: false, fetchImpl, prompts: p });
    expect(r.exitCode).toBe(0);
    expect(p.ask).toHaveBeenCalledTimes(3);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/Nothing was sent/);
  });

  it('re-asks for an email that does not look like one', async () => {
    const fetchImpl = vi.fn(async () => response(201, { ok: true }));
    const p = prompts({ answers: ['hello', 'nope', 'dev@example.com'] });
    await runFeedback(argv(UUID), { interactive: true, agent: false, fetchImpl, prompts: p });
    expect(out.join('\n')).toMatch(/doesn't look like an email/);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).email).toBe('dev@example.com');
  });
});

// The real entry point, non-interactive, with no id and then no message:
// proves `feedback` is dispatched and exits non-zero before touching the
// network. The network paths are covered above with an injected fetch.
describe('npx restless feedback (real CLI, no network)', () => {
  let debugDir;
  beforeEach(() => {
    debugDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-feedback-'));
  });
  afterEach(() => {
    try { fs.rmSync(debugDir, { recursive: true, force: true }); } catch {}
  });

  // `RESTLESS_AGENT` names an agent; `env` can override it to test the
  // agentless non-interactive path (CI, a pipe).
  function run(args, env = {}) {
    return spawnSync(process.execPath, [CLI, 'feedback', ...args], {
      encoding: 'utf8',
      env: { ...process.env, RESTLESS_DEBUG_DIR: debugDir, RESTLESS_NONINTERACTIVE: '1', RESTLESS_AGENT: 'claude', RESTLESS_TELEMETRY: 'off', DO_NOT_TRACK: '1', RESTLESS_SITE_URL: 'http://127.0.0.1:9', ...env },
    });
  }

  it('exits 1 with the usage line when the id is missing', () => {
    const res = run([]);
    expect(res.status).toBe(1);
    expect(plain(res.stdout)).toMatch(/Missing request id/);
    expect(plain(res.stdout)).toMatch(/Usage: npx restless feedback <request-id>/);
  });

  it('tells an agent what to collect, in a few lines, when it gives no --message', () => {
    const res = run([UUID]);
    expect(res.status).toBe(1);
    const lines = plain(res.stdout).split('\n').filter((l) => l.trim());
    expect(lines[0]).toMatch(/^\s*For Claude Code: ask your user/);
    expect(lines.join('\n')).toMatch(new RegExp(`npx restless feedback ${UUID} --message`));
    expect(lines.length).toBeLessThanOrEqual(4);
  });

  it('exits 1 in one line when no agent and no terminal gives no --message', () => {
    const res = run([UUID], { RESTLESS_AGENT: '', CLAUDECODE: '', CLAUDE_CODE: '', CODEX_SANDBOX: '', CODEX_SANDBOX_NETWORK_DISABLED: '', CI: '1' });
    expect(res.status).toBe(1);
    const lines = plain(res.stdout).split('\n').filter((l) => l.trim());
    expect(lines[0]).toMatch(/Missing --message/);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it('is listed in help', () => {
    const help = execFileSync(process.execPath, [CLI, 'help'], { encoding: 'utf8', env: { ...process.env, RESTLESS_DEBUG_DIR: debugDir, DO_NOT_TRACK: '1' } });
    expect(plain(help)).toMatch(/feedback <request-id>/);
    expect(plain(help)).toMatch(/--message <text>/);
  });
});
