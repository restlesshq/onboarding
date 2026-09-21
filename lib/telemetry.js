/**
 * Anonymous usage telemetry: one request per run, sent at exit.
 *
 * Modelled on Vercel CLI Telemetry - opt-out, disclosed on first run,
 * enum-only payloads, and a debug mode that prints what would be sent
 * instead of sending it.
 *
 * WHAT LEAVES THIS MACHINE is entirely decided by the allowlists below.
 * `record*` is the only way into the buffer and it filters everything
 * through them, so a future caller cannot smuggle a value out by passing a
 * bigger object. The payload is built here from scratch and NEVER by
 * filtering a `debug.snapshot()`: `lib/debug.js` deliberately records `cwd`,
 * `user`, and `hostname` because that log stays on disk unless someone
 * passes `--debug`, and inheriting its shape is exactly how a field added
 * there would leak into telemetry later.
 *
 * NEVER COLLECTED, by construction:
 *   - environment variable names or values
 *   - file paths, including cwd, the git root, the repo name, git remotes
 *   - file contents, OpenAPI specs, or any fragment of either
 *   - AI prompts, AI completions, or anything the model wrote
 *   - error messages, stack traces, HTTP response bodies
 *   - hostname, username
 *   - RESTLESS_KEY, setup keys, CLI tokens, request IDs
 *   - project ids or account ids
 *
 * Nothing here may slow down, block, or break a run. Every failure path is
 * swallowed, the flush is bounded, and `record*` on a disabled run is a
 * no-op that allocates nothing.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SITE_URL, CLI_NAME, IS_LINKED_INSTALL } from './config.js';
import { detectAgent, invocationSource } from './env.js';
import { normalizeLanguage } from './sdk-writers/languages.js';
import { loadConfig, updateConfig, anonymousId } from './user-config.js';

export const SCHEMA_VERSION = 1;

/**
 * Rollout gate. While this is false, telemetry is off for everyone unless
 * they set `RESTLESS_TELEMETRY_FORCE=1`, so the client can ship and be
 * exercised by us before it is exercised by anyone else.
 *
 * Flip to true ONLY once `POST /api/telemetry` is deployed and the staff
 * page has confirmed the stored payloads are clean - see step 5 of the
 * rollout in `plans/backend-telemetry.md`. A CLI posting into a 404 is
 * invisible, but it is also data we cannot get back.
 */
const ROLLOUT_DEFAULT_ON = false;

/** Bounded hard: telemetry is never worth a second of someone's time. */
const FLUSH_TIMEOUT_MS = 1500;

// ── Allowlists ────────────────────────────────────────────────────────────
// Every string that leaves this process is checked against one of these.
// A value that is not in its list becomes `unknown`/`other` - it is never
// sent through as-is, because a store that accepts unrecognized strings is a
// free-text store with extra steps.

/** Commands, mirroring the dispatch chain in `bin/restless.js`. */
export const COMMANDS = new Set([
  'init', 'setup', 'supercharge', 'context', 'debug', 'update', 'guide',
  'key', 'register', 'verify', 'login', 'claim', 'reset', 'clear',
  'timings', 'submit-debug', 'telemetry', 'help', 'version',
]);

/**
 * Flags worth counting: ones that change what the CLI DOES.
 *
 * Deliberately excludes `--yes`, `--json`, `--timings` and friends, which
 * only shape output. Flag NAMES only - a value never travels with one. The
 * one value we do want, `--agent <name>`, rides as `meta.agent` after
 * `lib/env.js` has normalized it to a known slug.
 */
export const FLAGS = new Set([
  '--agent', '--self-drive', '--dir', '--oas', '--url', '--project',
  '--full', '--refresh', '--dry-run', '--debug',
]);

/**
 * The reported setup steps.
 *
 * A strict subset of the dashboard's `SETUP_STEPS`, in the dashboard's
 * spelling, so one step name means one thing in both systems. Its other two
 * values are omitted on purpose:
 *
 *   welcome - redundant with the run itself. Every `init` run sends a
 *             payload, so "all init runs" is already the funnel denominator,
 *             and a truer one: it counts the runs that died BEFORE the
 *             welcome screen, which a `welcome` step cannot.
 *   account - that step is the claim, and a claim creates a project server
 *             side. Completion is already known there, with certainty and
 *             joined to a real identity; an anonymous self-reported copy is
 *             strictly worse data about it.
 *
 * What remains is the middle of the funnel - the part visible only from
 * here, because a run that fails in it never reaches the server at all.
 */
