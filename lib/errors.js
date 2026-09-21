import { red, dim, cyan, bold } from './ui.js';
import { CALENDLY_URL } from './config.js';
import { getActivePlan } from './runner.js';
import * as debug from './debug.js';
import * as telemetry from './telemetry.js';

/**
 * Print a two-part error block: the specific failure on top, then a
 * consistent "we can help, book a call" fallback underneath. Every
 * surface that bails out of setup should funnel through this so users
 * never hit a dead end.
 *
 * `details` is an optional array of extra context lines to print dimmed
 * between the headline and the Calendly link (e.g. HTTP status, URL).
 *
 * Also paints whatever step/sub-step is currently active red, so the
 * plan at the top of the screen visually reflects where we died.
 */
export function reportError(headline, details = []) {
  debug.log('error', { headline, details });

  const plan = getActivePlan();

  // Telemetry gets a CODE and the step, never the headline or details -
  // both interpolate HTTP statuses, URLs, server text, and occasionally the
  // user's own input. Until raise sites pass a code of their own, every
  // failure files under `unknown`, which still answers the question this
  // funnel exists for: which step do runs die in.
  telemetry.recordError('unknown', plan?.activeStepIndex?.());
  if (plan) {
    plan.markActiveFailed();
    // Pin the error block inside the rendered frame so a late spinner tick
    // or message update can't wipe it. Without this, errors flashed and
    // disappeared when render() ran again with `\x1b[H\x1b[J` (clear).
    const lines = [
      `  ${red('✗')} ${headline}`,
    ];
    for (const line of details) {
      lines.push(`    ${dim(line)}`);
    }
    lines.push('');
    lines.push(`  ${bold("Stuck? Let's get on a call, we'll fix it together.")}`);
    lines.push(`  ${cyan(CALENDLY_URL)}`);
    plan.setError(lines);
    return;
  }

  // No active plan (early bootstrap, helper scripts) - fall back to plain
  // console.log; nothing else is owning the screen so it sticks.
  console.log('');
  console.log(`  ${red('✗')} ${headline}`);
  for (const line of details) {
    console.log(`    ${dim(line)}`);
  }
  console.log('');
  console.log(`  ${bold("Stuck? Let's get on a call, we'll fix it together.")}`);
  console.log(`  ${cyan(CALENDLY_URL)}`);
  console.log('');
}

/**
 * Sentinel thrown by `fatalError`. Top-level handlers in `bin/restless.js`
 * recognize this and exit cleanly without re-reporting (the error block
 * has already been pinned to the screen by `reportError`).
 */
export const FATAL_EXIT = Symbol.for('@restless/api/fatal-exit');
export class FatalExit extends Error {
  constructor(headline) {
    super(`fatal: ${headline}`);
    this.name = 'FatalExit';
    this[FATAL_EXIT] = true;
  }
}
export function isFatalExit(err) {
  return !!(err && err[FATAL_EXIT] === true);
}

/**
 * Same as reportError, but **halts the calling stack** and exits the
 * process afterward. Throws a `FatalExit` synchronously so anything after
 * the call (more prompts, more steps) never runs - the previous design
 * called `debug.flushAndExit` without `await`, and the synchronous caller
 * kept going, which is how we ended up showing prompts after a failure.
 *
 * Use for unrecoverable failures that block the rest of setup.
 */
export function fatalError(headline, details = []) {
  reportError(headline, details);
  // Kick off the async exit (it awaits a debug upload up to 5s, then
  // process.exit). Fire-and-forget; the throw below is what guarantees
  // the immediate stack stops.
  debug.flushAndExit(1).catch(() => {});
  throw new FatalExit(headline);
}
