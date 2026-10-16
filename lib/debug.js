import fs from 'fs';
import os from 'os';
import path from 'path';
import { SITE_URL } from './config.js';

// Single in-process log buffer. The CLI is one-shot, so a module-level
// singleton is the right shape - we don't have multiple concurrent runs.
//
// We deliberately do NOT mirror stdout/stderr into the log. The CLI's
// terminal UI is animation-heavy (typing effects, plan redraws, spinner
// frames) - capturing every write produced 25k+ entries of mostly
// useless ANSI artifacts. Instead, every meaningful moment is emitted
// as a structured event (input.*, ai.*, step.*, error, etc.) by the
// surface that owns it.
//
// Recording is ALWAYS on: every run accumulates entries and writes a
// local JSON copy to ~/.restless/debug/ on exit. The `--debug` flag
// (`uploadOnExit`) only adds the extra step of uploading that copy to
// the Restless team when the CLI exits. The `submit-debug`
// command uploads a previously-written local copy on demand, and a run
// that fails offers to send its copy right there (see `setReportOffer`).
const state = {
  uploadOnExit: false,
  // Asked, once the local copy is on disk, whether a failed run's log
  // should go to the team. Set by `lib/bug-report.js`, which owns the
  // prompt - debug.js can't import the UI, because the UI imports it.
  reportOffer: null,
  // True while that offer is waiting on the user. An abort then exits on
  // the spot instead of waiting on the finalize the offer is part of.
  offering: false,
  // Why this run, though it may exit 0, left the user short of onboarded
  // (the SDK never confirmed, the claim couldn't start, ...). Any entry
  // means the run is offered as a bug report. See `markUnfinished`.
  unfinished: [],
  // Set by `skipReport` on the few exits that aren't a failure at all.
  skipReportReason: null,
  // Set by `reportAfterRetry`: the failure is one an agent is expected to
  // fix and re-run, so the offer says to try the fix first.
  retryFirst: false,
  // A signal ended the run. Nobody is reading the terminal by then, so the
  // log is written but nothing is offered.
  killed: false,
  entries: [],
  meta: {},
  finalized: false,
  finalizing: null,
  interrupted: false,
  uploaded: false,
  // Ran once at the top of `finalize`, before the log body is built.
  // Exists so `lib/timings.js` can flush spans that were still open when
  // the run ended without debug.js having to import it back (which would
  // make the two modules circular).
  finalizeHooks: [],
};

/**
 * Register a callback to run just before the log body is assembled. Use
 * it for last-moment entries that only the exit path knows to write.
 * Hooks are best-effort: a throwing (or rejecting) hook is swallowed so it
 * can never turn a clean exit into a crash. An async hook is awaited, so it
 * must bound its own work - see `finalize`.
 */
export function addFinalizeHook(fn) {
  if (typeof fn === 'function') state.finalizeHooks.push(fn);
}

export function isEnabled() {
  return state.uploadOnExit;
}

/**
 * Register the callback a failed run hands its local log to. Called with
 * `{ localPath, unfinished, retryFirst }` after the copy is written, when
 * `shouldOfferReport` says the run left the user short of onboarded. It
 * does its own prompting and uploading.
 */
export function setReportOffer(fn) {
  state.reportOffer = typeof fn === 'function' ? fn : null;
}

/**
 * Record that this run left setup unfinished, even if it goes on to exit 0:
 * the test step never saw the SDK, the claim link couldn't be made, a final
 * check is still failing. Any such run is offered as a bug report, because
 * the person is not onboarded and may not realize it.
 */
export function markUnfinished(reason) {
  log('setup.unfinished', { reason });
  state.unfinished.push(reason);
}

/**
 * Exempt this run's non-zero exit from the bug-report offer. Only for exits
 * that can't be a bug in setup: a mistyped command or flag, a missing
 * argument, a failure inside `submit-debug` itself. Everything else that
 * exits non-zero is offered, so a new failure path is covered by default.
 */
export function skipReport(reason) {
  log('report.skip', { reason });
  state.skipReportReason = reason;
}

/**
 * Mark this run's failure as one to fix and retry before reporting: `verify`
 * before the server restarts, a spec `register` rejected. The offer still
 * happens, worded as "if the fix doesn't work".
 */
export function reportAfterRetry() {
  state.retryFirst = true;
}

/**
 * Should the run that just ended offer its log? Yes for anything that left
 * the user short of onboarded: a non-zero exit (unless `skipReport` said it
 * isn't a failure) or anything recorded with `markUnfinished`. No after a
 * ctrl-c or a kill, since the user chose to stop or nobody is watching.
 */