export const STEPS = new Set(['generate_oas', 'install_sdk', 'test']);

export const STEP_STATUSES = new Set(['started', 'done', 'failed']);

/** `lib/runner.js` plan index -> step id. Index 3 ("Set up account") is absent. */
export const STEP_BY_INDEX = ['generate_oas', 'install_sdk', 'test'];

export const OUTCOMES = new Set(['ok', 'error', 'interrupted']);

/** Timing categories, mirroring `KINDS` in `lib/timings.js`. */
export const TIMING_KINDS = new Set(['ai', 'exec', 'net', 'scan', 'wait', 'anim']);

/** Canonical languages from `lib/sdk-writers/languages.js`, plus the ones that normalize but aren't supported. */
export const LANGUAGES = new Set([
  'javascript', 'typescript', 'python', 'ruby', 'go', 'csharp', 'java', 'php', 'rust',
]);

export const FRAMEWORKS = new Set([
  'express', 'fastify', 'nestjs', 'koa', 'hapi', 'next', 'hono',
  'flask', 'django', 'fastapi', 'rails', 'sinatra', 'gin', 'echo', 'chi', 'fiber',
]);

/** `oasSource.kind` from `schemas/settings.schema.json`. */
export const OAS_SOURCE_KINDS = new Set([
  'ai', 'native', 'found', 'file', 'url', 'describe', 'agent',
]);

/**
 * Error codes. A closed set assigned at the raise site - never a message, a
 * stack, or a server's response text, all of which interpolate URLs,
 * statuses, and occasionally the user's own input.
 */
export const ERROR_CODES = new Set([
  'unknown',
  'unsupported-stack',
  'no-endpoints-found',
  'oas-generation-failed',
  'oas-upload-failed',
  'sdk-install-failed',
  'sdk-wiring-failed',
  'test-request-failed',
  'account-claim-failed',
  'network-unreachable',
  'agent-unavailable',
]);

const pick = (set, value, fallback) => (typeof value === 'string' && set.has(value) ? value : fallback);

// ── State ─────────────────────────────────────────────────────────────────
// One-shot CLI, so a module-level singleton is the right shape - the same
// reasoning as `lib/debug.js`.

const state = {
  mode: 'off',       // 'off' | 'debug' | 'on'
  reason: 'uninitialized',
  sessionId: null,
  startedAt: 0,
  command: 'unknown',
  flags: [],
  steps: [],
  detect: null,
  error: null,
  flushed: false,
};

/**
 * Resolve whether we collect, and whether we send. First match wins.
 *
 * `debug` collects and prints but never sends, so someone can see exactly
 * what we would have sent without it leaving the machine. That is the whole
 * point of the mode, and it is why it sits above the opt-outs: a person
 * checking what we collect has by definition not consented to it being
 * sent, and this way they never have to.
 */
function resolveMode() {
  const env = process.env;
  if (env.RESTLESS_TELEMETRY_DEBUG === '1') return { mode: 'debug', reason: 'debug-mode' };
  if (env.RESTLESS_TELEMETRY_DISABLED === '1') return { mode: 'off', reason: 'env-disabled' };
  // Not something Vercel honors. It costs one line, and it is the answer we
  // would want given to us.
  if (env.DO_NOT_TRACK === '1') return { mode: 'off', reason: 'do-not-track' };
  if (loadConfig().telemetry?.enabled === false) return { mode: 'off', reason: 'opted-out' };
  // Below this line are the two "not yet / not you" gates, both overridable,
  // because neither is a statement about what the user wants.
  if (env.RESTLESS_TELEMETRY_FORCE === '1') return { mode: 'on', reason: 'forced' };
  if (IS_LINKED_INSTALL) return { mode: 'off', reason: 'linked-install' };
  if (!ROLLOUT_DEFAULT_ON) return { mode: 'off', reason: 'not-yet-enabled' };
  return { mode: 'on', reason: 'default-on' };
}

/**
 * Which command this is, from argv, reduced to an allowlisted name.
 *
 * Note what does NOT happen here: argv is never stored, and a command we do
 * not recognize collapses to `unknown` rather than travelling as typed. A
 * typo'd command is not interesting, and `restless /Users/me/secret` would
 * otherwise be a path in the payload.
 */
function readCommand(argv) {
  const raw = argv[2];
  if (!raw || raw.startsWith('-')) {
    // `--version` / `-v` / `--help` / `-h` / bare invocation.
    if (raw === '--version' || raw === '-v') return 'version';
    return 'help';
  }
  return COMMANDS.has(raw) ? raw : 'unknown';
}

