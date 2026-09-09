#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan, yellow, orange, brand, white, muted, ask, askYesNo, startSpinner, singleSelect, actionPicker, typeLine, typeOut, inlineStatus, waitForKey, animateLogoIn, printLogo, suppressInput, clearScreen, setLogoSubtitle, isAbortKey } from '../lib/ui.js';
import { runAI, loadPrompt, languagePromptVars, setProvider } from '../lib/ai.js';
import { createPlanManager } from '../lib/runner.js';
import { resolveProjectDirs, findGitRoot, isGitIgnored } from '../lib/project.js';
import { countOperations } from '../lib/oas-parse.js';
import { setGitRoot } from '../lib/pathGuard.js';
import { flagValue, positionalArg } from '../lib/args.js';
import generateOas from '../steps/generate-oas.js';
import prepareAccount from '../steps/prepare-account.js';
import installSdk from '../steps/install-sdk.js';
import { createSetupContext, redactSetupContext, getSdkLineSpec } from '../lib/setup-context.js';
import verifyOwnerId from '../steps/verify-owner-id.js';
import finalChecks, { startWiringReview } from '../steps/final-checks.js';
import setupAccount from '../steps/setup-account.js';
import testSetup from '../steps/test-setup.js';
import runInteractiveUpdate from '../steps/update-interactive.js';
import runFlagUpdate, { parseUpdateFlags, UPDATE_FLAGS } from '../steps/update-flags.js';
import { SITE_URL, CALENDLY_URL, CLI_NAME, DEMO_REPO, DEMO_REPO_SSH_URL } from '../lib/config.js';
import { cloneDemoRepo, DEMO_DIR_NAME } from '../lib/demo-repo.js';
import { isInteractive, isAgent, detectAgent, agentLabel } from '../lib/env.js';
import { buildAgentPlan } from '../lib/agent-plan.js';
import { getSdkWriter } from '../lib/sdk-writers/index.js';
import { normalizeLanguage } from '../lib/sdk-writers/languages.js';
import { detectStack, stackCheckDisabled, unsupportedStackMessage } from '../lib/detect-stack.js';
import { resolveOwningDir } from '../lib/install-target.js';
import { apiDirKey, loadSettings, saveSettings, upsertApi, generatePrefix, formatRequestId, stripRequestIdPrefix } from '../lib/settings.js';
import { findExistingEnvFile, existingRestlessKey, replaceRestlessKey } from '../steps/prepare-account.js';
import { generateWriteKey, ensureProject, loadProjectCreds, pollForLandedLog, uploadPendingArtifacts } from '../lib/project-init.js';
import { normalizeBaseUrl, parseStatus, describeDiagnosis, diagnoseFromHeaders, splitCurlIncludeOutput, fixContext } from '../lib/test-diagnosis.js';
import { checkOasServers, guessBaseUrl, isPlausibleBaseUrl } from '../lib/base-url.js';
import { safeWriteFileSync, safeAppendFileSync } from '../lib/pathGuard.js';
import { fatalError, isFatalExit } from '../lib/errors.js';
import { findSdkReferences, findOwnerIdPlaceholders } from '../lib/grep-sdk.js';
import contextStep from '../steps/context.js';
import { signIn, pickProject, clearAccountToken, reportSignInFailure } from '../lib/context-auth.js';
import * as debug from '../lib/debug.js';
import * as timings from '../lib/timings.js';
import { renderReport, renderJson } from '../lib/timings-report.js';

// Initialize debug capture FIRST, before anything else writes to stdout -
// the stream wrappers need to be in place to record the welcome screen.
const debugEnabled = debug.init({ argv: process.argv });
debug.attachExitHandlers();

// ── `--timings`: profile this run ─────────────────────────────────────────
// A development flag. Spans are recorded on every run regardless (they ride
// along in the debug log, same as every other event), so this only controls
// whether the report is printed when the process exits - `npx restless
// timings` renders the same thing from a log written earlier.
//
// Registered as a finalize hook so it fires on every exit path, including
// the ones that don't reach the bottom of a command: a fatal error, a
// ctrl-c, an uncaught throw. A run that died halfway is often the run you
// most want the timings for.
const timingsMode = process.argv.includes('--timings=json')
  ? 'json'
  : process.argv.includes('--timings')
    ? 'text'
    : null;
if (timingsMode) {
  debug.addFinalizeHook(() => {
    // Close anything still running so an interrupted step reports the
    // duration it actually reached instead of vanishing. Idempotent, and
    // already done by timings.js's own hook on the normal path.
    timings.closeOpenSpans('run-ended');
    const log = debug.snapshot();
    // stderr, not stdout: a run may be mid-pipe, and the report is
    // diagnostics rather than output.
    process.stderr.write(
      timingsMode === 'json'
        ? `${renderJson(log)}\n`
        : `${renderReport(log).join('\n')}\n`,
    );
  });
}

// Hard ceiling: no fs write, AI tool, or helper anywhere in this process
// is allowed to touch a path outside the git root the user invoked us
// from. Set BEFORE any user-flow code runs so even early bootstrap
// writes pass through the guard.
setGitRoot(findGitRoot(process.cwd()));

// Suppress Node's unsettled top-level await warning
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'Warning' && w.message.includes('unsettled top-level await')) return;
  console.warn(w);
});

// Handle Ctrl+C gracefully
let setupInProgress = false;
process.on('SIGINT', () => {
  // Show cursor in case it was hidden, move below current output
  process.stdout.write('\x1b[?25h\n');
  if (setupInProgress) {
    console.log(dim(`\n  Setup interrupted. Run \`npx ${CLI_NAME} init\` again to resume.\n`));
  }
  debug.flushAndExit(0);
});

// Last-resort safety net. Any thrown error or rejected promise that nothing
// else caught funnels into fatalError so the user always sees something
// concrete instead of a silent exit / red step with no message.
function _surfaceFatal(err) {
  // FatalExit is the sentinel `fatalError` throws to stop the calling
  // stack - the error has already been reported and an async exit is in
  // flight. Just keep the screen alive while the exit completes.
  if (isFatalExit(err)) {
    process.stdout.write('\x1b[?25h');
    return;
  }
  process.stdout.write('\x1b[?25h'); // make sure the cursor is visible
  const message = err?.message ? String(err.message) : String(err);
  const stack = err?.stack ? String(err.stack).split('\n').slice(0, 4) : [];
  try {
    fatalError(`Unexpected error: ${message}`, stack);
  } catch (e) {
    // fatalError throws FatalExit by design - swallow so the handler
    // doesn't re-fire on itself.
    if (!isFatalExit(e)) throw e;
  }
}
process.on('uncaughtException', _surfaceFatal);
process.on('unhandledRejection', _surfaceFatal);

