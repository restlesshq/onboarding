import { execFileSync } from 'child_process';

import { ask, askYesNo, bold, cyan, dim, green, red } from './ui.js';
import { CLI_NAME, CALENDLY_URL } from './config.js';
import { isAgent, isInteractive, agentLabel } from './env.js';
import { getActivePlan } from './runner.js';
import * as debug from './debug.js';

/**
 * The bug report a failed run offers on its way out.
 *
 * "Re-run with --debug" asked people to notice a hint, quit, and reproduce
 * the failure, and most runs come through a coding agent that never sees
 * the hint as meant for it. So the run that failed offers its own log, which
 * is already on disk (every run writes one), and says what's in it before
 * anything leaves the machine.
 *
 * A human at a terminal is asked right there. An agent can't answer a
 * prompt, so it gets instructions to ask its user and the one command to
 * run if they agree - the user still decides and still confirms the email.
 */

// What a debug log holds, in the order `lib/debug.js` records it. Shown
// before every upload. Keep it true: anything new the log records belongs
// here before it ships.
// Deliberately loose: it only has to catch a typo or a stray answer, and
// the server validates again before it stores anything.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

/**
 * `git config user.email`, or '' when there's no git, no config, or no
 * email in it. Only ever a suggestion: the user confirms it before it's sent.
 */
export function gitEmail(cwd = process.cwd()) {
  try {
    const out = execFileSync('git', ['config', 'user.email'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    return isValidEmail(out) ? out : '';
  } catch {
    return '';
  }
}

// Long enough for "what I changed, what I ran, what it said"; short
// enough that it stays a summary rather than a pasted transcript.
export const MAX_NOTE_LENGTH = 2000;

// Set by `install()`. Until then no offer will run, so nothing is held back.
let installed = false;
// A fatal error's "Stuck? Let's get on a call" lines, held back so the offer
// can sit above them. See `holdHelpForOffer`.
let helpHeld = false;

/** The "Stuck? Let's get on a call" lines every failure ends on. */
export function helpLines() {
  return [
    `  ${bold("Stuck? Let's get on a call, we'll fix it together.")}`,
    `  ${cyan(CALENDLY_URL)}`,
  ];
}

/**
 * Asked by `fatalError`: should the error block leave out its "Stuck?"
 * lines? Yes whenever an offer is coming (installed, and not a `--debug`
 * run, which uploads instead of asking), so the question sits above the
 * call link instead of below it. The lines are printed once the offer is
 * done, or by `onNoOffer` if the run ends without one.
 */
export function holdHelpForOffer() {
  if (!installed || debug.isEnabled()) return false;
  helpHeld = true;
  return true;
}

// Every offer has just ended on a blank line when this runs.
function printHelp() {
  helpHeld = false;
  for (const line of helpLines()) console.log(line);
  console.log('');
}

function submitCommand(localPath, email, placeholder = '<your email>', { note = false } = {}) {
  const base = `npx ${CLI_NAME} submit-debug "${localPath}" --email ${email || placeholder}`;
  return note ? `${base} --note "<what you changed and tried>"` : base;
}

/**
 * Ask for the email to reply to, prefilled from git. Enter confirms the
 * suggestion; anything typed replaces it. Blank sends the report with no
 * email, and says that means we can't write back. Resolves to the email,
 * or '' for none.
 */
export async function askEmail(suggested = gitEmail()) {
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await ask(`  ${bold('Email for our reply')} ${dim('(Enter to confirm)')}: `, { defaultValue: suggested })).trim();
    if (!answer) {
      console.log(`  ${dim("No email, so we can't write back - the log still helps.")}`);
      return '';
    }
    if (isValidEmail(answer)) return answer;
    console.log(`  ${red("That doesn't look like an email address.")}`);
    suggested = answer;
  }
  return '';
}

/**
 * Print what happened to an upload. The uploader already printed its own
 * status line; this one says what happens next.
 */