/** Allowlisted flag NAMES present in argv, deduped, order-stable. */
function readFlags(argv) {
  const seen = [];
  for (const token of argv.slice(3)) {
    if (typeof token !== 'string' || !token.startsWith('-')) continue;
    // `--flag=value` carries its value in the same token; keep the name only.
    const name = token.split('=')[0];
    if (FLAGS.has(name) && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** A recognized CI vendor is not collected; only whether this is CI at all. */
function isCI() {
  return Boolean(process.env.CI);
}

/**
 * Initialize. Call once, near the top of the entry point, right after
 * `debug.init` - the mode has to be known before anything can record.
 */
export function init({ argv = process.argv } = {}) {
  const { mode, reason } = resolveMode();
  state.mode = mode;
  state.reason = reason;
  state.startedAt = Date.now();
  state.sessionId = crypto.randomUUID();
  state.command = readCommand(argv);
  state.flags = readFlags(argv);
  return mode !== 'off';
}

export function isEnabled() {
  return state.mode !== 'off';
}

export function isSending() {
  return state.mode === 'on';
}

/** For `restless telemetry status`, and for tests asserting precedence. */
export function describeStatus() {
  const { mode, reason } = state.mode === 'uninitialized' ? resolveMode() : state;
  return {
    mode,
    reason,
    endpoint: `${SITE_URL}/api/telemetry`,
    // Read rather than minted: `status` must not be the thing that creates
    // an id on a machine that has opted out.
    anonymousId: loadConfig().telemetry?.anonymousId || null,
  };
}

/**
 * Record one completed setup step.
 *
 * `index` is the plan index from `lib/runner.js`; an index with no mapping
 * (today: 3, "Set up account") is dropped silently rather than guessed at.
 */
export function recordStep(index, status, durationMs) {
  if (state.mode === 'off') return;
  const step = STEP_BY_INDEX[index];
  if (!step || !STEPS.has(step)) return;
  const entry = {
    step,
    status: pick(STEP_STATUSES, status, 'done'),
    durationMs: clampMs(durationMs),
  };
  // One entry per step: a step re-asserted (the runner's updater is built
  // more than once for the same index) must not double-count.
  const existing = state.steps.findIndex((s) => s.step === step);
  if (existing >= 0) state.steps[existing] = entry;
  else state.steps.push(entry);
}

/** Record the run's terminal error, as a code. Never a message. */
export function recordError(code, stepIndex) {
  if (state.mode === 'off') return;
  state.error = {
    errorCode: pick(ERROR_CODES, code, 'unknown'),
    errorStep: STEP_BY_INDEX[stepIndex] || null,
  };
}

/**
 * Record what the scan concluded about the project. Allowlisted categories
 * only.
 *
 * Language goes through the CLI's own `normalizeLanguage`, so "Node.js",
 * "node" and "js" land on `javascript` exactly as they do everywhere else -
 * one alias table, not two that can drift. One wrinkle: that function
 * answers `javascript` for an ABSENT language, which is right for the setup
 * flow (a missing value there means "detection didn't bother") and wrong
 * here, where it would silently file every undetected project under
 * JavaScript. So absence is handled before it gets there.
 */
export function recordDetect({ language, framework, oasSourceKind } = {}) {
  if (state.mode === 'off') return;
  state.detect = {
    language: language ? pick(LANGUAGES, normalizeLanguage(language), 'other') : 'other',
    framework: pick(FRAMEWORKS, normalizeFramework(framework), 'other'),
    oasSourceKind: pick(OAS_SOURCE_KINDS, oasSourceKind, 'other'),
  };
}

/** Frameworks have no shared normalizer; they are only ever compared to the list above. */
function normalizeFramework(v) {
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s_.-]+/g, '') : v;
}

function clampMs(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  // 24h. A longer duration is a clock change, not a run.
  return Math.min(Math.round(v), 86_400_000);
}

/**
 * Per-kind timing totals, from the span data the run already produced.
 *
 * Takes `summarize()`'s `kinds` rather than reading spans directly, and
 * takes ONLY the totals: span labels are built at call time in a few places
 * and are not guaranteed to be free of interpolated values.
 */
function byKindFrom(summary) {
  const out = {};
  for (const k of summary?.kinds || []) {
    if (TIMING_KINDS.has(k?.kind)) out[k.kind] = clampMs(k.ms);
  }
  return out;
}

/**
 * Build the payload. Exported for tests, which assert on it directly rather
 * than on what a mocked `fetch` was handed.
 */
export function buildPayload({ exitCode = null, outcome = 'ok', summary = null } = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,

    anonymousId: anonymousId(),
    sessionId: state.sessionId,

    command: state.command,
    flags: state.flags,
    outcome: pick(OUTCOMES, outcome, 'ok'),
    exitCode: typeof exitCode === 'number' ? Math.max(0, Math.min(255, exitCode)) : null,
    errorCode: state.error?.errorCode ?? null,
    errorStep: state.error?.errorStep ?? null,
    durationMs: clampMs(Date.now() - state.startedAt),
    byKind: byKindFrom(summary),

    cliVersion: readVersion(),
    // CLI_NAME comes from argv[1]'s basename, so it is allowlisted rather
    // than sent through - it is a bin name, but it is derived from a path.
    cliName: CLI_NAME === 'restless' || CLI_NAME === 'api' ? CLI_NAME : 'other',
    platform: process.platform,
    nodeVersion: process.version,
    ci: isCI(),
    source: invocationSource(),
    agent: detectAgent(),

    ...(state.detect || {}),

    steps: state.steps,
  };
}