function hasClaude() {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the prompt sent to Claude (either via the local SDK on "yes" or
 * printed for the user to paste elsewhere on "no"). The prompt is the
 * same in both cases so what the user sees if they pick "give me a
 * prompt" matches what they'd have gotten from the SDK run.
 */
function buildFixPrompt(log) {
  const har = log.har || {};
  const req = har.request || {};
  const res = har.response || {};
  const reqHeaders = Array.isArray(req.headers)
    ? req.headers.map((h) => `${h.name}: ${h.value}`).join('\n')
    : '';
  const resHeaders = Array.isArray(res.headers)
    ? res.headers.map((h) => `${h.name}: ${h.value}`).join('\n')
    : '';
  const reqBody = req.postData?.text || '(empty)';
  const resBody = res.content?.text || '(empty)';
  return [
    'A developer just got an HTTP error from their API and is asking for help fixing it.',
    '',
    '--- ERROR DETAILS ---',
    `Method: ${log.method || req.method || '?'}`,
    `URL: ${log.url || req.url || '?'}`,
    `Status: ${log.status || res.status || '?'}${res.statusText ? ' ' + res.statusText : ''}`,
    '',
    'Request headers:',
    reqHeaders || '(none captured)',
    '',
    'Request body:',
    reqBody,
    '',
    'Response headers:',
    resHeaders || '(none captured)',
    '',
    'Response body:',
    resBody,
    '--- END ---',
    '',
    'Your task:',
    '1. Find the code in this project that handles this endpoint or makes this call.',
    '2. Diagnose what went wrong, using the error code, response body, and any validation messages.',
    '3. Apply a minimal fix. Edit files in place; show the diff via your normal tools.',
    '',
    'If the failing endpoint is a third-party / upstream API (not in this repo), explain what the caller in THIS repo should change instead (different params, headers, payload shape, etc.).',
    '',
    'Keep the change tightly scoped to this error. Do not refactor surrounding code.',
  ].join('\n');
}

/**
 * Fire-and-forget telemetry. Sends an event name + tiny structured
 * context (method/status/fingerprint) so we can count auto-fix usage
 * without ever seeing the user's code, prompts, or bodies. Failures
 * are swallowed so a tracking outage never breaks the debug flow.
 */
async function trackDebugEvent(requestId, event, { log, source = 'cli' } = {}) {
  try {
    const payload = { event, source };
    if (log) {
      if (typeof log.method === 'string') payload.method = log.method;
      if (typeof log.status === 'number') payload.status = log.status;
      const fp = log.errorFingerprint?.key;
      if (typeof fp === 'string') payload.fingerprintKey = fp;
    }
    await fetch(`${SITE_URL}/api/logs/${requestId}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Don't block the user on slow telemetry.
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  } catch {
    /* swallow */
  }
}

/**
 * 3-way edit-permission picker. Only reached after the user has
 * already opted into "Fix it for me" at the top level, so by this
 * point they want help; the question is just whether they want the
 * Claude SDK to apply the edit, or they prefer to copy a prompt.
 *
 * Yes  -> run Claude Agent SDK in the user's repo (their tokens, their
 *         machine; the prompt is the only thing that leaves).
 * No   -> print the same prompt the SDK would have used so the dev
 *         can paste it into the AI of their choice.
 * Maybe-> explain the trust model, then re-prompt.
 */
async function offerFix({ log, requestId, cwd, p, CLI_NAME, displayId }) {
  const prompt = buildFixPrompt(log);

  while (true) {
    const choice = await singleSelect(
      [
        { label: 'Yes, use Claude SDK to edit', hint: 'Run Claude on your machine to find and fix the bug.' },
        { label: 'No, give me a prompt to fix it', hint: 'Print a prompt you can paste into any AI.' },
        { label: 'Maybe, tell me more first', hint: 'See exactly what happens before deciding.' },
      ],
      { message: 'Can I edit code directly?', defaultIndex: 0 },
    );

    if (choice === 0) {
      console.log('');
      void trackDebugEvent(requestId, 'fix.start', { log });
      try {
        await runAI(prompt, cwd);
        console.log('');
        console.log(`  ${p.green('✓')} Done. Review the changes with ${p.cyan('git diff')} before keeping them.`);
        console.log('');
        void trackDebugEvent(requestId, 'fix.complete', { log });
      } catch (err) {
        console.log(`\n  ${p.red('✗')} The fix run failed: ${err?.message || err}\n`);
        void trackDebugEvent(requestId, 'fix.failed', { log });
      }
      return;
    }

    if (choice === 1) {
      console.log('');
      console.log(`  ${p.bold('Paste this into your AI of choice:')}`);
      console.log(p.dim('  ' + '─'.repeat(60)));
      for (const line of prompt.split('\n')) console.log('  ' + line);
      console.log(p.dim('  ' + '─'.repeat(60)));
      console.log('');
      console.log(`  ${p.dim('Or re-run with:')} npx ${CLI_NAME} debug ${displayId}`);
      console.log('');
      void trackDebugEvent(requestId, 'fix.prompt_only', { log });
      return;
    }

    // Maybe: explain and loop back to the menu.
    console.log('');
    console.log(`  ${p.bold('Here\'s what "Yes" actually does:')}`);
    console.log(`    • Runs your locally-installed ${p.cyan('claude')} CLI in this repo (${cwd}).`);
    console.log(`    • Uses ${p.cyan('your')} Anthropic tokens. The request goes to ${p.cyan('api.anthropic.com')} and nowhere else.`);
    console.log(`    • Does not contact Restless servers, third parties, or upload anything.`);
    console.log(`    • File edits are confined to this git repo (path guard rejects writes outside it).`);
    console.log(`    • You can review every change with ${p.cyan('git diff')} before keeping it.`);
    console.log('');
    void trackDebugEvent(requestId, 'fix.explained', { log });
  }
}

function hasCodex() {
  try {
    execSync('which codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Codex stores auth in ~/.codex/auth.json after `codex login`. We also accept
// OPENAI_API_KEY as a fallback because env-only setups skip the login dance
// entirely. We check both rather than running `codex` itself, since spawning
// the CLI just to validate auth is slow and noisy.
function hasCodexAuth() {
  if (process.env.OPENAI_API_KEY) return true;
  try {
    return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
  } catch {
    return false;
  }
}


const command = process.argv[2];

/**
 * One-shot banner shown when `--debug` is on. Makes it impossible to
 * miss that the run is being captured and uploaded - keeps the user
 * in control even though they enabled it themselves. Returns nothing
 * when debug is off.
 */
async function showDebugBanner() {
  if (!debugEnabled) return;
  console.log('');
  console.log(`  ${bold(yellow('⚠  Debug mode is on.'))}`);
  console.log(`  ${dim('Everything in this run - your input, the AI tool calls, output, and errors -')}`);
  console.log(`  ${dim('will be uploaded to the Restless team when the CLI exits.')}`);
  console.log(`  ${dim('Normal runs send nothing. Re-run without --debug to disable.')}`);
  console.log('');
}

await showDebugBanner();

/**
 * Default screen. Shown when the CLI is run with no command (`npx restless`)
 * or an explicit `help` / `--help` / `-h`. Leads with the logo + the
 * one-liner pitch, then lists every command with a short hint, and ends
 * by pointing first-timers at `init`. Mirrors the welcome copy so the
 * brand voice is consistent whether you land here or in the setup flow.
 */
/**
 * Read the package version from this package's package.json. Resolved
 * relative to this file (not cwd) so it reports the installed CLI's
 * version no matter where the user ran it from. Falls back to a
 * placeholder if the file can't be read - the version string is
 * informational and should never be able to crash the CLI.
 */
// Root of the installed package - where the guides and prompts we ship live.
const PKG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Put text on the system clipboard. Returns false when there's no clipboard
 * tool available (headless Linux, a container, an SSH session), so callers
 * can fall back to printing the text instead of claiming a copy that never
 * happened.
 */
function copyToClipboard(text) {
  const cmds = process.platform === 'darwin' ? ['pbcopy']
    : process.platform === 'win32' ? ['clip']
    : ['wl-copy', 'xclip -selection clipboard', 'xsel --clipboard --input'];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch {}
  }
  return false;
}

/**
 * The welcome screen's [d] key: set up on the demo repo instead of the
 * user's own code.
 *
 * Does what we used to print and ask them to type:
 *
 *     git clone git@github.com:restlesshq/demo.git && cd demo && npx restless init
 *
 * The `init` half isn't a second process - we chdir into the clone and let
 * this run continue into the normal setup, so the demo gets the same screens,
 * the same debug log, and the same version of the CLI they already invoked.
 *
 * Returns the clone directory, or null when we couldn't get there (git
 * missing, no network, nowhere to put it) - having printed the two commands
 * to run by hand. The caller exits on null.
 */
function cloneDemoAndEnter() {
  console.log('');
  console.log(`  ${bold('Trying this on a demo repo.')}`);
  console.log('');
  console.log(`  ${dim(`We'll clone ${DEMO_REPO} and run setup in there, so you can`)}`);
  console.log(`  ${dim('watch the whole thing without it touching your own code.')}`);
  console.log('');

  const parentDir = process.cwd();
  const spinner = startSpinner(`Cloning ${DEMO_REPO}…`);
  let result;
  try {
    result = cloneDemoRepo({
      parentDir,
      onAttempt: (url) => spinner.update(`Cloning ${url}…`),
    });
  } finally {
    spinner.stop();
  }
  debug.log('init.demo-repo', {
    ok: result.ok,
    reason: result.reason,
    reused: result.reused,
    dir: result.dir,
    url: result.url,
    attempts: result.attempts,
  });

  if (!result.ok) {
    console.log('');
    if (result.reason === 'no-git') {
      console.log(`  ${red('✗')} ${bold("Couldn't find git")}, so we can't clone the demo repo.`);
    } else if (result.reason === 'no-dir') {
      console.log(`  ${red('✗')} ${bold('Nowhere to put the clone')} - ${cyan('./demo')} and its siblings are taken.`);
    } else {
      console.log(`  ${red('✗')} ${bold("Couldn't clone the demo repo.")}`);
      for (const attempt of result.attempts || []) {
        console.log(`    ${dim(`${attempt.url}: ${attempt.error || 'failed'}`)}`);
      }
    }
    console.log('');
    console.log(`  Clone it yourself and run setup there:`);
    console.log('');
    console.log(`    ${cyan(`git clone ${DEMO_REPO_SSH_URL}`)}`);
    console.log(`    ${cyan(`cd ${DEMO_DIR_NAME} && npx ${CLI_NAME} init`)}`);
    console.log('');
    return null;
  }

  // `cd demo`: everything downstream reads the cwd - the OAS scan, the SDK
  // install target, where `.restless/` lands. The path guard is re-pointed
  // with it so its ceiling is the demo clone rather than the repo the user
  // happened to be standing in when they pressed [d].
  process.chdir(result.dir);
  setGitRoot(findGitRoot(result.dir) || result.dir);

  console.log('');
  const shown = path.relative(parentDir, result.dir) || result.dir;
  if (result.reused) console.log(`  ${green('✓')} Using the demo repo you already have at ${cyan(shown)}`);
  else console.log(`  ${green('✓')} Cloned into ${cyan(shown)}`);
  console.log('');
  return result.dir;
}

function readVersion() {
  try {
    const pkgPath = path.join(PKG_DIR, 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function printHelp() {
  console.log('');
  printLogo();
  console.log('');
  console.log(`  ${white('Restless makes sure every API call turns out')} ${green('200 Okay')}${white('.')}`);
  console.log('');
  console.log(`  ${bold('Usage')}`);
  console.log(`    ${cyan(`npx ${CLI_NAME}`)} ${dim('<command>')}`);
  console.log('');
  console.log(`  ${bold('Commands')}`);
  const rows = [
    ['init', 'Set up Restless here: scan your code, install the SDK, wire it in'],
    ['context', 'Read this repo and teach the AI how your API is meant to be used'],
    ['debug <request-id>', 'Inspect a request, ask AI about it, or have it fixed for you'],
    ['update [projectId]', 'Refresh your spec, edit settings, and sync both to the dashboard'],
    ['help', 'Show this help'],
    ['--version', 'Print the installed CLI version'],
  ];
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, hint] of rows) {
    console.log(`    ${cyan(name.padEnd(width))}  ${dim(hint)}`);
  }
  console.log('');
  // Listed apart from the main commands: these are the pieces a coding agent
  // calls while doing the setup itself (run `init` inside one and it prints
  // the plan that uses them). A human running setup never needs them.
  console.log(`  ${bold('For coding agents')}`);
  const agentRows = [
    ['guide [oas|sdk]', 'Print the instructions for writing the spec / wiring the SDK'],
    ['key', 'Register the project and put RESTLESS_KEY in .env'],
    ['register --oas <f>', 'Record a spec in .restless/settings.json'],
    ['verify --url <u>', 'Send one request, confirm the SDK saw it and the log landed'],
    ['login', 'Print the URL the user opens to claim the project'],
  ];
  const agentWidth = Math.max(...agentRows.map(([name]) => name.length));
  for (const [name, hint] of agentRows) {
    console.log(`    ${cyan(name.padEnd(agentWidth))}  ${dim(hint)}`);
  }
  console.log('');
  console.log(`    ${dim(`Not Claude Code or Codex? Add ${cyan('--agent <name>')}${'\x1b[2m'} (or set`)}`);
  console.log(`    ${dim(`${cyan('RESTLESS_AGENT')}${'\x1b[2m'}) so the project records which agent set it up.`)}`);
  console.log('');
  console.log(`  ${bold('Flags for')} ${cyan('context')}`);
  const contextFlags = [
    ['--project <id>', "Which project to send to (defaults to this repo's own)"],
    ['--full', 'Re-read everything, ignoring where the last run got to'],
    ['--dry-run', 'Show what would be sent, and send nothing'],
    ['--yes', 'Skip the confirmation'],
  ];
  const ctxWidth = Math.max(...contextFlags.map(([name]) => name.length));
  for (const [name, hint] of contextFlags) {
    console.log(`    ${cyan(name.padEnd(ctxWidth))}  ${dim(hint)}`);
  }
  console.log('');
  // `update` needs no TTY when it's told exactly what to do, which is the
  // only way an agent or a CI job can drive it.
  console.log(`  ${bold('Flags for')} ${cyan('update')} ${dim('(any of these skips the prompts)')}`);
  const flagWidth = Math.max(...UPDATE_FLAGS.map(([name]) => name.length));
  for (const [name, hint] of UPDATE_FLAGS) {
    console.log(`    ${cyan(name.padEnd(flagWidth))}  ${dim(hint)}`);
  }
  console.log('');
  console.log(`  ${dim('New here? Run')} ${cyan(`npx ${CLI_NAME} init`)} ${dim('to get started.')}`);
  console.log('');
}

if (command === '--version' || command === '-v' || command === 'version') {
  console.log(readVersion());
  await debug.flushAndExit(0);
} else if (!command || command === 'help' || command === '--help' || command === '-h') {
  printHelp();
  await debug.flushAndExit(0);
} else if (
  (command === 'init' || command === 'setup' || command === 'supercharge') &&
  isAgent() &&
  !process.argv.includes('--self-drive')
) {
  // ── Driven by a coding agent: hand over instructions, don't self-drive ──
  // Running our own model here means editing the caller's repo from inside a
  // child process: no diffs in their session, nothing to interrupt, and a
  // second agent re-deriving context the caller already has. Print the
  // playbook and let them do the code work in the open. `--self-drive`
  // restores the old behaviour for CI and for agents that would rather
  // delegate the whole thing.
  const { rootDir: agentRoot } = resolveProjectDirs(process.cwd());

  // Same gate the interactive path applies in generate-oas, checked here too
  // because this branch hands over a playbook and exits without ever reaching
  // detection. Without it an agent pointed at a Django repo gets told to run
  // `npm install @restlessai/sdk` and wire Express middleware.
  let agentLanguages = ['javascript'];
  if (!stackCheckDisabled()) {
    const stack = detectStack(agentRoot);
    debug.log('init.agent-plan.stack-check', {
      supported: stack.supported,
      languages: stack.languages,
      nodeEvidence: stack.nodeEvidence,
    });
    if (!stack.supported) {
      const { headline, details } = unsupportedStackMessage(stack, {
        rootDir: agentRoot,
        cliName: CLI_NAME,
      });
      try {
        fatalError(headline, details);
      } catch {
        // fatalError throws FatalExit to stop its caller; here we're already
        // at the exit, so swallow it and flush on the failure code.
      }
      await debug.flushAndExit(1);
    }
    agentLanguages = stack.setupLanguages;
  }

  // `agentSlug` is null when we can tell an agent is driving but not which
  // one (a piped run from an agent we have no marker for). The playbook uses
  // that to ask the reader to identify itself, so the next command it runs
  // can report a name instead of a blank.
  const agentSlug = detectAgent();
  console.log(buildAgentPlan({
    rootDir: agentRoot,
    cli: CLI_NAME,
    agent: agentLabel(agentSlug),
    agentSlug,
    languages: agentLanguages,
  }));
  debug.log('init.agent-plan', { agent: agentSlug, rootDir: agentRoot });
  await debug.flushAndExit(0);

} else if (command === 'init' || command === 'setup' || command === 'supercharge') {
  // Set when the user picked the demo repo at the welcome screen ([d]): the
  // clone we chdir'd into, so the screens below can say where setup is
  // running. Null for an ordinary run in the user's own repo.
  let demoDir = null;

  // ── Welcome screen ────────────────────────────────────────────────────
  // Clear viewport + scrollback so the welcome starts at the top of the
  // terminal, matching where every subsequent screen lands after each
  // transition clears + homes the cursor.
  if (isInteractive()) {
  clearScreen();
  console.log('');
  // Swallow keystrokes for the whole animated intro so they don't echo into
  // the text being typed out (and don't queue up to skip the CTA). Restored
  // in the `finally` right before we start listening for the real keypress.
  const restoreInput = suppressInput();
  let arrowInterval = null;
  let welcomeKey;
  try {
  await animateLogoIn();
  console.log('');

  // "Restless helps make [400 Bad Request] into [200 Okay]."
  // Each status code shows a brief spinner, then settles into a colored
  // circle + the code, and typing continues. No erase-and-replace -
  // the spinner lands in place where the circle ends up.
  // Swap `spinnerStyle` to try: arc, halfcircle, piefill, pulse, sparkle, concentric, braille
  const spinnerStyle = 'concentric';

  await typeOut(white(`  Restless makes sure every `));
  await inlineStatus({ code: '400 Bad Request', success: false, style: spinnerStyle });
  await typeOut(white(` turns out `));
  await inlineStatus({ code: '200 Okay', success: true, style: spinnerStyle });
  await typeLine(white(`.`));
  console.log('');

  await typeLine(muted(`  It's not just another observability platform (although you can use it`), { delay: 11 });
  await typeLine(muted(`  to see what your users are up to!).`), { delay: 11 });
  console.log('');
  await typeLine(muted(`  Think of us more as an API success platform. We give humans, AI and`), { delay: 11 });
  await typeLine(muted(`  you the tools to quickly make successful calls.`), { delay: 11 });
  console.log('');
  await typeLine(`  ${bold('Ready to supercharge your API?')}`);
  console.log('');

  // Boxed CTA: the focal point of the welcome. The trailing ⏎ pulses while
  // we wait for input, so we hide the native blinking cursor - one cue
  // instead of two. Box, label, and ⏎ all use the brand blue so the
  // call to action ties back to the logo.
  const ctaText = 'Press ENTER to get started';
  const boxBody = `  ${ctaText}  ⏎  `;
  const w = boxBody.length;
  console.log(`  ${brand('╭' + '─'.repeat(w) + '╮')}`);
  console.log(`  ${brand('│')}  ${brand(ctaText)}  ${brand('⏎')}  ${brand('│')}`);
  console.log(`  ${brand('╰' + '─'.repeat(w) + '╯')}`);
  console.log('');
  console.log(`  ${dim("We use AI for the setup, but we'll ask permission before we do anything.")}`);
  console.log(`  ${dim(`Press [${bold('d')}${'\x1b[2m'}] to try this on a demo repo · Press [${bold('h')}${'\x1b[2m'}] to set up time with a human`)}`);

  process.stdout.write('\x1b[?25l'); // hide terminal cursor while we own the screen
  process.stdout.write('\x1b7');     // save current row as the home position for the animation

  // Pulse: dim → blue → bold blue → blue, repeat. Cycles through ~1.1s.
  // The ⏎ lives 5 rows above the saved cursor (3 box rows + blank + 2 dim
  // copy rows). Its column is the box content offset: 2 indent + 1 border +
  // 2 pad + label + 2 pad = ctaText.length + 8.
  const iconCol = ctaText.length + 8;
  const enterFrames = [dim('⏎'), brand('⏎'), bold(brand('⏎')), brand('⏎')];
  let enterFrame = 0;
  arrowInterval = setInterval(() => {
    enterFrame = (enterFrame + 1) % enterFrames.length;
    process.stdout.write(`\x1b8\x1b[5A\x1b[${iconCol}G` + enterFrames[enterFrame] + '\x1b8');
  }, 280);
  } finally {
    // Hand stdin back the way waitForKey expects it (cooked, paused).
    restoreInput();
  }

  while (true) {
    welcomeKey = await waitForKey();
    if (
      welcomeKey === '\r' || welcomeKey === '\n' ||
      welcomeKey === 'd' || welcomeKey === 'D' ||
      welcomeKey === 'h' || welcomeKey === 'H'
    ) break;
  }

  clearInterval(arrowInterval);
  process.stdout.write('\x1b[?25h'); // show cursor again
  process.stdout.write('\n');         // start subsequent output on a fresh line

  if (welcomeKey === 'd' || welcomeKey === 'D') {
    // Clone the demo repo, cd into it, and fall through into the same setup
    // ENTER would have started - just pointed at the demo instead of their
    // own code. Nothing to do but leave when the clone didn't come down;
    // cloneDemoAndEnter has already printed the commands to run by hand.
    demoDir = cloneDemoAndEnter();
    if (!demoDir) await debug.flushAndExit(1);
  }

  if (welcomeKey === 'h' || welcomeKey === 'H') {
    const { execSync } = await import('child_process');
    console.log('');
    console.log(`  ${dim(`Opening ${CALENDLY_URL} in your browser...`)}`);
    console.log('');
    try {
      if (process.platform === 'darwin') execSync(`open "${CALENDLY_URL}"`);
      else if (process.platform === 'win32') execSync(`start "${CALENDLY_URL}"`);
      else execSync(`xdg-open "${CALENDLY_URL}"`);
    } catch {}
    await debug.flushAndExit(0);
  }

  // ENTER: continue normal setup.
  // Clear the viewport + scrollback so the welcome doesn't linger.
  clearScreen();
  } else {
    // Non-interactive (agent / CI / pipe): skip the animated welcome and its
    // ENTER / demo / human-handoff gate entirely - there's no TTY to drive
    // any of it, and an agent just needs setup to proceed.
    console.log('');
    console.log(`  ${bold('Restless')}: setting up in non-interactive mode.`);
    console.log('');
  }
  // ──────────────────────────────────────────────────────────────────────

  const plan = createPlanManager();

  // Logo + the four steps: the fixed part of the pre-setup screen. Anything
  // below it is a question, and questions get replaced rather than stacked -
  // so this is redrawable.
  function drawSetupHeader() {
    console.log('');
    // No separate printLogo() here - drawInitial draws the logo beside the
    // steps, the same frame the run itself uses, so nothing jumps when the
    // setup starts.
    plan.drawInitial();
    console.log('');
    // The welcome screen said what it cloned, but that screen is cleared by
    // now - and cleared again on the way to the alternatives picker. Part of
    // the header rather than one call site, so "which repo is this touching?"
    // is answerable from whichever screen the user is looking at.
    if (demoDir) {
      console.log(`  ${dim('Setting up on the demo repo at')} ${cyan(`./${path.basename(demoDir)}`)}`);
      console.log('');
    }
  }

  drawSetupHeader();
  const claudeInstalled = hasClaude();
  const codexInstalled = hasCodex();
  // Three short promises beat a paragraph: the old copy explained the
  // architecture ("talks to our SDKs directly") when all anyone wants to know
  // is whose machine the AI runs on and whether anything leaves it.
  console.log(`  ${bold("Let's get you set up!")} Here's how it works:`);
  console.log('');
  console.log(`  ${dim('·')} We use your local Agent for setup`);
  console.log(`  ${dim('·')} Your code is never seen by Restless`);
  console.log(`  ${dim('·')} We won't upload anything until the end`);
  // No blank line here - the picker opens with one of its own.

  // Name the agent the user actually has. Offering "Claude or Codex" as a
  // first decision makes them choose a tool before they've agreed to the
  // approach; the alternatives live one level down, behind "No".
  const preferred = claudeInstalled || !codexInstalled ? 'claude' : 'codex';
  const preferredLabel = preferred === 'claude' ? 'Claude' : 'Codex';

  // `choice` keeps the meanings the branches below already handle:
  // 0 = Claude, 1 = Codex, 2 = book a call, 3 = learn more, 4 = copy a
  // prompt, 5 = manual setup.
  let choice;
  if (!isInteractive()) {
    // Non-interactive: never offer anything that needs a human. Prefer the
    // agent actually driving us - if Codex is running the CLI, `claude` may
    // not even be installed - then fall back to whatever's available so we
    // still surface a clear "install X" message if neither is.
    const agent = detectAgent();
    if (agent === 'codex' && codexInstalled) choice = 1;
    else if (agent === 'claude' && claudeInstalled) choice = 0;
    else if (claudeInstalled) choice = 0;
    else if (codexInstalled) choice = 1;
    else choice = 0;
    console.log(`  ${dim(`Using ${['Claude', 'Codex'][choice]} to run setup.`)}`);
  } else {
    const useAgent = await singleSelect(
      [
        {
          label: `Yes, use ${preferredLabel} ${dim('(recommended)')}`,
          hint: (preferred === 'claude' ? claudeInstalled : codexInstalled)
            ? `Runs locally on your machine. You'll see every change.`
            : `${preferredLabel} isn't installed yet - we'll show you how.`,
        },
        { label: 'No, other options', hint: 'Copy a prompt, set it up by hand, or talk to us first.' },
      ],
      { message: 'Is it okay if we set up using your Agent?', defaultIndex: 0 },
    );

    if (useAgent === 0) {
      choice = preferred === 'claude' ? 0 : 1;
    } else {
      // Replace, don't append. The three promises are about handing work to
      // their agent - moot once they've declined - and leaving the answered
      // question above the new one reads as two open questions at once.
      clearScreen();
      drawSetupHeader();
      const alt = await singleSelect(
        [
          { label: 'Copy a prompt for your Agent', hint: 'Paste it into any agent and it runs the setup itself.' },
          { label: 'Manual setup', hint: 'Do it by hand - we print the steps and the commands.' },
          { label: 'Book a quick installation call', hint: "We'll pair on it with you." },
          { label: 'Learn more', hint: 'Ask us anything about what setup does before deciding.' },
        ],
        { message: 'How would you like to set this up?', defaultIndex: 0 },
      );
      choice = [4, 5, 2, 3][alt];
    }
  }

  // Clear the viewport so after-selection stuff starts clean at the top.
  // Skip in non-interactive mode - clearing the scrollback just destroys the
  // output an agent is reading.
  if (isInteractive()) clearScreen();

  if (choice === 3) {
    // "Learn more" - a Q&A loop rather than a wall of text. Someone who
    // picked this has a specific worry (what gets read? what gets uploaded?
    // what happens to my middleware?), and a static page answers whichever
    // three we guessed at.
    console.log('');
    console.log(`  ${bold('Ask us anything about the setup')}`);
    console.log('');
    console.log(dim(`  What we touch, what we upload, how to undo it - anything.`));
    console.log(dim(`  Answered locally by ${preferredLabel}. Press ENTER on an empty line to leave.`));
    console.log('');

    const canAnswer = preferred === 'claude' ? claudeInstalled : codexInstalled;
    if (!canAnswer) {
      console.log(`  ${yellow('!')} ${preferredLabel} isn't installed, so we can't answer questions here.`);
      console.log('');
      console.log(`  The short version: we read your code locally to write an OpenAPI spec and`);
      console.log(`  wire in the SDK. Nothing is uploaded until the last step, when you sign in`);
      console.log(`  to claim the project.`);
      console.log('');
      await debug.flushAndExit(0);
    }
    setProvider(preferred);

    while (true) {
      const q = (await ask(`  ${cyan('?')} `)).trim();
      if (!q) break;
      console.log('');
      let answer;
      try {
        answer = await runAI(loadPrompt('learn-more-chat', { question: q, cli: CLI_NAME }), process.cwd());
      } catch (err) {
        answer = `Couldn't reach ${preferredLabel} (${err.message}).`;
      }
      for (const line of String(answer).trim().split('\n')) console.log(`  ${line}`);
      console.log('');
    }
    console.log('');
    console.log(`  Run ${cyan(`npx ${CLI_NAME} init`)} again when you're ready.`);
    console.log('');
    await debug.flushAndExit(0);
  }

  if (choice === 4) {
    // "Copy a prompt for your Agent" - the same playbook `init` prints when
    // it detects it's being run inside an agent, handed over for a paste.
    const { rootDir: promptRoot } = resolveProjectDirs(process.cwd());
    const promptText = buildAgentPlan({ rootDir: promptRoot, cli: CLI_NAME, agent: 'your agent' });
    const copied = copyToClipboard(promptText);

    console.log('');
    if (copied) {
      console.log(`  ${green('✓')} Copied to your clipboard.`);
      console.log('');
      console.log(`  Paste it into Claude Code, Codex, Cursor, or whatever you use. It has`);
      console.log(`  everything they need: the steps, the rules, and the commands to call.`);
    } else {
      console.log(`  ${bold('Paste this into your agent:')}`);
      console.log('');
      console.log(dim('  ─'.repeat(34)));
      for (const line of promptText.split('\n')) console.log(`  ${line}`);
      console.log(dim('  ─'.repeat(34)));
    }
    console.log('');
    console.log(dim(`  Your agent can also just run ${bold(`npx ${CLI_NAME} init`)}${'\x1b[2m'} itself - it prints these`));
    console.log(dim(`  same instructions when it detects an agent driving it.`));
    console.log('');
    await debug.flushAndExit(0);
  }

  if (choice === 5) {
    // "Manual setup" - real instructions now that each deterministic piece
    // has its own command. Previously this just offered to book a call.
    console.log('');
    console.log(`  ${bold('Setting up by hand')}`);
    console.log('');
    console.log(`  ${green('1.')} ${bold('Write an OpenAPI spec')} for your API at ${cyan('.restless/openapi.json')}, then:`);
    console.log(`     ${cyan(`npx ${CLI_NAME} register --oas .restless/openapi.json --dir <your-api-dir>`)}`);
    console.log(dim(`     Already have a spec? Point that command at it - any path works.`));
    console.log('');
    console.log(`  ${green('2.')} ${bold('Get your key')} (registers the project, writes ${cyan('RESTLESS_KEY')} to ${cyan('.env')}):`);
    console.log(`     ${cyan(`npx ${CLI_NAME} key`)}`);
    console.log('');
    console.log(`  ${green('3.')} ${bold('Install and wire the SDK.')} Install ${cyan('@restlessai/sdk')}, then follow:`);
    console.log(`     ${cyan(`npx ${CLI_NAME} guide sdk`)}`);
    console.log(dim(`     The one thing to get right: register the middleware above any auth`));
    console.log(dim(`     guard, so a rejected 401 still reaches the SDK.`));
    console.log('');
    console.log(`  ${green('4.')} ${bold('Check it.')} Start your server, then:`);
    console.log(`     ${cyan(`npx ${CLI_NAME} verify --url http://localhost:3000`)}`);
    console.log('');
    console.log(`  ${green('5.')} ${bold('Claim the project:')} ${cyan(`npx ${CLI_NAME} login`)}`);
    console.log('');
    console.log(dim(`  Stuck? ${bold(`npx ${CLI_NAME} init`)}${'\x1b[2m'} does all of this for you.`));
    console.log('');
    await debug.flushAndExit(0);
  }

  if (choice === 0 && !claudeInstalled) {
    console.log('');
    console.log(red('  ✗ Claude is not installed.\n'));
    console.log('  Install it with:');
    console.log(cyan('    npm install -g @anthropic-ai/claude-code'));
    console.log('');
    console.log(`  Then rerun ${cyan(`npx ${CLI_NAME} init`)}.\n`);
    await debug.flushAndExit(1);
  }

  if (choice === 1 && !codexInstalled) {
    console.log('');
    console.log(red('  ✗ Codex is not installed.\n'));
    console.log('  Install it with:');
    console.log(cyan('    npm install -g @openai/codex'));
    console.log('');
    console.log(`  Then rerun ${cyan(`npx ${CLI_NAME} init`)}.\n`);
    await debug.flushAndExit(1);
  }

  if (choice === 1 && !hasCodexAuth()) {
    console.log('');
    console.log(red("  ✗ Codex isn't logged in.\n"));
    console.log('  Sign in with:');
    console.log(cyan('    codex login'));
    console.log('');
    console.log(`  ${dim(`Or set ${cyan('OPENAI_API_KEY')}${'\x1b[2m'} in your env.`)}`);
    console.log('');
    console.log(`  Then rerun ${cyan(`npx ${CLI_NAME} init`)}.\n`);
    await debug.flushAndExit(1);
  }

  // Pick the AI provider before any step calls runAI(). Manual / Learn-more
  // never reach here.
  if (choice === 0) setProvider('claude');
  else if (choice === 1) setProvider('codex');

  // The same choice in the two shapes the rest of the run needs: a label for
  // the screens ("Claude Code is reading your routes…") and a slug recorded
  // on the project as the agent that ran this setup.
  const setupAgent = ['claude', 'codex'][choice] || 'claude';
  const setupAiTool = setupAgent === 'codex' ? 'Codex' : 'Claude Code';

  // "Book a quick installation call" - hand off to a human.
  if (choice === 2) {
    console.log('');
    console.log(`  ${bold("Let's set it up together.")}`);
    console.log('');
    console.log(`  Pick a time that works and we'll walk through it with you - bring`);
    console.log(`  whatever's odd about your setup.`);
    console.log('');
    process.stdout.write(`  ${dim(`Press ENTER to open ${CALENDLY_URL} in your browser`)}`);
    while (true) {
      const k = await waitForKey();
      if (k === '\r' || k === '\n') break;
    }
    console.log('');
    console.log('');
    try {
      if (process.platform === 'darwin') execSync(`open "${CALENDLY_URL}"`);
      else if (process.platform === 'win32') execSync(`start "${CALENDLY_URL}"`);
      else execSync(`xdg-open "${CALENDLY_URL}"`);
    } catch {}
    await debug.flushAndExit(0);
  }
  // packageDir = where the user ran the command (scopes what we analyze)
  // rootDir = git root (where .restless/ lives)
  const { packageDir, rootDir } = resolveProjectDirs(process.cwd());

  // Pin the plan view; from here on, render() manages the whole screen.
  // No textual header - the logo + step list inside the plan is the heading.
  plan.setHeader(['']);
  plan.pin();
  setupInProgress = true;

  const { setSpinner } = plan;

  // Step 1: Generate OAS file - always run so the user sees the intro screen,
  // even on re-runs where an OAS already exists. generateOas decides internally
  // whether to re-scan or reuse.
  const oasResult = await generateOas({
    packageDir,
    rootDir,
    update: plan.makeUpdater(0),
    setSpinner,
    aiTool: setupAiTool,
  });

  debug.log('discovered', {
    language: oasResult.detectedLanguage,
    framework: oasResult.detectedFramework,
    domain: oasResult.domain,
    apiRootDir: oasResult.apiRootDir,
  });

  // Build the SetupContext once we know the project shape. Every step
  // downstream reads from this object and writes back into it - no step
  // re-derives keyDelivery / envLoader / sdkLineSpec.
  //
  // `installDir` (where the dependency goes) and `apiDir` (where `.env` goes)
  // are the same directory by design - the SDK and the key it reads have to
  // land in the same project. They used to be computed by two separate
  // helpers, `resolveInstallDir` and `resolveApiDir`, which is how they were
  // able to disagree.
  const owningDir = resolveOwningDir(packageDir, oasResult.apiRootDir, oasResult.detectedLanguage);
  const ctx = createSetupContext({
    packageDir,
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    installDir: owningDir,
    apiDir: owningDir,
    language: oasResult.detectedLanguage,
    framework: oasResult.detectedFramework,
    aiTool: setupAiTool,
    agent: setupAgent,
  });
  debug.log('setup-context', redactSetupContext(ctx));

  // Step 2: Install SDK. Order of subs (matches what the user sees):
  //   0. Install package
  //   1. Generate API key (delegated to prepareAccount via callback so the
  //      visible substep order matches the actual run order - install
  //      happens first, then key gen, then the AI wires the middleware)
  //   2. Configure SDK
  // The source-file edit in Configure SDK still triggers a watcher restart
  // that picks up the just-written .env from step 1.
  await installSdk({
    ctx,
    update: plan.makeUpdater(1),
    setSpinner,
    prepareAccountStep: () => prepareAccount({ ctx, update: plan.makeUpdater(1), setSpinner }),
  });
  debug.log('setup-context-after-install', redactSetupContext(ctx));

  // Tag the debug log with the metrics project id so staff can join
  // back to the dashboard once the user claims this project (the same
  // UUID becomes Project.metricsId at claim time).
  const projectApi = loadSettings(rootDir).apis?.find((a) => a.projectId === ctx.projectId);
  debug.log('project', {
    id: ctx.projectId,
    name: projectApi?.name || null,
    domain: projectApi?.baseUrl || oasResult.domain || null,
  });

  // Still part of "Configure SDK" (sub 2), not a row of its own: semantic
  // verification of owner.id is an AI pass over the block the configure step
  // just wrote. It catches what the static heuristic in final-checks can't -
  // a tenant id pulled from req.body in a codebase where the static check
  // sees `req.user.tenantId` but the user object came from unsigned input
  // upstream.
  const verifyUpdate = plan.makeUpdater(1);
  verifyUpdate({ activeSub: 2, sub: { 0: 'done', 1: 'done' } });

  // These were the install's last two AI calls, run back to back, and both
  // only need the wired file - so the read-only one starts here and runs
  // under the owner.id pass instead of after it. `finalChecks` uses its
  // result only if the file is still byte-identical to what it reviewed,
  // since `verifyOwnerId` may rewrite the `owner.id` line; otherwise it
  // re-runs the review itself. See `startWiringReview`.
  const pendingReview = startWiringReview({ ctx });

  await verifyOwnerId({ ctx, update: (msg) => verifyUpdate({ ...msg, activeSub: 2 }), setSpinner });

  // Step 2 sub 3: Run final checks. Verifies the install is correct and
  // surfaces issues for the user to opt into fixing - it never edits the
  // SDK init line itself (that's the CLI's responsibility, not the AI's).
  await finalChecks({
    ctx,
    update: plan.makeUpdater(1),
    setSpinner,
    subIndex: 3,
    prevSubs: { 0: 'done', 1: 'done', 2: 'done' },
    pendingReview,
  });
  plan.makeUpdater(1)({ status: 'done', sub: { 0: 'done', 1: 'done', 2: 'done', 3: 'done' } });

  // Step 3: Test your setup (auto-detect the server, confirm the SDK sees
  // requests, and offer an AI fix loop when it doesn't).
  await testSetup({
    packageDir,
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    setSpinner,
    update: plan.makeUpdater(2),
    domain: oasResult.domain,
    projectId: ctx.projectId,
    setupKey: ctx.setupKey,
    ctx,
  });

  // Step 4: Set up account (log in + upload OAS specs).
  await setupAccount({
    rootDir,
    apiRootDir: oasResult.apiRootDir,
    update: plan.makeUpdater(3),
    setSpinner,
    apiKey: ctx.apiKey,
    projectId: ctx.projectId,
    setupKey: ctx.setupKey,
  });

  setupInProgress = false;

} else if (command === 'guide') {
  // ── npx restless guide [oas|sdk|<language>] ────────────────────────────
  // Hands out the same instruction sets the CLI's own model runs on, so a
  // calling agent works from the tested wording rather than an improvised
  // summary of it. Plain markdown on stdout - meant to be read by a model.
  const topic = (process.argv[3] || '').toLowerCase();

  if (topic === 'oas' || topic === 'spec' || topic === 'openapi') {
    const { rootDir: guideRoot, packageDir: guidePkgDir } = resolveProjectDirs(process.cwd());
    const guideSettings = loadSettings(guideRoot);
    const guideApi = guideSettings.apis?.[0];
    // Same deterministic base-URL guess the guided flow prefolds into its
    // user prompt - deploy manifests, env templates, the README. Handing the
    // agent a vetted candidate is what keeps localhost out of servers[0].url.
    const guess = guideApi?.baseUrl ? null : guessBaseUrl({ dirs: [guidePkgDir, guideRoot] });
    const domainInstruction = guess
      ? `${guess.url} (deterministic guess from ${guess.source} - verify it against the code; if it's wrong and you can't confirm the real public URL, ask the user)`
      : '(unknown. Ask the user for the API\'s PUBLIC base URL - never put localhost, 127.0.0.1, or a dev port in servers[0].url. If the user confirms no public URL exists, use a relative mount path like "/" instead)';
    // The prompt is normally rendered with values the guided run has already
    // worked out. Here the agent is the one who works them out, so the
    // placeholders that would carry them become instructions instead.
    const rendered = loadPrompt('generate-oas', {
      name: guideApi?.name || path.basename(guideRoot),
      oasFile: path.join(guideRoot, '.restless', 'openapi.json'),
      domain: guideApi?.baseUrl || domainInstruction,
      existingOasNote: '',
      internalNote: '',
      // The guided run pre-computes a route checklist and pastes it here.
      // You're the one reading the code, so the instruction takes its place -
      // otherwise the coverage rule below refers to a checklist that isn't there.
      endpointChecklist: 'Enumerate the routes yourself from the code first, and treat that list as the coverage checklist referred to below.',
      frameworkNote: '',
    });
    // Belt and braces: never leak raw template syntax into a model's context
    // if the prompt grows a placeholder this command doesn't know about.
    console.log(rendered.replace(/\{\{[a-zA-Z]+\}\}/g, '').replace(/\n{3,}/g, '\n\n'));
    await debug.flushAndExit(0);
  }

  // `guide sdk` must resolve to the language of THIS repo, not to JavaScript.
  // The agent playbook tells the reader to run exactly that command, so a
  // hardcoded default handed an agent working in a Django project the
  // Express/Next wiring instructions - confidently, and in full.
  //
  // Order: an explicit `guide python` wins, then what setup recorded in
  // .restless/settings.json, then a fresh detection pass, then JavaScript.
  let lang;
  if (topic && topic !== 'sdk') {
    lang = normalizeLanguage(topic);
  } else {
    const { rootDir: gRoot, packageDir: gPkg } = resolveProjectDirs(process.cwd());
    const recorded = loadSettings(gRoot).apis?.[0]?.language;
    if (recorded) {
      lang = normalizeLanguage(recorded);
    } else {
      let routed = [];
      try { routed = detectStack(gPkg).setupLanguages; } catch {}
      // Prefer a non-JS routed language: a Python repo with a package.json
      // for its frontend routes as both, and the SDK guide it needs is the
      // one for the API, not the one for the build tooling.
      lang = normalizeLanguage(routed.find((l) => l !== 'javascript' && l !== 'typescript') || routed[0] || 'javascript');
    }
  }
  // TypeScript shares the JavaScript guide.
  if (lang === 'typescript') lang = 'javascript';
  const guidePath = path.join(PKG_DIR, 'docs', 'sdks', `${lang}.md`);
  if (!fs.existsSync(guidePath) || lang.startsWith('_')) {
    // `_`-prefixed files are archived guides, not something to offer.
    const available = fs.readdirSync(path.join(PKG_DIR, 'docs', 'sdks'))
      .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
      .map((f) => f.replace(/\.md$/, ''));
    console.log(red(`\n  ✗ No guide for "${topic}".\n`));
    console.log(`  Try: ${cyan(`npx ${CLI_NAME} guide oas`)} or ${cyan(`npx ${CLI_NAME} guide <${available.join('|')}>`)}\n`);
    await debug.flushAndExit(1);
  }
  console.log(fs.readFileSync(guidePath, 'utf8'));
  await debug.flushAndExit(0);

} else if (command === 'key') {
  // ── npx restless key [--json] [--inline] [--dir <apiRootDir>] ──────────
  // Mint + register a project and put the key where the SDK will find it.
  // Ours to own: it generates a credential and registers it server-side,
  // which is not something a calling agent should improvise.
  const asJson = process.argv.includes('--json');
  const inline = process.argv.includes('--inline');
  const dirFlag = flagValue(process.argv, '--dir');

  // --inline exists so a HUMAN can place the key themselves. An agent has
  // no use for the plaintext (the key goes into .env and the SDK reads it
  // from there), so printing it just parks a live credential in the agent's
  // transcript. Refuse by default; a human driving from inside an agent
  // shell can override with RESTLESS_INTERACTIVE=1.
  if (inline && isAgent() && process.env.RESTLESS_INTERACTIVE !== '1') {
    const msg = 'Refusing to print the key to an agent - it is written to .env and the SDK reads it from there. '
      + 'Nothing in setup needs it on stdout. (Human at the keyboard? Re-run with RESTLESS_INTERACTIVE=1.)';
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.log(red(`\n  ✗ ${msg}\n`));
    await debug.flushAndExit(1);
  }
  const { rootDir: keyRoot, packageDir: keyPkgDir } = resolveProjectDirs(process.cwd());
  setGitRoot(findGitRoot(keyRoot) || keyRoot);

  const settingsForKey = loadSettings(keyRoot);
  const apiRootDir = apiDirKey(dirFlag || settingsForKey.apis?.[0]?.rootDir);
  // `npx restless key` runs standalone (the agent flow), so the language comes
  // from what setup recorded rather than from a live detection pass.
  const apiLanguage = settingsForKey.apis?.find((a) => a.rootDir === apiRootDir)?.language
    || settingsForKey.apis?.[0]?.language;
  const apiDir = resolveOwningDir(keyPkgDir, apiRootDir, apiLanguage);

  // Reuse a key that's already on disk rather than minting a second one for
  // the same project - a re-run that swaps the key underneath a running
  // server sends its logs to a project nobody is looking at.
  const existingEnvFile = findExistingEnvFile(apiDir, keyRoot);
  const existingKey = existingEnvFile ? existingRestlessKey(existingEnvFile) : null;
  let apiKey = existingKey || generateWriteKey();

  // An on-disk key is only reusable when we can prove which project it
  // belongs to - settings, or the creds this machine saved when it first
  // registered it. Re-registering an unproven key mints a project that
  // ingress will never route the key's uploads to (the unrecoverable
  // stale-key state), so an unrecognized key gets replaced instead.
  let result = null;
  let replacedStaleKey = false;
  try {
    if (existingKey) {
      result = await ensureProject({ rootDir: keyRoot, apiRootDir, apiKey, registerUnknown: false });
      if (!result) {
        apiKey = generateWriteKey();
        replacedStaleKey = true;
      }
    }
    if (!result) result = await ensureProject({ rootDir: keyRoot, apiRootDir, apiKey });
  } catch (err) {
    if (asJson) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
    else console.log(red(`\n  ✗ ${err.message}\n`));
    await debug.flushAndExit(1);
  }
  const { projectId, reused: reusedProject, recovered: recoveredProject } = result;

  let envFile = null;
  if (!inline && replacedStaleKey) {
    envFile = existingEnvFile;
    replaceRestlessKey(existingEnvFile, apiKey);
  } else if (!inline && !existingKey) {
    envFile = existingEnvFile || path.join(apiDir, '.env');
    const line = `RESTLESS_KEY=${apiKey}`;
    if (existingEnvFile) safeAppendFileSync(envFile, `\n${line}\n`);
    else safeWriteFileSync(envFile, `${line}\n`);
  } else if (existingKey) {
    envFile = existingEnvFile;
  }

  const rel = envFile ? path.relative(keyPkgDir, envFile) : null;
  // Whether a naive `git add -A` would stage the key. true = safe, false =
  // it would, null = no git here so the question doesn't apply.
  const envIgnoredByGit = envFile ? isGitIgnored(envFile, keyRoot) : null;
  if (asJson) {
    const payload = {
      ok: true, projectId, envFile: rel, envIgnoredByGit,
      reusedExistingKey: !!existingKey && !replacedStaleKey,
      reusedProject: !!reusedProject,
      ...(recoveredProject && { recoveredProject: true }),
      ...(replacedStaleKey && { replacedStaleKey: true }),
    };
    // The plaintext key reaches stdout only when --inline asked for exactly
    // that. In the default flow it's already in .env; echoing it again would
    // put a live credential in agent transcripts and shell history.
    if (inline) payload.apiKey = apiKey;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log('');
    if (replacedStaleKey) {
      console.log(`  ${yellow('!')} The RESTLESS_KEY already in ${bold(rel || '.env')} doesn't match any project this`);
      console.log(`    machine set up, and re-registering an old key splits logs across projects.`);
    }
    const projectLine = recoveredProject
      ? 'Re-adopted the project this key was first registered to'
      : reusedProject ? 'Using the project from your last setup' : 'Project registered';
    console.log(`  ${green('✓')} ${projectLine} ${dim(`(${projectId})`)}.`);
    if (rel) {
      const keyLine = replacedStaleKey ? 'Minted a fresh key and updated'
        : existingKey ? 'Using the key already in' : 'Wrote RESTLESS_KEY to';
      console.log(`  ${green('✓')} ${keyLine} ${bold(rel)}.`);
    } else {
      console.log(`  ${bold('RESTLESS_KEY')}=${apiKey}`);
    }
    if (envIgnoredByGit === false) {
      console.log(`  ${yellow('!')} ${bold(rel)} is ${bold('not')} ignored by git - add it to ${bold('.gitignore')} before you commit.`);
    }
    console.log('');
    console.log(dim(`  Keep this key out of source control. Restart your server so it picks it up.`));
    console.log('');
  }
  await debug.flushAndExit(0);

} else if (command === 'register') {
  // ── npx restless register --oas <file> [--dir <d>] [--name <n>] ────────
  // Record a spec an agent just wrote into `.restless/settings.json`, which
  // is what the SDK reads at startup and what later commands look up.
  const oasFlag = flagValue(process.argv, '--oas');
  if (!oasFlag) {
    console.log(red('\n  ✗ Missing --oas <file>.\n'));
    console.log(`  Usage: ${cyan(`npx ${CLI_NAME} register --oas .restless/openapi.json --dir api --name "My API"`)}\n`);
    await debug.flushAndExit(1);
  }
  const { rootDir: regRoot, packageDir: regPkgDir } = resolveProjectDirs(process.cwd());
  setGitRoot(findGitRoot(regRoot) || regRoot);

  const oasAbs = path.isAbsolute(oasFlag) ? oasFlag : path.resolve(process.cwd(), oasFlag);
  if (!fs.existsSync(oasAbs)) {
    console.log(red(`\n  ✗ No such file: ${oasFlag}\n`));
    await debug.flushAndExit(1);
  }
  let oasDoc;
  try {
    oasDoc = JSON.parse(fs.readFileSync(oasAbs, 'utf8'));
  } catch (err) {
    console.log(red(`\n  ✗ ${oasFlag} is not valid JSON: ${err.message}\n`));
    console.log(dim('  Fix the spec and re-run - the SDK and the dashboard both parse this file.\n'));
    await debug.flushAndExit(1);
  }

  // The spec's servers[0].url becomes the API's public base URL on the
  // dashboard, and the spec itself gets uploaded. Localhost and dev ports
  // must not ship - refuse here, where the agent still has to fix it before
  // the flow can continue, rather than warn and hope.
  const serverCheck = checkOasServers(oasDoc);
  if (!serverCheck.ok && !process.argv.includes('--allow-local-servers')) {
    console.log(red(`\n  ✗ servers[0].url is ${bold(serverCheck.url)} - a local/dev address, not a public base URL.`));
    console.log(`  This spec gets uploaded to the dashboard, so localhost and dev ports can't ship in it.`);
    console.log(`  Set ${cyan('servers[0].url')} to the API's real public URL - ask your user if you can't`);
    console.log(`  confirm it - or use a relative mount path like ${cyan('"/"')} if no public URL exists.`);
    console.log(dim(`  Intentional? Re-run with --allow-local-servers.\n`));
    await debug.flushAndExit(1);
  }

  const apiRootDir = apiDirKey(flagValue(process.argv, '--dir'));
  const name = flagValue(process.argv, '--name') || oasDoc?.info?.title || path.basename(regRoot);
  const oasRel = path.relative(regRoot, oasAbs);
  const settings = loadSettings(regRoot);
  // A stub from `key` running first carries the projectId under a guessed
  // rootDir of '.'. Adopt it rather than adding a second entry: that would
  // split projectId and spec, and `login` would claim a spec-less project.
  const stub = settings.apis?.length === 1 && settings.apis[0].projectId && !settings.apis[0].oasFile
    ? settings.apis[0]
    : null;
  // upsertApi matches on id first; without one it would push a duplicate and
  // the "Moved" line below would describe a move that did not happen.
  if (stub && !stub.id) stub.id = crypto.randomUUID();
  const existing = settings.apis?.find((a) => apiDirKey(a.rootDir) === apiRootDir) || stub;
  const movedFrom = stub && existing === stub && apiDirKey(stub.rootDir) !== apiRootDir ? apiDirKey(stub.rootDir) : null;
  // Only a plausible public URL is worth recording as baseUrl. Relative
  // servers and --allow-local-servers overrides keep whatever was there -
  // and a local address recorded by an older CLI gets scrubbed rather than
  // carried forward. A local URL never becomes the dashboard's idea of
  // this API.
  const publicBaseUrl = serverCheck.ok && !serverCheck.relative ? serverCheck.url : null;
  const keptBaseUrl = isPlausibleBaseUrl(existing?.baseUrl) ? existing.baseUrl : undefined;
  upsertApi(settings, {
    ...(existing || {}),
    name,
    rootDir: apiRootDir,
    oasFile: oasRel,
    oasSource: existing?.oasSource || { kind: 'agent' },
    baseUrl: publicBaseUrl || keptBaseUrl,
    requestIdPrefix: existing?.requestIdPrefix || generatePrefix(name),
    lastSyncedAt: new Date().toISOString(),
  });
  saveSettings(regRoot, settings);

  const ops = countOperations(oasDoc);
  console.log('');
  console.log(`  ${green('✓')} Registered ${bold(name)} ${dim(`(${ops} endpoint${ops === 1 ? '' : 's'})`)}.`);
  if (movedFrom) {
    console.log(`  ${yellow('!')} Moved the API ${bold(`npx ${CLI_NAME} key`)} registered at ${bold(movedFrom)} to ${bold(apiRootDir)}, keeping its project.`);
  }
  console.log(`  ${dim(`.restless/settings.json now points at ${oasRel}. Commit .restless/ with your code.`)}`);
  console.log('');
  await debug.flushAndExit(0);

} else if (command === 'verify') {
  // ── npx restless verify --url <base> [--path /x] [--json] ──────────────
  // One real request, then read the response headers. Ours to own because
  // the verdict comes from headers the SDK sets, not from the status code -
  // a captured 401 is a pass, and that trips people (and agents) up.
  const asJson = process.argv.includes('--json');
  const urlFlag = flagValue(process.argv, '--url') || 'http://localhost:3000';
  const pathFlag = flagValue(process.argv, '--path') || '/';
  const base = normalizeBaseUrl(urlFlag) || urlFlag;
  const target = `${base}${pathFlag.startsWith('/') ? '' : '/'}${pathFlag}`;

  // Taken before the probe fires; the 15s back-window absorbs clock skew and
  // the SDK's upload batching, same as the guided test step.
  const since = new Date(Date.now() - 15000).toISOString();

  let raw = null;
  try {
    raw = execSync(`curl -i -sS --max-time 10 ${JSON.stringify(target)}`, {
      encoding: 'utf8', timeout: 12000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    raw = null;
  }

  const result = { url: target };
  if (raw === null) {
    result.state = 'unreachable';
    result.detail = 'Nothing answered at that address.';
  } else {
    const { headers } = splitCurlIncludeOutput(raw);
    const diag = diagnoseFromHeaders(headers);
    result.state = diag.state;
    result.status = parseStatus(raw);
    if (diag.requestId) result.requestId = diag.requestId;

    // Second half of the verdict. A clean header only proves the SDK
    // captured the request; a log arriving in the registered project proves
    // the key maps where this setup thinks it does. Nothing landing after a
    // clean header is the stale-key signature - the exact failure that used
    // to sail through this command and surface as an empty dashboard.
    // `landed: null` = no registered project to poll, header is all we have.
    if (diag.state === 'ok') {
      const { rootDir: verifyRoot } = resolveProjectDirs(process.cwd());
      const entry = loadSettings(verifyRoot).apis?.find((a) => a.projectId) || null;
      const creds = entry?.projectId ? loadProjectCreds(entry.projectId) : null;
      if (creds?.setupKey) {
        result.landed = await pollForLandedLog({ projectId: entry.projectId, setupKey: creds.setupKey, since });
        if (!result.landed) result.state = 'stale-key';
      } else {
        result.landed = null;
      }
    }

    if (result.state !== 'ok') {
      const { guidance } = fixContext(result.state, { localBase: base, cli: CLI_NAME });
      if (guidance) result.fix = guidance;
    }
  }

  // The SDK guide tells installers who can't find a stable owner id to
  // leave the 'NEEDS_CONFIGURATION' placeholder, and promises "the CLI
  // greps for them and asks the user." This is that grep for the agent
  // flow: capture can pass while the setup is still unfinished, so the
  // check fails until a real owner id replaces the placeholder.
  const placeholderFiles = findOwnerIdPlaceholders(resolveProjectDirs(process.cwd()).rootDir);
  if (placeholderFiles.length) {
    result.ownerIdNeedsConfiguration = true;
    result.ownerIdFiles = placeholderFiles;
    result.ownerIdFix =
      "owner.id is still the 'NEEDS_CONFIGURATION' placeholder. Ask the user which field in " +
      'their data model is the permanent, immutable owner id (a database primary key or ' +
      'workspace/tenant UUID - never an email, username, or API key), update the owner block ' +
      'in the setup callback, restart the server, and re-run this check.';
  }
  result.ok = result.state === 'ok' && !result.ownerIdNeedsConfiguration;

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const desc = describeDiagnosis(result.state, { localBase: base, attempt: 99 });
    console.log('');
    console.log(`  ${desc.icon}  ${desc.lines[0]}`);
    for (const l of desc.lines.slice(1)) console.log(`     ${l}`);
    if (result.landed) console.log(`     ${green('✓')} The log landed in your project too.`);
    if (result.status) console.log(dim(`     (HTTP ${result.status} - a rejected request still counts, as long as the SDK saw it.)`));
    if (result.ownerIdNeedsConfiguration) {
      console.log('');
      console.log(`  ${yellow('⚠')}  owner.id is still ${bold("'NEEDS_CONFIGURATION'")} in ${result.ownerIdFiles.join(', ')}.`);
      console.log(`     Ask the user which field is the permanent owner id (a db primary key or`);
      console.log(`     workspace UUID), update the setup callback, restart, and re-run this check.`);
    }
    console.log('');
  }
  await debug.flushAndExit(result.ok ? 0 : 1);

} else if (command === 'login' || command === 'claim') {
  // ── npx restless login ─────────────────────────────────────────────────
  // Prints the claim URL. The setup key is handed to the server up front
  // and keyed by an opaque token, so it never lands in browser history,
  // an OAuth referer, or a screen share.
  const asJson = process.argv.includes('--json');
  const { rootDir: loginRoot } = resolveProjectDirs(process.cwd());
  const loginSettings = loadSettings(loginRoot);
  const entry = loginSettings.apis?.find((a) => a.projectId) || null;
  const creds = entry?.projectId ? loadProjectCreds(entry.projectId) : null;

  if (!creds?.setupKey) {
    const msg = entry?.projectId
      ? `No stored setup key for project ${entry.projectId}.`
      : 'This project has no Restless project yet.';
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else {
      console.log(red(`\n  ✗ ${msg}\n`));
      console.log(`  Run ${cyan(`npx ${CLI_NAME} key`)} first.\n`);
    }
    await debug.flushAndExit(1);
  }

  // Stage the spec + settings BEFORE minting the login token. The claim
  // flow attaches whatever is pending at claim time - a login link handed
  // out without this upload claims an empty project (no endpoints, no
  // settings), which is exactly how the agent flow used to end.
  const artifacts = await uploadPendingArtifacts({
    rootDir: loginRoot, projectId: entry.projectId, setupKey: creds.setupKey,
  });

  const token = crypto.randomBytes(16).toString('hex');
  try {
    const res = await fetch(`${SITE_URL}/api/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, projectId: entry.projectId, setupKey: creds.setupKey }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    const msg = `Couldn't prepare the login link (${err.message}).`;
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.log(red(`\n  ✗ ${msg}\n`));
    await debug.flushAndExit(1);
  }

  // Short form of `/login?token=<token>`; the site redirects it there.
  // People retype this out of a terminal, so keep it as short as possible.
  const loginUrl = `${SITE_URL}/init/${token}`;
  if (asJson) {
    console.log(JSON.stringify({ ok: true, loginUrl, projectId: entry.projectId, uploads: artifacts }, null, 2));
  } else {
    console.log('');
    if (artifacts.oas === 'uploaded') {
      console.log(`  ${green('✓')} Uploaded your OpenAPI spec${artifacts.endpoints ? dim(` (${artifacts.endpoints} endpoints)`) : ''}.`);
    } else if (artifacts.oas === 'claimed') {
      // Not a failure: the project already has an owner, so there is no
      // pending slot to stage into. The link below is still printed - it
      // just resolves to a project that is already theirs.
      console.log(`  ${green('✓')} This project is already claimed.`);
      console.log(`  ${dim(`To push a spec change to the dashboard, run ${cyan(`npx ${CLI_NAME} update`)}.`)}`);
    } else if (artifacts.oas === 'failed') {
      console.log(`  ${yellow('!')} ${artifacts.error || 'OAS upload failed.'} The project will claim without a spec.`);
    }
    console.log(`  ${bold('Open this to claim your project:')}`);
    console.log(`  ${cyan(loginUrl)}`);
    if (isAgent()) {
      console.log('');
      console.log(dim('  Setup finishes when your user opens this link: it connects the project to'));
      console.log(dim('  their account, which is where their logs become visible. It goes stale'));
      console.log(dim('  after a few hours. Pass that along plainly, and make the link the LAST'));
      console.log(dim('  line of your summary - it is their one next action.'));
    }
    console.log('');
  }
  await debug.flushAndExit(0);

} else if (command === 'reset') {
  const cwd = process.cwd();
  const { rootDir: resetRoot } = resolveProjectDirs(cwd);
  // Read the language BEFORE `.restless/` is deleted below - it is the only
  // record of what this project was set up as, and the grep for SDK wiring
  // needs it. Falls back to JavaScript, which is what every pre-Python
  // project recorded (or omitted).
  const resetLanguage = loadSettings(resetRoot).apis?.[0]?.language || 'javascript';
  const resetSdkName = getSdkWriter(resetLanguage).descriptor.packageSpecifier;

  console.log('');
  console.log(`  ${bold(yellow('This will reset Restless from this project.'))}`);
  console.log('');
  console.log(`  About to:`);
  console.log(`    ${dim('•')} Remove the ${cyan('.restless/')} directory`);
  console.log(`    ${dim('•')} Uninstall ${cyan(resetSdkName)} from your project manifests`);
  console.log(`    ${dim('•')} Ask AI to strip SDK setup code from your source files`);
  console.log(`    ${dim('•')} Remove ${cyan('RESTLESS_KEY')} from any ${cyan('.env*')} files`);
  console.log('');
  process.stdout.write(`  Continue? ${dim('[y/N] ')}`);
  const confirmed = await askYesNo('', { defaultValue: false });
  if (!confirmed) {
    console.log(dim('\n  Cancelled.\n'));
    await debug.flushAndExit(0);
  }

  console.log('');

  // a. Remove .restless/
  const restlessDir = path.join(resetRoot, '.restless');
  if (fs.existsSync(restlessDir)) {
    fs.rmSync(restlessDir, { recursive: true, force: true });
    console.log(green('  ✓ Removed .restless/'));
  } else {
    console.log(dim('  • No .restless/ directory found.'));
  }

  // b. Uninstall @restlessai/sdk from every package.json in the tree
  // (excluding node_modules and other obvious skip dirs). Walks via `find`
  // so we don't have to roll our own recursive scanner.
  function findPackageJsons(root) {
    try {
      const out = execSync(
        "find . -name package.json -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.restless/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.next/*'",
        { cwd: root, encoding: 'utf8' },
      );
      return out.trim().split('\n').filter(Boolean).map((f) => path.resolve(root, f));
    } catch {
      return [];
    }
  }

  // Only npm can remove a dependency for the user safely (see
  // `descriptor.autoUninstall`). Everything else gets told which manifest
  // still lists the SDK.
  //
  // This used to be a `=== 'python'` check on both sides, so Ruby and Go fell
  // through to the npm path: `api reset` on a Rails-plus-React repo scanned the
  // frontend's package.json, found no gem, and reported nothing to remove -
  // while in the worst case running `npm uninstall` in a directory that had
  // nothing to do with the SDK it was asked to remove.
  const resetWriter = getSdkWriter(resetLanguage);
  let uninstalledCount = 0;

  if (!resetWriter.descriptor.autoUninstall) {
    const listing = resetWriter.descriptor.manifests
      .map((m) => path.join(resetRoot, m))
      .filter((f) => {
        try { return fs.readFileSync(f, 'utf8').includes(resetSdkName); } catch { return false; }
      });
    if (listing.length) {
      for (const f of listing) {
        console.log(yellow(`  ! ${resetSdkName} is still listed in ${path.relative(resetRoot, f)} - remove that line and re-sync your environment.`));
      }
    } else {
      console.log(dim(`  • ${resetSdkName} not listed in any manifest.`));
    }
    uninstalledCount = listing.length;
  } else {
    for (const pkgPath of findPackageJsons(resetRoot)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const inDeps = pkg.dependencies && resetSdkName in pkg.dependencies;
        const inDev = pkg.devDependencies && resetSdkName in pkg.devDependencies;
        if (!inDeps && !inDev) continue;
        const pkgDir = path.dirname(pkgPath);
        const rel = path.relative(resetRoot, pkgPath) || 'package.json';
        try {
          execSync(`npm uninstall ${resetSdkName}`, { cwd: pkgDir, stdio: 'pipe' });
          console.log(green(`  ✓ Uninstalled ${resetSdkName} in ${rel}`));
          uninstalledCount++;
        } catch {
          console.log(yellow(`  ! Could not run npm uninstall in ${rel} - remove manually.`));
        }
      } catch {}
    }
    if (uninstalledCount === 0) {
      console.log(dim(`  • ${resetSdkName} not listed in any package.json.`));
    }
  }

  // d. Strip RESTLESS_KEY from .env files (no AI - we never let the model
  // read secret files). Plain regex on every .env* we can find.
  function findEnvFiles(root) {
    try {
      const out = execSync(
        "find . -type f -name '.env*' -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.restless/*'",
        { cwd: root, encoding: 'utf8' },
      );
      return out.trim().split('\n').filter(Boolean).map((f) => path.resolve(root, f));
    } catch {
      return [];
    }
  }

  const envFiles = findEnvFiles(resetRoot);
  let envStripped = 0;
  for (const envPath of envFiles) {
    try {
      const original = fs.readFileSync(envPath, 'utf8');
      const next = original
        .split('\n')
        .filter((line) => !/^\s*(export\s+)?RESTLESS_KEY\s*=/.test(line))
        .join('\n');
      if (next !== original) {
        fs.writeFileSync(envPath, next);
        const rel = path.relative(resetRoot, envPath);
        console.log(green(`  ✓ Removed RESTLESS_KEY from ${rel}`));
        envStripped++;
      }
    } catch {}
  }
  if (envStripped === 0) {
    console.log(dim('  • No RESTLESS_KEY entries found in .env files.'));
  }

  // c. Ask AI to remove SDK setup code from source files. Run last so
  // the model sees a project that's already half-cleaned (no .restless,
  // no package dep) - lower chance it tries to "fix" what we just
  // removed. We never tell it about the .env step; the prompt forbids
  // reading those anyway.
  // Language-aware: the default grep looks for `@restlessai/sdk` in JS files,
  // so on a Python project reset would report "nothing to remove" and leave
  // the wiring in place. `.restless/` is deleted by the time we get here, so
  // read the language before that happens (captured above as `resetLanguage`).
  // Same `resetWriter` the uninstall step above resolved.
  const sdkFiles = resetWriter.candidateWiringFiles(resetRoot);
  if (sdkFiles.length === 0) {
    console.log(dim(`  • No ${resetWriter.descriptor.packageSpecifier} references in source files.`));
  } else {
    const claudeOk = hasClaude();
    const codexOk = hasCodex() && hasCodexAuth();
    if (!claudeOk && !codexOk) {
      console.log(yellow('  ! No AI tool available - skipped source cleanup. References remain in:'));
      for (const f of sdkFiles) console.log(dim(`      ${f}`));
    } else {
      setProvider(claudeOk ? 'claude' : 'codex');
      console.log('');
      console.log(`  ${dim('Asking')} ${cyan(claudeOk ? 'Claude' : 'Codex')} ${dim('to strip SDK setup code from your source...')}`);
      try {
        const prompt = loadPrompt('remove-sdk', {
          ...languagePromptVars(resetLanguage),
          files: sdkFiles.map((f) => `- ${f}`).join('\n'),
        });
        await runAI(prompt, resetRoot);
        console.log(green('  ✓ Source cleanup complete.'));
      } catch (err) {
        console.log(yellow(`  ! AI cleanup failed: ${err.message}`));
        console.log(dim('    References that may remain:'));
        for (const f of sdkFiles) console.log(dim(`      ${f}`));
      }
    }
  }

  console.log('');
  console.log(green('  ✓ Reset complete.'));
  console.log('');
  await debug.flushAndExit(0);
} else if (command === 'clear') {
  const cwd = process.cwd();
  const { rootDir: clearRoot } = resolveProjectDirs(cwd);

  // Reset the site DB
  try {
    const res = await fetch(`${SITE_URL}/api/reset`, { method: 'POST' });
    if (res.ok) console.log(green('  ✓ Site database cleared.'));
  } catch {
    console.log(dim('  Site not running - skipped DB reset.'));
  }

  // Remove .restless/ directory
  const target = path.join(clearRoot, '.restless');
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true });
    console.log(green('  ✓ .restless/ removed.'));
  } else {
    console.log(dim('  No .restless/ directory found.'));
  }

  // Uninstall SDK package
  const pkgJson = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgJson)) {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const deps = pkg.dependencies || {};
    const hasRestless = '@restlessai/sdk' in deps;
    const hasReadme = 'readmeio' in deps;

    if (hasRestless || hasReadme) {
      const toRemove = [
        hasRestless && '@restlessai/sdk',
        hasReadme && 'readmeio',
      ].filter(Boolean).join(' ');

      try {
        execSync(`npm uninstall ${toRemove}`, { cwd, stdio: 'pipe' });
        console.log(green(`  ✓ Uninstalled ${toRemove}.`));
      } catch {
        console.log(dim(`  Could not uninstall ${toRemove} - remove manually.`));
      }
    }
  }
} else if (command === 'debug') {
  const rawRequestIdArg = process.argv[3];
  if (!rawRequestIdArg) {
    console.log(red('\n  ✗ Missing request ID.\n'));
    console.log(`  Usage: npx ${CLI_NAME} debug <request-id>\n`);
    await debug.flushAndExit(1);
  }

  // Strip decorative prefix (e.g. "TST-abc123" → "abc123") - the prefix is interchangeable
  const requestId = stripRequestIdPrefix(rawRequestIdArg);

  // Load prefix for display - check per-API first, fall back to top-level for backwards compat
  const { packageDir: debugPackageDir, rootDir: debugRootDir } = resolveProjectDirs(process.cwd());
  const debugSettings = loadSettings(debugRootDir);
  const idPrefix = debugSettings.apis?.[0]?.requestIdPrefix || debugSettings.requestIdPrefix || '';

  // Parse --ask flag for non-interactive mode
  const askIndex = process.argv.indexOf('--ask');
  const inlineQuestion = askIndex !== -1 ? process.argv[askIndex + 1] : null;

  // Detect non-interactive environments (CI, piped output, Claude Code, etc.)
  const isTTY = process.stdout.isTTY && process.stdin.isTTY && !inlineQuestion;
  const isPlain = !isTTY || process.env.CLAUDECODE === '1';

  // Plain-text formatting helpers (no ANSI codes)
  const p = {
    bold: isPlain ? (s) => s : bold,
    dim: isPlain ? (s) => s : dim,
    green: isPlain ? (s) => s : green,
    red: isPlain ? (s) => s : red,
    cyan: isPlain ? (s) => s : cyan,
  };


  // Fetch log by request ID (UUID) - no projectId needed, the server searches all projects
  const logUrl = `${SITE_URL}/api/logs/${requestId}/public`;
  let log;
  let expired = null;
  // The server's 404 response also carries a `dashboardUrl` (resolved
  // against the matching project's verified custom domain when found,
  // primary host otherwise). Keep the most-recent one so we can hand
  // the visitor a branded URL even when we never saw the log itself.
  let notFoundDashboardUrl = null;
  async function fetchOnce() {
    try {
      const res = await fetch(logUrl);
      if (res.ok) return { log: await res.json() };
      if (res.status === 410) {
        const body = await res.json().catch(() => ({}));
        return { expired: body };
      }
      if (res.status === 404) {
        const body = await res.json().catch(() => ({}));
        if (body?.dashboardUrl) notFoundDashboardUrl = body.dashboardUrl;
      }
    } catch {}
    return null;
  }

  const first = await fetchOnce();
  if (first?.log) log = first.log;
  else if (first?.expired) expired = first.expired;

  // If not found AND not expired, wait for the SDK to flush and retry
  if (!log && !expired) {
    process.stdout.write(p.dim('\n  Waiting for log to be ingested...'));
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const got = await fetchOnce();
      if (got?.log) { log = got.log; break; }
      if (got?.expired) { expired = got.expired; break; }
      process.stdout.write('.');
    }
    console.log('');
  }

  if (expired || !log) {
    const dashboardUrl =
      (expired && expired.dashboardUrl) ||
      notFoundDashboardUrl ||
      `${SITE_URL}/logs/${requestId}`;
    console.log('');
    if (expired) {
      console.log(`  ${p.bold('This request is older than 5 minutes.')}`);
    } else {
      console.log(`  ${p.bold("Couldn't load that request from here.")}`);
    }
    console.log('');
    console.log(`  ${p.dim(`For security, \`npx ${CLI_NAME} debug\` only works for the first 5 minutes`)}`);
    console.log(`  ${p.dim('after a request. After that, the log is only viewable when')}`);
    console.log(`  ${p.dim("you're signed in.")}`);
    console.log('');
    console.log(`  ${p.bold('Open it on the dashboard:')}`);
    console.log(`  ${p.cyan(dashboardUrl)}`);
    if (!expired) {
      console.log('');
      console.log(p.dim('  (If this is a brand-new request, also confirm your API server is'));
      console.log(p.dim('  running and the SDK is wired up.)'));
    }
    console.log('');
    await debug.flushAndExit(1);
  }

  const har = log.har || {};
  const req = har.request || {};
  const res = har.response || {};
  const isError = log.status >= 400;

  // Status line
  console.log('');
  const statusLabel = isError ? p.red(`${log.status}`) : p.green(`${log.status}`);
  console.log(`  ${p.bold(log.method)} ${log.url} ${statusLabel}${log.duration != null ? p.dim(` ${Math.round(log.duration)}ms`) : ''}`);
  const displayId = formatRequestId(log.requestId, idPrefix);
  console.log(p.dim(`  ${new Date(log.createdAt + 'Z').toLocaleString()}  •  ${displayId}`));

  // User
  if (log.user && Object.keys(log.user).length > 0) {
    const parts = Object.entries(log.user).map(([k, v]) => `${p.dim(k + ':')} ${v}`).join('  ');
    console.log(`  ${parts}`);
  }

  // Request
  console.log(`\n  ${p.bold('Request')}`);
  console.log(isPlain ? '  ' + '─'.repeat(36) : dim('  ─'.repeat(36)));

  if (req.headers?.length) {
    for (const h of req.headers) {
      console.log(`  ${p.dim(h.name + ':')} ${h.value}`);
    }
  }

  if (req.postData?.text) {
    console.log('');
    try {
      const pretty = JSON.stringify(JSON.parse(req.postData.text), null, 2);
      for (const line of pretty.split('\n')) {
        console.log(`  ${p.cyan(line)}`);
      }
    } catch {
      console.log(`  ${req.postData.text}`);
    }
  }

  // Response
  console.log(`\n  ${p.bold('Response')} ${statusLabel} ${res.statusText || ''}`);
  console.log(isPlain ? '  ' + '─'.repeat(36) : dim('  ─'.repeat(36)));

  if (res.headers?.length) {
    for (const h of res.headers) {
      console.log(`  ${p.dim(h.name + ':')} ${h.value}`);
    }
  }

  if (res.content?.text) {
    console.log('');
    try {
      const pretty = JSON.stringify(JSON.parse(res.content.text), null, 2);
      for (const line of pretty.split('\n')) {
        console.log(`  ${isError ? p.red(line) : line}`);
      }
    } catch {
      console.log(`  ${res.content.text}`);
    }
  }

  // Footer. Prefer the server-resolved dashboardUrl (built against the
  // owning project's verified custom domain when set, primary host
  // otherwise) so the URL we print matches the customer's brand.
  const viewUrl = log.dashboardUrl || `${SITE_URL}/logs/${requestId}`;
  console.log(`\n  ${p.dim('View in browser:')} ${viewUrl}`);
  if (isPlain && !inlineQuestion) {
    console.log(`\n  ${p.bold('Ask AI about this request')} - ask a question in plain English about this log:`);
    console.log(`  npx ${CLI_NAME} debug ${displayId} --ask "why did this fail?"`);
    console.log(`  npx ${CLI_NAME} debug ${displayId} --ask "how do I fix this?"`);
    console.log(`  npx ${CLI_NAME} debug ${displayId} --ask "show me a working curl command"`);
  }
  console.log('');

  // ── Top-level "what next?" picker ──
  // After showing the error, give the user a clean fork: take an
  // active fix path (which then drills into the edit-permission
  // sub-menu) or chat about the log. The edit machinery is hidden
  // until the user actually opts into fixing, so people who just
  // want to read the log or ask a quick question never see it.
  //
  // Gated on: error log, interactive TTY, and the `claude` CLI being
  // on PATH locally (no point offering an edit flow that depends on a
  // tool the user doesn't have).
  let skipChat = false;
  if (isError && isTTY && hasClaude()) {
    const action = await singleSelect(
      [
        { label: 'Fix it for me', hint: 'Use your local Claude SDK to find and apply a fix.' },
        { label: 'Ask about it', hint: 'Open an interactive chat about this request.' },
      ],
      { message: 'What do you want to do?', defaultIndex: 0 },
    );
    if (action === 0) {
      await offerFix({
        log,
        requestId,
        cwd: debugRootDir || process.cwd(),
        p,
        CLI_NAME,
        displayId,
      });
      skipChat = true;
    }
    // action === 1 ("Ask about it") falls through to the chat block
    // below; nothing else to do here.
  }

  // ── AI: ask via site server ──
  const askUrl = `${SITE_URL}/api/logs/${requestId}/ask`;

  async function askAI(question) {
    const res = await fetch(askUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, source: 'cli' }),
    });
    if (res.status === 410) {
      const body = await res.json().catch(() => ({}));
      const err = new Error('expired');
      err.expired = body;
      throw err;
    }
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();
    return data.answer;
  }

  // ── --ask mode: single question, print answer, exit ──
  if (inlineQuestion) {
    process.stdout.write(p.dim('  Thinking...\n'));
    try {
      const answer = await askAI(inlineQuestion);
      console.log('');
      for (const line of answer.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      console.log('');
      console.log(p.dim(`  Ask a follow-up: npx ${CLI_NAME} debug ${displayId} --ask "your question here"`));
      console.log('');
    } catch (err) {
      if (err && err.expired) {
        const expBody = err.expired;
        console.log(p.red(`\n  ✗ This request has expired (over 5 minutes old).\n`));
        console.log(`  ${p.bold('Next:')} log in to ask about it on the dashboard:`);
        console.log(`  ${p.cyan(expBody.dashboardUrl || `${SITE_URL}/logs/${requestId}`)}\n`);
      } else {
        console.log('  Could not generate a response.\n');
      }
    }
  } else if (isTTY && !skipChat) {
    // ── Interactive chat mode ──
    const separator = dim('─'.repeat(72));
    const claudeReady = hasClaude();
    console.log(separator);
    console.log(`  ${bold(cyan('Ask AI'))}  ${dim('Ask anything about this request in plain English')}`);
    console.log(`  ${dim('Examples: "why did this fail?" · "show me a working curl" · "what headers am I missing?"')}`);
    if (claudeReady) {
      console.log(`  ${dim('Type')} ${cyan('/fix')} ${dim('to have Claude apply a fix, or')} ${cyan('exit')} ${dim('to quit.')}`);
    } else {
      console.log(`  ${dim('Type "exit" to quit.')}`);
    }
    console.log(separator);
    console.log('');

    // Chat input using raw stdin (avoids readline issues after AI calls)
    function chatAsk(promptStr) {
      return new Promise((resolve) => {
        process.stdout.write(promptStr);
        let buffer = '';

        try { process.stdin.setRawMode(true); } catch {}
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (key) => {
          if (key === '\r' || key === '\n') {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(buffer);
          } else if (key === '\x7f' || key === '\b') {
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              process.stdout.write('\b \b');
            }
          } else if (isAbortKey(key)) {
            process.stdin.setRawMode(false);
            process.stdout.write('\n');
            // Sync handler: fire-and-forget. Nothing runs after, the inner
            // process.exit lands once the flush settles.
            debug.flushAndExit(0);
          } else if (key.charCodeAt(0) >= 32) {
            buffer += key;
            process.stdout.write(key);
          }
        };

        process.stdin.on('data', onData);
      });
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const question = await chatAsk(`  ${bold(green('You ❯'))} `);
      if (!question || !question.trim()) continue;
      const trimmedQ = question.trim();
      const lowerQ = trimmedQ.toLowerCase();
      if (lowerQ === 'exit') {
        console.log(`\n  ${dim('Goodbye!')}\n`);
        break;
      }
      // Chat-mode shortcut: drop straight into the fix flow. Skips the
      // need to exit, re-run, and re-pick "Fix it for me" from the top
      // menu after the AI's answer has clarified what's wrong.
      if (lowerQ === '/fix' || lowerQ === 'fix it') {
        if (!claudeReady) {
          console.log(`\n  ${red('✗')} ${dim('Claude CLI not installed; install it to use /fix.')}\n`);
          continue;
        }
        console.log('');
        await offerFix({
          log,
          requestId,
          cwd: debugRootDir || process.cwd(),
          p: { bold, dim, green, red, cyan },
          CLI_NAME,
          displayId,
        });
        break;
      }

      const spinner = startSpinner('Thinking...');

      try {
        const answer = await askAI(question.trim());

        spinner.stop();

        const lines = answer.trim().split('\n');
        console.log('');
        for (const line of lines) {
          console.log(`  ${cyan('✦')} ${line}`);
        }
        console.log('');
      } catch (err) {
        spinner.stop();
        if (err && err.expired) {
          const expBody = err.expired;
          console.log(`\n  ${red('✗')} This request has expired (over 5 minutes old).`);
          console.log(`  ${dim('Log in to keep going:')} ${cyan(expBody.dashboardUrl || `${SITE_URL}/logs/${requestId}`)}\n`);
          break;
        }
        console.log(`\n  ${red('✗')} Could not generate a response. Try again.\n`);
      }
    }
  }

} else if (command === 'update') {
  // ── npx restless update [projectId] ────────────────────────────────────
  // Post-claim editor. Refreshes the spec (from wherever it came from)
  // and edits a handful of safe fields, then pushes both to the
  // dashboard.
  //
  // This block only resolves WHICH project and WHO is driving; the
  // flows themselves live in steps/, like every other command's do.
  const cwd = process.cwd();
  const { rootDir: updateRoot, packageDir: updatePkgDir } = resolveProjectDirs(cwd);
  // Every screen below is drawn with the logo, whose second row names the
  // running command. Left unset it claimed to be `init`.
  setLogoSubtitle(`npx ${CLI_NAME} update`);
  const updateSettings = loadSettings(updateRoot);

  if (!updateSettings.apis || updateSettings.apis.length === 0) {
    console.log('');
    console.log(red(`  ✗ No Restless project found in this directory.`));
    console.log(dim(`  Looking in: ${updateRoot}/.restless/settings.json`));
    console.log('');
    console.log(`  Run ${cyan(`npx ${CLI_NAME} init`)} first to set one up.`);
    console.log('');
    await debug.flushAndExit(1);
  }

  // How the flags were given, read once. `errors` means a flag was given
  // wrongly - a value flag with nothing after it used to be silently
  // indistinguishable from not passing it at all, so `update --base-url`
  // reported success having changed nothing.
  const parsedFlags = parseUpdateFlags(process.argv);
  if (parsedFlags.errors) {
    console.log('');
    for (const err of parsedFlags.errors) console.log(red(`  ✗ ${err}`));
    console.log('');
    console.log(dim(`  Run ${cyan(`npx ${CLI_NAME} help`)} for the full flag list.`));
    console.log('');
    await debug.flushAndExit(1);
  }
  const updateFlags = parsedFlags.flags;

  // Which project. Positional, or `--project <id>`. The positional must not
  // swallow a flag: `update --base-url https://x` would otherwise look up a
  // project called "--base-url" and fail with a confusing "no API with that
  // projectId".
  const requestedProjectId =
    flagValue(process.argv, '--project') || positionalArg(process.argv, 3);
  let chosenApi;
  if (requestedProjectId) {
    chosenApi = updateSettings.apis.find((a) => a.projectId === requestedProjectId);
    if (!chosenApi) {
      console.log('');
      console.log(red(`  ✗ No API with projectId ${cyan(requestedProjectId)} found in .restless/settings.json.`));
      console.log('');
      const known = updateSettings.apis
        .filter((a) => a.projectId)
        .map((a) => `    ${dim('•')} ${a.projectId} ${dim(`(${a.name || a.rootDir || a.id})`)}`);
      if (known.length) {
        console.log(dim('  Known project IDs in this workspace:'));
        for (const line of known) console.log(line);
        console.log('');
      }
      await debug.flushAndExit(1);
    }
  } else if (updateSettings.apis.length === 1) {
    chosenApi = updateSettings.apis[0];
  } else if (isInteractive()) {
    const labels = updateSettings.apis.map((a) => ({
      label: a.name || a.rootDir || a.id || '(unnamed)',
      hint: a.projectId ? dim(a.projectId) : '',
    }));
    const idx = await singleSelect(labels, {
      message: 'Which API are you updating?',
      defaultIndex: 0,
    });
    chosenApi = updateSettings.apis[idx];
  } else {
    // No TTY to pick with, and guessing which project a flag-driven run meant
    // is the one mistake here that is expensive to undo.
    console.log('');
    console.log(red(`  ✗ This workspace has ${updateSettings.apis.length} APIs and no TTY to pick one.`));
    console.log(dim(`  Add ${cyan('--project <id>')}:`));
    for (const a of updateSettings.apis.filter((x) => x.projectId)) {
      console.log(`    ${dim('•')} ${a.projectId} ${dim(`(${a.name || a.rootDir})`)}`);
    }
    console.log('');
    await debug.flushAndExit(1);
  }

  if (!chosenApi?.projectId) {
    console.log('');
    console.log(red(`  ✗ That API has no projectId yet.`));
    console.log(dim(`  Finish ${cyan(`npx ${CLI_NAME} init`)} first - the projectId is set during setup.`));
    console.log('');
    await debug.flushAndExit(1);
  }

  // ── No TTY and no directive ────────────────────────────────────────
  // Same stance `init` takes: don't self-drive. Every screen in the
  // interactive flow needs a TTY, and a non-interactive picker silently
  // answers with its default - so a bare `update` under an agent or in CI
  // would appear to do something while actually editing nothing. Report the
  // state and hand over the flags instead. `--status` is read-only, so lead
  // with it.
  if (!isInteractive() && !updateFlags) {
    const agent = detectAgent();
    // An agent that named itself gets named back; one we only inferred from a
    // piped run has nothing to call it, and "no terminal" is the accurate
    // thing to say about why the prompts aren't coming.
    const who = agent ? agentLabel(agent) : 'no terminal';
    console.log('');
    console.log(`  ${bold('This project is set up.')} ${dim(`(${who} detected)`)}`);
    console.log('');
    console.log(`  ${dim('`update` is interactive by default, so it takes flags instead of prompting.')}`);
    console.log(`  ${dim('Start read-only, then act on what it tells you:')}`);
    console.log('');
    console.log(`    ${cyan(`npx ${CLI_NAME} update --status --json`)}`);
    console.log(`      ${dim('Whether the spec changed. Writes nothing, pushes nothing, needs no auth.')}`);
    console.log('');
    console.log(`    ${cyan(`npx ${CLI_NAME} update --refresh --json`)}`);
    console.log(`      ${dim('Re-run whatever produced the spec, then push it and the settings.')}`);
    console.log('');
    console.log(`    ${cyan(`npx ${CLI_NAME} update --oas <file|url> --json`)}`);
    console.log(`      ${dim('Point the project at a different spec and push it.')}`);
    console.log('');
    console.log(`  ${dim('Settings:')} ${cyan('--name')} ${cyan('--base-url')} ${cyan('--internal')}/${cyan('--external')} ${cyan('--prefix')}${dim(', or')} ${cyan('--sync')} ${dim('to push with no edits.')}`);
    console.log(`  ${dim(`Several APIs here? Add ${cyan('--project <id>')}.`)}`);
    console.log('');
    console.log(`  ${dim('Pushing needs a browser-approved session. Without one the edits still save')}`);
    console.log(`  ${dim(`locally and the JSON reports ${bold('synced: false')} with the reason - that is not a failure.`)}`);
    console.log('');
    debug.log('update.agent-plan', { agent, projectId: chosenApi.projectId });
    await debug.flushAndExit(0);
  }

  // ── Run it ─────────────────────────────────────────────────────────
  // Flags mean "do exactly this, don't ask me", which is the only form a
  // coding agent or a CI job can drive. Otherwise there is a human here.
  const updateCode = updateFlags
    ? await runFlagUpdate({
      rootDir: updateRoot,
      packageDir: updatePkgDir,
      apiEntry: chosenApi,
      flags: updateFlags,
    })
    : await runInteractiveUpdate({
      rootDir: updateRoot,
      packageDir: updatePkgDir,
      apiEntry: chosenApi,
    });
  await debug.flushAndExit(updateCode);
} else if (command === 'context') {
  // ── npx restless context ───────────────────────────────────────────────
  // Read this repo and propose what the AI should know about the API.
  //
  // Unlike every other command here, this one does NOT need to be run where
  // `init` was: the repos with the most to say about an API are often not the
  // one that implements it. So there is no settings.json to read a projectId
  // out of, and this block does what those blocks do with settings - work out
  // WHO is running and WHICH project they mean - by signing in and asking.
  const contextCwd = process.cwd();
  setLogoSubtitle(`npx ${CLI_NAME} context`);

  const session = await signIn({ interactive: isInteractive() });
  if (!session.ok) {
    reportSignInFailure(session);
    await debug.flushAndExit(1);
  }

  // Which project, in order of how much we should trust the answer.
  //
  // `--project <id>` is explicit and wins. Failing that, a repo that has been
  // through `init` already names its project in `.restless/settings.json`, and
  // asking someone with 22 projects to pick the one their own repo already
  // names is a question we can answer ourselves. Only a repo with neither
  // (a docs repo, a client SDK - the ones this command exists for) gets the
  // picker.
  const requestedProject = flagValue(process.argv, '--project');
  const localProject = requestedProject
    ? ''
    : (loadSettings(resolveProjectDirs(contextCwd).rootDir).apis || [])
      .map((a) => a.projectId)
      .find(Boolean) || '';

  let picked = await pickProject({
    token: session.token,
    preferredId: requestedProject || localProject,
    // A stale id in a committed settings file must not fail the run; a wrong
    // `--project` should. See `pickProject`.
    requirePreferred: !!requestedProject,
    interactive: isInteractive(),
  });

  // A cached session that the server has since rejected looks exactly like a
  // bad request from here, so spend the cache once and try again rather than
  // telling the user to go and delete a file.
  if (!picked.ok && picked.expired && session.cached) {
    clearAccountToken();
    const fresh = await signIn({ interactive: isInteractive() });
    if (!fresh.ok) {
      reportSignInFailure(fresh);
      await debug.flushAndExit(1);
    }
    session.token = fresh.token;
    picked = await pickProject({
      token: session.token,
      preferredId: requestedProject || localProject,
      requirePreferred: !!requestedProject,
      interactive: isInteractive(),
    });
  }

  if (!picked.ok) {
    console.log('');
    console.log(red(`  ✗ ${picked.error}`));
    if (picked.projects?.length) {
      console.log('');
      console.log(dim('  Projects on your account:'));
      for (const p of picked.projects) {
        console.log(`    ${dim('•')} ${p.projectId} ${dim(`(${p.name || p.slug})`)}`);
      }
    }
    console.log('');
    await debug.flushAndExit(1);
  }

  const contextCode = await contextStep({
    project: picked.project,
    token: session.token,
    cwd: contextCwd,
    cliVersion: readVersion(),
    yes: process.argv.includes('--yes') || process.argv.includes('-y'),
    dryRun: process.argv.includes('--dry-run'),
    full: process.argv.includes('--full'),
  });
  await debug.flushAndExit(contextCode);
} else if (command === 'timings') {
  // ── npx restless timings [file] [--json] [--list] ─────────────────────
  // Hidden, development-only (intentionally absent from `printHelp`).
  //
  // Timing spans ride along in the debug log every run writes to
  // ~/.restless/debug/, so this renders a profile of a run that has already
  // happened - no need to reproduce a slow `init` under a flag. `--timings`
  // on a live run prints the identical report through the same renderer.
  const explicitPath = positionalArg(process.argv, 3);

  if (process.argv.includes('--list')) {
    const logs = debug.listLocalLogs({ limit: 15 });
    console.log('');
    if (!logs.length) {
      console.log(`  ${dim('No local debug logs found.')}`);
    } else {
      console.log(`  ${bold('Recent runs')} ${dim('(newest first)')}`);
      for (const l of logs) console.log(`    ${cyan((l.command || '?').padEnd(14))} ${dim(l.file)}`);
      console.log('');
      console.log(`  ${dim(`npx ${CLI_NAME} timings <file>`)}`);
    }
    console.log('');
    await debug.flushAndExit(0);
  }

  const file = explicitPath || debug.findLatestLocalLog();
  if (!file) {
    console.log('');
    console.log(`  ${dim('No local debug logs found.')}`);
    console.log(`  ${dim(`Run \`npx ${CLI_NAME} init\` first, then re-run this to profile it.`)}`);
    console.log('');
    await debug.flushAndExit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.log('');
    console.log(`  ${red('✗')} Couldn't read ${file}: ${err.message}`);
    console.log('');
    await debug.flushAndExit(1);
  }

  if (process.argv.includes('--json')) {
    console.log(renderJson(parsed));
    await debug.flushAndExit(0);
  }

  console.log(renderReport(parsed).join('\n'));
  console.log(`  ${dim(file)}`);
  console.log('');
  await debug.flushAndExit(0);
} else if (command === 'submit-debug') {
  // Hidden command (intentionally absent from `printHelp`). Every run
  // writes a local debug log to ~/.restless/debug/; this uploads the
  // most recent one to the Restless team so support can ask for it
  // after the fact instead of asking the user to reproduce with
  // --debug. An explicit file path can be passed to send a specific log.
  const explicitPath = process.argv[3];
  const file = explicitPath || debug.findLatestLocalLog();
  if (!file) {
    console.log('');
    console.log(`  ${dim('No local debug logs found.')}`);
    console.log(`  ${dim(`Run \`npx ${CLI_NAME} init\` first, then re-run this to send the log.`)}`);
    console.log('');
    await debug.flushAndExit(1);
  }
  console.log('');
  console.log(`  ${dim(`Submitting ${file}`)}`);
  const res = await debug.submitLocalLog(file);
  console.log('');
  if (res.ok) {
    console.log(`  ${green('✓')} Debug log sent. Thanks - this helps us debug your setup.`);
  } else {
    console.log(`  ${red('✗')} Couldn't send the debug log. Check your connection and try again.`);
  }
  console.log('');
  await debug.flushAndExit(res.ok ? 0 : 1);
} else {
  console.log('');
  console.log(`  ${red(`Unknown command: ${command}`)}`);
  console.log('');
  printHelp();
  await debug.flushAndExit(1);
}
