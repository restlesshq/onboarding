import { describe, it, expect, beforeEach, vi } from 'vitest';

// timings.js and debug.js both hold module-level singletons (the CLI is
// one-shot), and timings registers a finalize hook on debug at import time -
// so a test that wants clean state has to re-import BOTH together, or the
// fresh timings module would be writing into a stale debug buffer.
async function fresh() {
  vi.resetModules();
  const debug = await import('../lib/debug.js');
  const timings = await import('../lib/timings.js');
  const report = await import('../lib/timings-report.js');
  debug.init({ argv: ['node', 'restless', 'init'] });
  return { debug, timings, report };
}

/** Every `timing` entry in the log, oldest first. */
function spans(debug) {
  return debug.snapshot().entries.filter((e) => e.type === 'timing');
}

let mod;
beforeEach(async () => {
  mod = await fresh();
});

describe('span recording', () => {
  it('emits one timing entry per closed span, with a duration', () => {
    const { debug, timings } = mod;
    const end = timings.start('a thing', { kind: timings.KINDS.EXEC });
    expect(spans(debug)).toHaveLength(0); // nothing until it closes
    end();

    const [entry] = spans(debug);
    expect(entry.label).toBe('a thing');
    expect(entry.kind).toBe('exec');
    expect(entry.parent).toBe(null);
    expect(typeof entry.durationMs).toBe('number');
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('parents a span to whatever was open when it started', () => {
    const { debug, timings } = mod;
    const endOuter = timings.start('outer', { kind: timings.KINDS.STEP });
    const endInner = timings.start('inner', { kind: timings.KINDS.AI });
    endInner();
    endOuter();

    const [inner, outer] = spans(debug);
    expect(inner.label).toBe('inner');
    expect(inner.parent).toBe(outer.span);
    expect(outer.parent).toBe(null);
  });

  it('carries per-call metadata onto the entry', () => {
    const { debug, timings } = mod;
    timings.start('probe: npm', { kind: timings.KINDS.EXEC, language: 'javascript' })({ hit: true });
    const [entry] = spans(debug);
    expect(entry.language).toBe('javascript');
    expect(entry.hit).toBe(true);
  });

  it('ignores a second close so a finally cannot double-count', () => {
    const { debug, timings } = mod;
    const end = timings.start('once');
    end();
    end();
    expect(spans(debug)).toHaveLength(1);
  });

  it('handles spans that close out of order', () => {
    // Real case: pollForLandedLog runs while the UI is blocked in
    // waitForKey, so the inner span outlives the outer one. A strict stack
    // would mis-parent or corrupt here.
    const { debug, timings } = mod;
    const endFirst = timings.start('first', { kind: timings.KINDS.WAIT });
    const endSecond = timings.start('second', { kind: timings.KINDS.NET });
    endFirst();
    endSecond();

    const byLabel = Object.fromEntries(spans(debug).map((e) => [e.label, e]));
    expect(byLabel.second.parent).toBe(byLabel.first.span);
    expect(spans(debug)).toHaveLength(2);
  });

  it('flushes still-open spans, marking them incomplete', () => {
    const { debug, timings } = mod;
    timings.start('interrupted step', { kind: timings.KINDS.STEP });
    timings.closeOpenSpans('run-ended');

    const [entry] = spans(debug);
    expect(entry.label).toBe('interrupted step');
    expect(entry.incomplete).toBe('run-ended');
  });

  it('flushes open spans on finalize, without a caller having to ask', async () => {
    const { debug, timings } = mod;
    timings.start('still running', { kind: timings.KINDS.AI });
    await debug.finalize({ exitCode: 0 });
    expect(spans(debug).map((e) => e.label)).toContain('still running');
  });
});

describe('measure helpers', () => {
  it('returns the wrapped value and records a span', async () => {
    const { debug, timings } = mod;
    const value = await timings.measure('async work', async () => 42, { kind: timings.KINDS.NET });
    expect(value).toBe(42);
    expect(spans(debug)[0].label).toBe('async work');
  });

  it('records the span and re-throws when the wrapped call fails', async () => {
    const { debug, timings } = mod;
    await expect(
      timings.measure('failing work', async () => { throw new Error('boom'); }),
    ).rejects.toThrow('boom');
    expect(spans(debug)[0].label).toBe('failing work');
  });

  it('measureSync passes the value through', () => {
    const { debug, timings } = mod;
    expect(timings.measureSync('sync work', () => 'ok')).toBe('ok');
    expect(spans(debug)[0].label).toBe('sync work');
  });
});

// ── The report ───────────────────────────────────────────────────────────
// Built from a hand-written log rather than by running spans, so the
// assertions are on exact millisecond arithmetic.
function log(timingEntries, { command = 'init', startAt = 1_000_000 } = {}) {
  let at = startAt;
  const entries = [{ at, type: 'init' }];
  for (const t of timingEntries) {
    at += t.durationMs;
    entries.push({ at, type: 'timing', parent: null, kind: 'scan', ...t });
  }
  return {
    meta: { command, startedAt: new Date(startAt).toISOString() },
    entries,
  };
}

describe('summarize', () => {
  it('rolls time up by category', () => {
    const { report } = mod;
    const s = report.summarize(log([
      { span: 1, label: 'generate-oas', kind: 'ai', durationMs: 60000 },
      { span: 2, label: 'npm install', kind: 'exec', durationMs: 20000 },
      { span: 3, label: 'press a key', kind: 'wait', durationMs: 10000 },
    ]));

    expect(Object.fromEntries(s.kinds.map((k) => [k.kind, k.ms]))).toEqual({
      ai: 60000,
      exec: 20000,
      wait: 10000,
    });
  });

  it('excludes waiting and animation from workingMs', () => {
    // The headline number: total wall clock moves with how fast the user
    // reads, so it can't be the thing you track across runs.
    const { report } = mod;
    const s = report.summarize(log([
      { span: 1, label: 'an ai turn', kind: 'ai', durationMs: 30000 },
      { span: 2, label: 'press a key', kind: 'wait', durationMs: 50000 },
      { span: 3, label: 'logo', kind: 'anim', durationMs: 2000 },
    ]));

    expect(s.totalMs).toBe(82000);
    expect(s.workingMs).toBe(30000);
  });

  it('charges a parent only for the time its children did not use', () => {
    const { report } = mod;
    const s = report.summarize({
      meta: { command: 'init' },
      entries: [
        { at: 1000, type: 'timing', span: 2, parent: 1, label: 'generate-oas', kind: 'ai', durationMs: 8000 },
        { at: 2000, type: 'timing', span: 1, parent: null, label: 'Map your API', kind: 'step', durationMs: 10000 },
      ],
    });

    // The step is a container: 10s total, 8s of it inside the AI turn, so
    // 2s is time inside the step that nothing has instrumented yet.
    expect(s.containerSelfMs).toBe(2000);
    expect(Object.fromEntries(s.kinds.map((k) => [k.kind, k.ms]))).toEqual({ ai: 8000 });
  });

  it('reports time outside any span as unaccounted', () => {
    const { report } = mod;
    const s = report.summarize({
      meta: { command: 'init' },
      entries: [
        { at: 1000, type: 'init' },
        { at: 4000, type: 'timing', span: 1, parent: null, label: 'a scan', kind: 'scan', durationMs: 1000 },
        { at: 11000, type: 'exit', code: 0 },
      ],
    });

    expect(s.totalMs).toBe(10000);
    expect(s.unaccountedMs).toBe(9000);
  });

  it('groups repeated operations into one row with a count', () => {
    const { report } = mod;
    const s = report.summarize(log([
      { span: 1, label: 'git check-ignore', kind: 'exec', durationMs: 40 },
      { span: 2, label: 'git check-ignore', kind: 'exec', durationMs: 60 },
      { span: 3, label: 'git check-ignore', kind: 'exec', durationMs: 50 },
    ]));

    expect(s.operations).toHaveLength(1);
    expect(s.operations[0]).toMatchObject({ label: 'git check-ignore', count: 3, totalMs: 150 });
  });

  it('sorts operations slowest first', () => {
    const { report } = mod;
    const s = report.summarize(log([
      { span: 1, label: 'quick', kind: 'exec', durationMs: 10 },
      { span: 2, label: 'slow', kind: 'ai', durationMs: 9000 },
      { span: 3, label: 'medium', kind: 'net', durationMs: 400 },
    ]));
    expect(s.operations.map((o) => o.label)).toEqual(['slow', 'medium', 'quick']);
  });

  it('treats a span whose parent is missing from the log as a root', () => {
    // A truncated log, or an interrupted run that flushed its open spans in
    // an order the reader can't reconstruct. Dropping the span would lose
    // exactly the slow thing the run died inside.
    const { report } = mod;
    const s = report.summarize({
      meta: { command: 'init' },
      entries: [
        { at: 5000, type: 'timing', span: 9, parent: 404, label: 'orphan', kind: 'ai', durationMs: 3000 },
      ],
    });
    expect(Object.fromEntries(s.kinds.map((k) => [k.kind, k.ms]))).toEqual({ ai: 3000 });
  });
});

describe('renderReport', () => {
  it('names the slow operations and the step they ran under', () => {
    const { report } = mod;
    const text = report.renderReport({
      meta: { command: 'init' },
      entries: [
        { at: 1000, type: 'init' },
        { at: 2000, type: 'timing', span: 3, parent: 2, label: 'generate-oas', kind: 'ai', durationMs: 74000 },
        { at: 3000, type: 'timing', span: 2, parent: 1, label: 'Get the spec', kind: 'substep', durationMs: 75000 },
        { at: 4000, type: 'timing', span: 1, parent: null, label: 'Map your API', kind: 'step', durationMs: 80000 },
      ],
    }).join('\n');

    // Strip color so the assertions are about content, not escape codes.
    const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('Map your API');
    expect(plain).toContain('Get the spec');
    expect(plain).toContain('generate-oas');
    expect(plain).toContain('AI turns');
  });

  it('says so plainly when a log has no spans', () => {
    // Every log written before this instrumentation existed looks like
    // this, and so does one from a command that does no timed work.
    const { report } = mod;
    const plain = report
      .renderReport({ meta: { command: 'help' }, entries: [{ at: 1, type: 'init' }] })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('No timing spans');
  });

  it('renders JSON that carries the same totals', () => {
    const { report } = mod;
    const source = log([
      { span: 1, label: 'generate-oas', kind: 'ai', durationMs: 30000 },
      { span: 2, label: 'press a key', kind: 'wait', durationMs: 5000 },
    ]);
    const parsed = JSON.parse(report.renderJson(source));
    expect(parsed.command).toBe('init');
    expect(parsed.workingMs).toBe(30000);
    expect(parsed.operations.map((o) => o.label)).toContain('generate-oas');
  });
});

describe('formatMs', () => {
  it('scales the unit to the magnitude', () => {
    const { report } = mod;
    expect(report.formatMs(0)).toBe('0ms');
    expect(report.formatMs(940)).toBe('940ms');
    expect(report.formatMs(3400)).toBe('3.4s');
    expect(report.formatMs(42000)).toBe('42s');
    expect(report.formatMs(135000)).toBe('2m 15s');
  });
});

// ── Plan spans ───────────────────────────────────────────────────────────
// The runner is what makes the report attributable: without step and
// sub-item spans, an AI turn is 74 seconds of nothing in particular.
async function freshPlan() {
  vi.resetModules();
  const debug = await import('../lib/debug.js');
  await import('../lib/timings.js');
  const { createPlanManager } = await import('../lib/runner.js');
  debug.init({ argv: ['node', 'restless', 'init'] });
  return { debug, plan: createPlanManager() };
}

describe('plan spans (lib/runner.js)', () => {
  it('opens a step span and closes it when the step finishes', async () => {
    const { debug, plan } = await freshPlan();
    const step = plan.makeUpdater(0);
    step({ status: 'active' });
    expect(spans(debug)).toHaveLength(0);
    step({ status: 'done' });

    const step0 = spans(debug).filter((e) => e.kind === 'step');
    expect(step0).toHaveLength(1);
    expect(step0[0].label).toBe('Map your API');
    expect(step0[0].index).toBe(0);
  });

  it('nests sub-item spans inside their step', async () => {
    const { debug, plan } = await freshPlan();
    const step = plan.makeUpdater(1);
    step({ status: 'active', activeSub: 0 });
    step({ activeSub: 1 });
    step({ status: 'done' });

    const all = spans(debug);
    const parent = all.find((e) => e.kind === 'step');
    const subs = all.filter((e) => e.kind === 'substep');
    expect(subs.map((e) => e.label)).toEqual(['Install package', 'Generate API key']);
    for (const sub of subs) expect(sub.parent).toBe(parent.span);
  });

  it('does not restart a sub-item clock when the same sub is re-asserted', async () => {
    // Several call sites re-send `activeSub` purely to redraw a message.
    const { debug, plan } = await freshPlan();
    const step = plan.makeUpdater(1);
    step({ status: 'active', activeSub: 0 });
    step({ activeSub: 0, message: ['redraw'] });
    step({ activeSub: 0, message: ['redraw again'] });
    step({ status: 'done' });

    expect(spans(debug).filter((e) => e.kind === 'substep')).toHaveLength(1);
  });

  it('shares sub-item state across updaters made for the same step', async () => {
    // bin/restless.js calls makeUpdater(1) several times (installSdk, then
    // verifyOwnerId, then finalChecks). Per-closure state would let each
    // one open a duplicate span for a sub-item already running.
    const { debug, plan } = await freshPlan();
    plan.makeUpdater(1)({ status: 'active', activeSub: 2 });
    plan.makeUpdater(1)({ activeSub: 2 });
    plan.makeUpdater(1)({ status: 'done' });

    const subs = spans(debug).filter((e) => e.kind === 'substep');
    expect(subs).toHaveLength(1);
    expect(subs[0].label).toBe('Configure SDK');
  });

  it('closes the open step when the next step starts', async () => {
    const { debug, plan } = await freshPlan();
    plan.makeUpdater(0)({ status: 'active', activeSub: 0 });
    plan.makeUpdater(1)({ status: 'active' });

    const closed = spans(debug);
    expect(closed.filter((e) => e.kind === 'step').map((e) => e.label)).toEqual(['Map your API']);
    expect(closed.filter((e) => e.kind === 'substep').map((e) => e.label)).toEqual(['Find your API']);
  });

  it('closes spans on a failed step too', async () => {
    const { debug, plan } = await freshPlan();
    const step = plan.makeUpdater(2);
    step({ status: 'active' });
    step({ status: 'failed' });

    const step2 = spans(debug).filter((e) => e.kind === 'step');
    expect(step2).toHaveLength(1);
    expect(step2[0].label).toBe('Test your setup');
  });

  it('closes spans when a fatal error paints the active step red', async () => {
    const { debug, plan } = await freshPlan();
    plan.makeUpdater(3)({ status: 'active', activeSub: 1 });
    plan.markActiveFailed();

    expect(spans(debug).map((e) => e.label).sort()).toEqual(['Log in', 'Set up account']);
  });

  it('logs the fatal step as failed, once, with its duration', async () => {
    const { debug, plan } = await freshPlan();
    plan.makeUpdater(1)({ status: 'active' });
    plan.markActiveFailed();
    plan.markActiveFailed();

    const failed = debug.snapshot().entries.filter((e) => e.type === 'step.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].index).toBe(1);
    expect(typeof failed[0].durationMs).toBe('number');
  });
});

describe('background spans', () => {
  it('does not let a background span adopt later work as a child', async () => {
    // The real bug: `startWiringReview` kicks the wiring review off to run
    // alongside the owner.id pass and leaves its span open. "Innermost open
    // span" then meant "most recently opened", so a 15s pass became the child
    // of a 5.5s parent - an impossible tree.
    const { debug, timings } = mod;
    const endOuter = timings.start('Configure SDK', { kind: timings.KINDS.SUBSTEP });
    const endBg = timings.start('verify-wiring', { kind: timings.KINDS.AI, background: true });
    const endFg = timings.start('verify-owner-id', { kind: timings.KINDS.AI });
    endFg();
    endBg();
    endOuter();

    const byLabel = Object.fromEntries(spans(debug).map((e) => [e.label, e]));
    expect(byLabel['verify-owner-id'].parent).toBe(byLabel['Configure SDK'].span);
    expect(byLabel['verify-wiring'].parent).toBe(byLabel['Configure SDK'].span);
  });

  it('still gives the background span its own correct parent', async () => {
    const { debug, timings } = mod;
    const endStep = timings.start('Install SDK', { kind: timings.KINDS.STEP });
    timings.start('review', { kind: timings.KINDS.AI, background: true })();
    endStep();

    const byLabel = Object.fromEntries(spans(debug).map((e) => [e.label, e]));
    expect(byLabel.review.parent).toBe(byLabel['Install SDK'].span);
  });

  it('skips past several background spans to find a real parent', async () => {
    const { debug, timings } = mod;
    const endStep = timings.start('step', { kind: timings.KINDS.STEP });
    const a = timings.start('bg-a', { kind: timings.KINDS.AI, background: true });
    const b = timings.start('bg-b', { kind: timings.KINDS.AI, background: true });
    timings.start('foreground', { kind: timings.KINDS.EXEC })();
    a(); b(); endStep();

    const byLabel = Object.fromEntries(spans(debug).map((e) => [e.label, e]));
    expect(byLabel.foreground.parent).toBe(byLabel.step.span);
  });
});

describe('self time with concurrency', () => {
  it('subtracts the union of children, not their sum', async () => {
    // Two children overlapping in wall clock occupy less time than their
    // durations add up to. Summing invented "uninstrumented" time in a
    // parent that had none.
    const { report } = mod;
    const s = report.summarize({
      meta: { command: 'init' },
      entries: [
        // Parent spans 1000..11000 (10s). Two children each 6s, overlapping
        // 1000..7000 and 4000..10000 - together they occupy 9s, not 12s.
        { at: 7000, type: 'timing', span: 2, parent: 1, label: 'a', kind: 'ai', durationMs: 6000 },
        { at: 10000, type: 'timing', span: 3, parent: 1, label: 'b', kind: 'ai', durationMs: 6000 },
        { at: 11000, type: 'timing', span: 1, parent: null, label: 'Step', kind: 'step', durationMs: 10000 },
      ],
    });
    // 10s parent minus 9s of unioned child time = 1s genuinely uninstrumented.
    expect(s.containerSelfMs).toBe(1000);
    // And the AI category counts the 9s they actually occupied, not 12s.
    expect(s.kinds.find((k) => k.kind === 'ai').ms).toBe(9000);
  });

  it('never reports more accounted time than the run lasted', async () => {
    const { report } = mod;
    const s = report.summarize({
      meta: { command: 'init' },
      entries: [
        { at: 1000, type: 'init' },
        { at: 6000, type: 'timing', span: 1, parent: null, label: 'a', kind: 'ai', durationMs: 5000 },
        { at: 6000, type: 'timing', span: 2, parent: null, label: 'b', kind: 'net', durationMs: 5000 },
      ],
    });
    expect(s.accountedMs).toBeLessThanOrEqual(s.totalMs);
    expect(s.unaccountedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('interval helpers', () => {
  it('merges overlapping and touching intervals', async () => {
    const { report } = mod;
    expect(report.unionIntervals([[0, 5], [3, 8], [10, 12]])).toEqual([[0, 8], [10, 12]]);
    expect(report.unionIntervals([[0, 5], [5, 9]])).toEqual([[0, 9]]);
    expect(report.unionIntervals([[4, 4]])).toEqual([]);
  });

  it('punches holes out of an interval', async () => {
    const { report } = mod;
    expect(report.subtractIntervals([[0, 10]], [[3, 6]])).toEqual([[0, 3], [6, 10]]);
    expect(report.subtractIntervals([[0, 10]], [[0, 10]])).toEqual([]);
    expect(report.subtractIntervals([[0, 10]], [[20, 30]])).toEqual([[0, 10]]);
    expect(report.intervalLength([[0, 3], [6, 10]])).toBe(7);
  });
});