let cachedVersion;
function readVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    // Resolved from this file, not cwd, so it reports the CLI that is
    // actually running rather than whatever the user is standing in.
    const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    cachedVersion = JSON.parse(fs.readFileSync(pkg, 'utf8')).version || '';
  } catch {
    cachedVersion = '';
  }
  return cachedVersion;
}

/**
 * Send it. Registered as a `debug.addFinalizeHook`, which already runs on
 * every exit path - normal, `flushAndExit`, `beforeExit`, an uncaught
 * throw, and the SIGINT handler - so telemetry needs no exit wiring of its
 * own.
 *
 * Idempotent. Never throws, never retries, never prints on the normal path.
 */
export async function flush({ exitCode = null, outcome = 'ok', summary = null } = {}) {
  if (state.mode === 'off' || state.flushed) return;
  state.flushed = true;

  let payload;
  try {
    payload = buildPayload({ exitCode, outcome, summary });
  } catch {
    return;
  }

  if (state.mode === 'debug') {
    // stderr, not stdout: a run may be mid-pipe, and this is diagnostics.
    try {
      process.stderr.write(`[telemetry] ${JSON.stringify(payload, null, 2)}\n`);
    } catch {}
    return;
  }

  try {
    const request = fetch(`${SITE_URL}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
    }).catch(() => {});

    // Raced against a timer as well as the abort signal, deliberately. The
    // signal is what a well-behaved fetch honors; the race is what makes
    // "telemetry can never hold up an exit" true even if it doesn't. This
    // flush runs from a `debug.finalize` hook that the exit path AWAITS, so
    // a fetch that ignores its signal would otherwise hang the CLI on the
    // way out - the one failure mode that would be worse than losing the
    // data. `unref` so the timer itself can't keep the loop alive.
    let timer;
    await Promise.race([
      request,
      new Promise((resolve) => {
        timer = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        if (typeof timer?.unref === 'function') timer.unref();
      }),
    ]);
    clearTimeout(timer);
  } catch {
    /* swallow: a tracking outage must never surface to the user */
  }
}

/**
 * Write the opt-in/opt-out choice. Returns false when it could not be
 * saved, which is the one telemetry failure a user does need to hear about
 * - they asked for a change and it did not happen.
 */
export function setStatus(enabled) {
  const ok = updateConfig({ telemetry: { enabled: Boolean(enabled) } });
  if (!enabled) {
    // Drop anything this run buffered: someone who just opted out should
    // not have the run that opted them out reported.
    state.mode = 'off';
    state.steps = [];
    state.detect = null;
    state.error = null;
  }
  return ok;
}

/** True when the first-run notice has not been shown on this machine. */
export function needsNotice() {
  return !loadConfig().telemetry?.notifiedAt;
}

export function markNoticeShown() {
  updateConfig({ telemetry: { notifiedAt: new Date().toISOString() } });
}

/** Test seam: forget everything resolved at init. */
export function reset() {
  state.mode = 'off';
  state.reason = 'uninitialized';
  state.sessionId = null;
  state.startedAt = 0;
  state.command = 'unknown';
  state.flags = [];
  state.steps = [];
  state.detect = null;
  state.error = null;
  state.flushed = false;
  cachedVersion = undefined;
}
