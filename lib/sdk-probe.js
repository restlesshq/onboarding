/**
 * Running an external toolchain to ask "is the SDK installed here?", under a
 * total wall-clock budget.
 *
 * Every one of these is `execFileSync`, which blocks the event loop, and they
 * run at "Sub 0: Install package" with a spinner up. `grep-sdk.js` documents
 * what that costs when it goes wrong: users reported the Configure SDK step
 * "got stuck" because a synchronous walk froze the UI with no spinner update,
 * no cursor, no message.
 *
 * The per-call timeout does not bound that. Ruby tries three commands and
 * Python up to six interpreters, so a machine where each one hangs to its own
 * limit stacks them: 3 x 20s of dead terminal for Ruby, and `bundle list` on a
 * cold Rails app is genuinely slow enough to reach it. A budget shared across
 * the attempts bounds what the user actually experiences, which is the whole
 * sequence, not any single call.
 *
 * A LEAF module: the writers import it, so it must not import the registry.
 */

import { execFileSync } from 'child_process';
import { spawnSpec } from './portable-exec.js';
import * as debug from './debug.js';
import * as timings from './timings.js';

/**
 * How long every probe for one language may take in total.
 *
 * Six seconds is the point where a spinner still reads as "working" rather than
 * "hung". Overrunning it means we report "not installed" and let the install
 * command run - which is recoverable and fast, whereas a frozen terminal is
 * neither.
 */
export const PROBE_BUDGET_MS = 6000;

/**
 * A wall-clock budget shared across a sequence of probes.
 *
 * `Date.now()` is read at creation and on every check, so a slow first attempt
 * shortens the timeout handed to the second rather than being charged twice.
 */
export function createProbeBudget(totalMs = PROBE_BUDGET_MS) {
  const startedAt = Date.now();
  return {
    /** Milliseconds left, never negative. */
    remaining() {
      return Math.max(0, totalMs - (Date.now() - startedAt));
    },
    /** True once the budget is gone, so callers stop trying. */
    spent() {
      return this.remaining() === 0;
    },
  };
}

/**
 * Run one probe and return its trimmed stdout, or null.
 *
 * Null covers every failure the same way on purpose: a missing toolchain, a
 * non-zero exit, a timeout and an empty answer all mean "this did not prove the
 * SDK is here", and the caller's next step is identical in each case.
 */
export function probe(command, args, { cwd, budget } = {}) {
  const timeout = budget ? budget.remaining() : PROBE_BUDGET_MS;
  // A zero or negative timeout means execFileSync would either wait forever or
  // throw; either way there is no time left to spend here.
  if (timeout <= 0) {
    debug.log('sdk-probe.budget-spent', { command, args });
    return null;
  }
  const endSpan = timings.start(`probe: ${command}`, { kind: timings.KINDS.EXEC });
  try {
    const spec = spawnSpec(command, args);
    const out = execFileSync(spec.file, spec.args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout,
      ...spec.options,
    }).trim();
    if (!out) return null;
    debug.log('sdk-probe.hit', { command, out: out.split('\n')[0] });
    return out;
  } catch {
    return null;
  } finally {
    endSpan();
  }
}