export function shouldOfferReport(exitCode) {
  if (state.interrupted || state.killed) return false;
  if (state.unfinished.length) return true;
  return typeof exitCode === 'number' && exitCode > 0 && !state.skipReportReason;
}

/**
 * The log as it stands right now, in the same `{ meta, entries }` shape
 * written to disk. Lets an in-process reader (the `--timings` report)
 * consume live events through the identical code path that reads a saved
 * log, instead of keeping a second copy of the run in memory.
 *
 * `entries` is a shallow copy so a caller can sort it without reordering
 * the log we're about to write.
 */
export function snapshot() {
  return {
    meta: { ...state.meta, finishedAt: new Date().toISOString() },
    entries: [...state.entries],
  };
}

/**
 * Initialize debug capture. Always records; `--debug` additionally
 * uploads the log on exit. Returns true when `--debug` is set so
 * callers can show the upload banner.
 */
export function init({ argv }) {
  state.uploadOnExit = argv.includes('--debug');

  state.meta = {
    cli: 'api',
    command: argv[2] || '',
    argv: argv.slice(2),
    cwd: safeCwd(),
    platform: process.platform,
    nodeVersion: process.version,
    osRelease: os.release(),
    osType: os.type(),
    user: safeUser(),
    hostname: safeHost(),
    startedAt: new Date().toISOString(),
  };

  log('init', { meta: state.meta });
  return state.uploadOnExit;
}

function safeCwd() { try { return process.cwd(); } catch { return ''; } }
function safeUser() { try { return os.userInfo().username; } catch { return ''; } }
function safeHost() { try { return os.hostname(); } catch { return ''; } }

/**
 * Defense-in-depth redaction. Architecture already keeps the
 * RESTLESS_KEY out of every code path that feeds debug.log - it's
 * generated in pure Node, written to .env via `fs.appendFileSync` (not
 * an AI Write tool), and every AI prompt explicitly forbids reading
 * `.env*`. But a misbehaving model could still quote the key inside
 * an `ai.text` block. Run every string value through these patterns
 * before storing so even that path can't leak.
 *
 * Patterns are intentionally narrow (specific prefixes, named headers,
 * named env vars) to keep false-positive redactions out of the log.
 */
const REDACTORS = [
  // Our own key formats: `rstlss_` (current) and `rdme_` (legacy, still in use)
  // followed by 32+ hex chars. Both need redaction since old keys keep working.
  [/rstlss_[a-f0-9]{32,}/gi, 'rstlss_[REDACTED]'],
  [/rdme_[a-f0-9]{32,}/gi, 'rdme_[REDACTED]'],
  // `RESTLESS_KEY=...` / `API_KEY=...` / `SECRET=...` env-var assignments.
  [/\b(RESTLESS_[A-Z0-9_]+|API[_-]?KEY|SECRET[_A-Z0-9]*|TOKEN[_A-Z0-9]*|PASSWORD)\s*=\s*[^\s\n'"`]+/gi, '$1=[REDACTED]'],
  // `Authorization: Bearer ...` / `X-Api-Key: ...` headers (common shapes).
  [/\b(Authorization|Cookie|Set-Cookie|X-Api-Key|X-Auth-Token|Proxy-Authorization)\s*:\s*[^\r\n]+/gi, '$1: [REDACTED]'],
  // Bare `Bearer xxxx` tokens that aren't behind a named header.
  [/\bBearer\s+[A-Za-z0-9._\-]{16,}/g, 'Bearer [REDACTED]'],
];

function redactString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const [re, replacement] of REDACTORS) out = out.replace(re, replacement);
  return out;
}

function redactDeep(value) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactDeep);
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
  return out;
}

/**
 * Save a JSON copy of the run. Written on every run. Honors
 * RESTLESS_DEBUG_DIR; defaults to `~/.restless/debug/`. Filename is
 * `<iso-timestamp>-<command>.json` so newest sorts last and files are
 * trivial to find with `ls -t`.
 *
 * Returns the absolute path on success, or null if the write failed
 * (read-only home dir, disk full, etc.) - failure is silent on normal
 * runs and surfaced to stderr by the caller in --debug mode, but never
 * blocks the run.
 */
function writeLocalCopy(body) {
  try {
    const dir = debugDir();
    fs.mkdirSync(dir, { recursive: true });

    // Filename-safe ISO: 2026-05-10T22-57-36-123Z
    const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const cmd = (state.meta.command || 'run').replace(/[^a-z0-9_-]/gi, '');
    const file = path.join(dir, `${stamp}-${cmd}.json`);

    // Indent so the file is human-readable for ad-hoc `cat` / `less`,
    // and so `grep "install-sdk"` lands on its own line instead of
    // somewhere in the middle of a 200KB single line.
    fs.writeFileSync(file, JSON.stringify(body, null, 2));
    return file;
  } catch {
    return null;
  }
}

