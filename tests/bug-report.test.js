import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

// debug.js and env.js both hold module-level state (the log buffer, the
// cached agent), so each test imports fresh copies.
async function fresh() {
  vi.resetModules();
  const debug = await import('../lib/debug.js');
  const bugReport = await import('../lib/bug-report.js');
  return { debug, bugReport };
}

const AGENT_ENV = ['CLAUDECODE', 'CLAUDE_CODE', 'RESTLESS_AGENT', 'CODEX_SANDBOX', 'RESTLESS_INTERACTIVE', 'RESTLESS_NONINTERACTIVE', 'CI'];
let savedEnv;
let tmpDir;
let out;
let fetchSpy;

beforeEach(() => {
  savedEnv = Object.fromEntries(AGENT_ENV.map((k) => [k, process.env[k]]));
  for (const k of AGENT_ENV) delete process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restless-bug-report-'));
  process.env.RESTLESS_DEBUG_DIR = tmpDir;
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => { out.push(args.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  global.fetch = fetchSpy;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.RESTLESS_DEBUG_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  vi.restoreAllMocks();
});

// eslint-disable-next-line no-control-regex
const plain = () => out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

async function failRun({ debug, bugReport }) {
  bugReport.install();
  debug.init({ argv: ['node', 'restless', 'init'] });
  debug.log('error', { headline: 'boom' });
  await debug.finalize({ exitCode: 1 });
}

describe('isValidEmail', () => {
  it('accepts an ordinary address and rejects the obvious mistakes', async () => {
    const { bugReport } = await fresh();
    expect(bugReport.isValidEmail('dev@example.com')).toBe(true);
    expect(bugReport.isValidEmail('dev@example')).toBe(false);
    expect(bugReport.isValidEmail('dev example.com')).toBe(false);
    expect(bugReport.isValidEmail('')).toBe(false);
    expect(bugReport.isValidEmail(undefined)).toBe(false);
  });
});

describe('gitEmail', () => {
  it('reads user.email from the repo the run is in', async () => {
    const { bugReport } = await fresh();
    execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'repo@example.com'], { cwd: tmpDir });
    expect(bugReport.gitEmail(tmpDir)).toBe('repo@example.com');
  });

  it("returns '' rather than throwing when there's no repo to ask", async () => {
    const { bugReport } = await fresh();
    expect(bugReport.gitEmail(path.join(tmpDir, 'missing'))).toBe('');
  });
});

describe('askEmail (non-interactive)', () => {
  it('confirms the suggestion when nobody types over it', async () => {
    process.env.RESTLESS_NONINTERACTIVE = '1';
    const { bugReport } = await fresh();
    expect(await bugReport.askEmail('dev@example.com')).toBe('dev@example.com');
  });

  it("sends no email when there's nothing to suggest", async () => {
    process.env.RESTLESS_NONINTERACTIVE = '1';
    const { bugReport } = await fresh();
    expect(await bugReport.askEmail('')).toBe('');
  });
});

describe('the offer on a failed run', () => {
  it('tells a coding agent to ask its user, and sends nothing itself', async () => {
    process.env.CLAUDECODE = '1';
    const mods = await fresh();
    await failRun(mods);

    const text = plain();
    expect(text).toContain('For Claude Code: this run failed.');
    expect(text).toContain('Do not send one without asking them.');
    expect(text).toContain('the full AI trace');
    expect(text).toMatch(/submit-debug ".+-init\.json" --email <their email>/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('points the agent at the exact log the failed run wrote', async () => {
    process.env.CLAUDECODE = '1';
    const mods = await fresh();
    await failRun(mods);

    const [file] = fs.readdirSync(tmpDir);
    expect(plain()).toContain(`"${path.join(tmpDir, file)}"`);
  });

  it('asks the agent for a note, since the log holds none of its own work', async () => {
    process.env.CLAUDECODE = '1';
    const mods = await fresh();
    await failRun(mods);

    const text = plain();
    expect(text).toMatch(/--email <their email> --note "<what you changed and tried>"/);
    expect(text).toContain('the note is what tells');
  });

  it('tells the agent setup is unfinished when the run exits 0 short of onboarding', async () => {
    process.env.CLAUDECODE = '1';
    const { debug, bugReport } = await fresh();
    bugReport.install();
    debug.init({ argv: ['node', 'restless', 'init', '--self-drive'] });
    debug.markUnfinished("the SDK isn't capturing requests yet");
    await debug.finalize({ exitCode: 0 });

    expect(plain()).toContain("setup didn't finish (the SDK isn't capturing requests yet), so your user isn't onboarded yet.");
  });

  it('has the agent try the fix first when the failure is one it should retry', async () => {
    process.env.CLAUDECODE = '1';
    const { debug, bugReport } = await fresh();
    bugReport.install();
    debug.init({ argv: ['node', 'restless', 'verify'] });
    debug.reportAfterRetry();
    await debug.finalize({ exitCode: 1 });

    const text = plain();
    expect(text).toContain('Try the fix above first.');
    expect(text).toContain("still can't get past this, offer your user a bug report");
  });

  it('leaves CI one line to send it with, and no instructions for an agent', async () => {
    process.env.CI = '1';
    const mods = await fresh();
    await failRun(mods);

    const text = plain();
    expect(text).toContain("To send this run's log to the Restless team:");
    expect(text).not.toContain('For ');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the call link', () => {
  it("goes below the offer when a fatal error ends the run, and prints once", async () => {
    process.env.CLAUDECODE = '1';
    const { debug, bugReport } = await fresh();
    const { fatalError } = await import('../lib/errors.js');
    vi.spyOn(process, 'exit').mockImplementation(() => {});
    bugReport.install();
    debug.init({ argv: ['node', 'restless', 'init'] });
    try { fatalError("We couldn't wire the SDK"); } catch {}
    await debug.finalize({ exitCode: 1 });

    const text = plain();
    const headline = text.indexOf("We couldn't wire the SDK");
    const offerAt = text.indexOf('Bug report');
    const stuck = text.indexOf('Stuck?');
    expect(headline).toBeGreaterThanOrEqual(0);
    expect(offerAt).toBeGreaterThan(headline);
    expect(stuck).toBeGreaterThan(offerAt);
    expect(text.match(/Stuck\?/g)).toHaveLength(1);
  });

  it('still prints when the run ends without an offer after all', async () => {
    process.env.CLAUDECODE = '1';
    const { debug, bugReport } = await fresh();
    bugReport.install();
    debug.init({ argv: ['node', 'restless', 'init'] });
    expect(bugReport.holdHelpForOffer()).toBe(true);
    debug.skipReport('test');
    await debug.finalize({ exitCode: 1 });

    expect(plain()).not.toContain('Bug report');
    expect(plain().match(/Stuck\?/g)).toHaveLength(1);
  });

  it('is not held back under --debug, which uploads instead of asking', async () => {
    const { debug, bugReport } = await fresh();
    bugReport.install();
    debug.init({ argv: ['node', 'restless', 'init', '--debug'] });
    expect(bugReport.holdHelpForOffer()).toBe(false);
  });
});