export function reportOutcome(res, { email, localPath }) {
  console.log('');
  if (res.ok) {
    console.log(`  ${green('✓')} Debugging info sent. We'll take a look.`);
    if (email) console.log(`  ${dim(`If we need more from you, we'll write to ${email}.`)}`);
  } else {
    console.log(`  ${red('✗')} Couldn't send the debugging info. Check your connection and try:`);
    console.log(`    ${cyan(submitCommand(localPath, email))}`);
  }
  console.log('');
}

/**
 * The one-line "what's wrong" an offer opens with. A run that exited
 * non-zero says it failed; one that finished without onboarding the user
 * says what's still missing, since that run may have ended on a green tick.
 */
function situation(unfinished) {
  if (!unfinished.length) return { human: null, agent: 'this run failed.' };
  const why = unfinished.join('; ');
  return {
    human: `Setup isn't finished: ${why}.`,
    agent: `setup didn't finish (${why}).`,
  };
}

/**
 * Run a prompt with the call link drawn underneath it, so "Stuck? Let's get
 * on a call" is on screen while the question waits rather than only after
 * it's answered. Once answered, the link is cleared and printed again at
 * the end by `printHelp`, below everything that follows.
 *
 * Only for raw-mode prompts like `askYesNo`. A readline prompt (`ask`)
 * clears everything below itself on every redraw, so the link would vanish.
 *
 * The rows under the prompt are reserved first (print newlines, move back
 * up), so if the prompt sits at the bottom of the terminal the scroll
 * happens before the cursor is saved, not after.
 */
async function withHelpBelow(run) {
  const out = process.stdout;
  const below = ['', ...helpLines()];
  out.write(`${'\n'.repeat(below.length)}\x1b[${below.length}A`);
  out.write(`\x1b7\n${below.join('\n')}\x1b8`);
  try {
    return await run();
  } finally {
    // The answer left the cursor on the row under the prompt; clear from
    // there down so what comes next prints where the link was.
    out.write('\x1b[J');
  }
}

async function promptHuman(localPath, { unfinished }) {
  // The plan is still pinned with the error at its foot; one more redraw
  // would clear the screen out from under this prompt.
  getActivePlan()?.freeze();

  const { human } = situation(unfinished);
  console.log('');
  if (human) console.log(`  ${bold(human)}`);

  const yes = await withHelpBelow(() =>
    askYesNo(`  ${bold('Send debugging info to the Restless team?')} ${dim('[Y/n]')} `, { defaultValue: true }));
  debug.log('bug-report.prompt', { answer: yes });
  if (!yes) {
    console.log(`  ${dim(`Nothing was sent. To send it later: ${submitCommand(localPath, '')}`)}`);
    console.log('');
    return;
  }

  const email = await askEmail();
  const res = await debug.submitLocalLog(localPath, { report: { email, source: 'prompt' } });
  reportOutcome(res, { email, localPath });
}

/** Greedy word wrap for the agent's paragraph, indented to match the CLI. */
function wrap(text, { width = 80, indent = '  ' } = {}) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

/**
 * What an agent reads instead of a prompt. Kept short on purpose: it sits in
 * the agent's context and its user's transcript, so it says only what the
 * agent must do - ask first, confirm the email, run one command. The `--note`
 * placeholder is self-explanatory; it matters because the agent's own work
 * never reaches our log.
 */
function instructAgent(localPath, { unfinished, retryFirst }) {
  const email = gitEmail();
  const { agent } = situation(unfinished);
  const ask = retryFirst ? "Try the fix above first. If you're still stuck, ask" : 'Ask';
  const text = `For ${agentLabel()}: ${agent} ${ask} your user if we can send the Restless team `
    + "this run's debugging info (secrets redacted). "
    + `If yes, confirm their email${email ? ` (git has ${email})` : ''} and run:`;
  console.log(['', ...wrap(text), `    ${submitCommand(localPath, '', '<email>', { note: true })}`, ''].join('\n'));
}

/**
 * The callback `install()` hands to `debug.setReportOffer`. `finalize`
 * calls it once, after the local log of a run that left the user short of
 * onboarded is written.
 */
async function offer({ localPath, unfinished = [], retryFirst = false }) {
  if (isInteractive()) await promptHuman(localPath, { unfinished });
  else if (isAgent()) instructAgent(localPath, { unfinished, retryFirst });
  else {
    // CI or a pipe nobody's reading interactively: no one to ask, so leave
    // the one line that sends it.
    const { human } = situation(unfinished);
    if (human) console.log(`  ${dim(human)}`);
    console.log(`  ${dim(`To send this run's debugging info to the Restless team so we can help: ${submitCommand(localPath, '')}`)}`);
    console.log('');
  }
  // Every offer ends on the call link, below the question it follows.
  printHelp();
}

export function install() {
  installed = true;
  debug.setReportOffer(offer, {
    onNoOffer: () => {
      if (!helpHeld) return;
      console.log('');
      printHelp();
    },
  });
}