/**
 * Record a structured event. Free-form `data` object is merged onto
 * the entry alongside `at`/`type`. Always records (the local copy is
 * written on every run); all string values are run through
 * `redactString` first.
 */
export function log(type, data) {
  const entry = { at: Date.now(), type };
  if (data && typeof data === 'object') Object.assign(entry, redactDeep(data));
  else if (data !== undefined) entry.value = redactDeep(data);
  state.entries.push(entry);
}

/**
 * POST a debug payload to the app. The payload is the same
 * `{ meta, entries }` JSON we write to disk, so the on-exit path and
 * the `submit-debug` command share this single uploader.
 *
 * Bounded to 5s so we never hang the user. Prints a short status line
 * to stderr (not stdout - we may be mid user-facing output and
 * shouldn't pollute pipes). Returns `{ ok, status }`.
 *
 * The upload endpoint is never surfaced to the user - it's internal
 * infrastructure. The diagnostic is just enough to confirm that
 * "yes, the log was sent" or "no, here's why it failed."
 */
async function postDebugLog(payload) {
  const url = `${SITE_URL}/api/debug`;
  const writeErr = (s) => process.stderr.write(s);

  writeErr(`  \x1b[2m⤴  Uploading debug log (${(payload.length / 1024).toFixed(1)} KB)…\x1b[0m\n`);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      writeErr(`  \x1b[31m✗\x1b[0m \x1b[2mDebug upload failed (HTTP ${res.status}).\x1b[0m\n`);
      return { ok: false, status: res.status };
    }
    writeErr(`  \x1b[32m✓\x1b[0m \x1b[2mDebug log uploaded.\x1b[0m\n`);
    return { ok: true, status: res.status };
  } catch (err) {
    // Generic message - no URL, no host. Network detail goes nowhere
    // useful for the user, and "is the app running" hints can leak
    // dev URLs in screenshots / pastes.
    const timedOut = err?.name === 'AbortError';
    writeErr(`  \x1b[31m✗\x1b[0m \x1b[2mDebug upload failed${timedOut ? ' (timed out)' : ''}.\x1b[0m\n`);
    return { ok: false, status: 0 };
  }
}

/**
 * End-of-run handling. Idempotent - only fires once per process.
 *
 * ALWAYS writes a local JSON copy of the run to disk (silently). When
 * `--debug` is set (`uploadOnExit`), it also prints where the copy
 * landed and uploads it to the Restless team.
 */
export function finalize({ exitCode } = {}) {
  // A second caller (fatalError's exit racing the uncaught handler) must wait
  // for the first, or its process.exit cuts off the hooks and the local copy.
  if (!state.finalizing) state.finalizing = runFinalize(exitCode);
  return state.finalizing;
}

async function runFinalize(exitCode) {
  state.finalized = true;

  // Awaited, so a hook may be async. `lib/telemetry.js` registers its flush
  // here rather than wiring its own exit handling: this path already covers
  // every way the process ends (flushAndExit, beforeExit, uncaughtException,
  // SIGINT). A hook that hangs would hold the exit, so an async one is
  // expected to bound itself - telemetry's flush does.
  //
  // Hooks get the exit code, because it is the one thing about the run that
  // only this call knows: `beforeExit` reports Node's code, `flushAndExit`
  // the one its caller chose, and a hook has no other way to tell a clean
  // finish from a failed one.
  const code = exitCode ?? null;
  for (const hook of state.finalizeHooks) {
    try { await hook(code); } catch {}
  }

  const body = {
    meta: { ...state.meta, exitCode: exitCode ?? null, finishedAt: new Date().toISOString() },
    entries: state.entries,
  };

  // Always drop a copy on disk so the user can grep / cat without round-
  // tripping through the site, and so the `submit-debug` command
  // has something to upload after the fact. Honors RESTLESS_DEBUG_DIR;
  // otherwise lands in ~/.restless/debug/. Pretty-printed JSON so `grep`
  // and visual reads both work. Silent on normal runs.
  const localPath = writeLocalCopy(body);

  if (!state.uploadOnExit) {
    if (localPath && state.reportOffer && shouldOfferReport(code)) {
      state.offering = true;
      try {
        await state.reportOffer({ localPath, unfinished: [...state.unfinished], retryFirst: state.retryFirst });
      } catch {}
      state.offering = false;
    }
    return;
  }
  if (state.uploaded) return;
  state.uploaded = true;

  if (localPath) {
    process.stderr.write(`\n  \x1b[2m📄 Local copy: ${localPath}\x1b[0m\n`);
  }
  await postDebugLog(JSON.stringify(body));
}

/**
 * Async exit: finalize (always writes the local copy; uploads when
 * `--debug` is on), then call the real process.exit. Safe to invoke
 * fire-and-forget from sync contexts (event handlers, etc.) - the
 * local write is synchronous so it lands even if the promise isn't
 * awaited, and Node won't exit while a pending upload keeps the loop
 * alive.
 */
export async function flushAndExit(code = 0) {
  // An abort at the offer's prompt (ctrl-c, esc) lands here while finalize
  // is waiting on that same prompt, so awaiting it would never return.
  // Everything finalize owed is already done: the hooks ran and the local
  // copy is written. Any other exit mid-offer waits for the answer.
  if (state.offering && state.interrupted) return process.exit(code);
  log('exit', { code });
  await finalize({ exitCode: code });
  process.exit(code);
}

/** Exit for a user abort (ctrl-c or esc), so telemetry reports `interrupted`. */
export function abortExit(code = 0) {
  state.interrupted = true;
  return flushAndExit(code);
}

export function wasInterrupted() {
  return state.interrupted;
}

/**
 * Wire up signal/error handlers so unexpected paths still write (and,
 * with --debug, upload) the log. Call once, near the top of the entry
 * point.
 */
export function attachExitHandlers() {
  process.on('beforeExit', async (code) => {
    if (state.finalized) return;
    log('beforeExit', { code });
    await finalize({ exitCode: code });
  });

  process.on('uncaughtException', async (err) => {
    log('uncaughtException', { message: err?.message, stack: err?.stack });
    await finalize({ exitCode: 1 });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection', { reason: reason instanceof Error ? reason.stack : String(reason) });
  });

  // An agent's command timeout or a closed terminal. Without these Node
  // dies on the spot and the run leaves no log at all, which is the run
  // `submit-debug` most needs to find afterwards. Exit codes follow the
  // shell's 128 + signal number.
  for (const [signal, number] of [['SIGTERM', 15], ['SIGHUP', 1]]) {
    process.on(signal, async () => {
      state.killed = true;
      log('signal', { signal });
      await finalize({ exitCode: 128 + number });
      process.exit(128 + number);
    });
  }
}

/**
 * Resolve the debug log directory (RESTLESS_DEBUG_DIR or
 * ~/.restless/debug/). Kept in one place so writes and reads agree.
 */
function debugDir() {
  return process.env.RESTLESS_DEBUG_DIR || path.join(os.homedir(), '.restless', 'debug');
}

/**
 * Find the most recent local debug log, or null if none exist.
 *
 * Filenames are `<iso-stamp>-<command>.json`, so a lexicographic sort
 * is chronological and the newest sorts last. We exclude the
 * `submit-debug` command's own logs so re-running the command never
 * picks up the run we just created instead of the one we want to send.
 */
export function findLatestLocalLog() {
  const files = listLocalLogs();
  return files.length ? files[0].path : null;
}

/**
 * Every local debug log, newest first.
 *
 * Filenames are `<iso-stamp>-<command>.json`, so a lexicographic sort is
 * chronological. The CLI's own read-only commands are excluded: their logs
 * are always the newest on disk, so including them would mean
 * `restless timings` profiled the run of `restless timings` rather than the
 * `init` you wanted to look at.
 */
const SELF_COMMANDS = ['submit-debug', 'timings'];

export function listLocalLogs({ limit = 20 } = {}) {
  try {
    const dir = debugDir();
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !SELF_COMMANDS.some((c) => f.endsWith(`-${c}.json`)))
      .sort()
      .reverse()
      .slice(0, limit)
      .map((f) => ({
        path: path.join(dir, f),
        file: f,
        // `2026-09-01T13-26-10-123Z-init.json` -> `init`
        command: (f.replace(/\.json$/, '').match(/Z-(.+)$/) || [, ''])[1],
      }));
  } catch {
    return [];
  }
}

/**
 * Upload a previously-written local log file. The on-disk body is what
 * `postDebugLog` expects, so with no `report` the raw text goes as-is.
 *
 * `report` is the bug-report envelope (`{ email, source }`), sent beside
 * `meta` and `entries` rather than inside the log, so the log stays exactly
 * what the user was shown. Returns `{ ok, status }`; `ok` is false if the
 * file can't be read or parsed.
 */
export async function submitLocalLog(filePath, { report } = {}) {
  let payload;
  try {
    payload = fs.readFileSync(filePath, 'utf8');
    if (report) payload = JSON.stringify({ ...JSON.parse(payload), report });
  } catch {
    return { ok: false, status: 0 };
  }
  return postDebugLog(payload);
}
