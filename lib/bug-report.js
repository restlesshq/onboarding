import { execFileSync } from 'child_process';

import { ask, askYesNo, bold, cyan, dim, green, red } from './ui.js';
import { CLI_NAME } from './config.js';
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
const CONTENTS = [
  'the command you ran, your OS and Node version, this folder\'s path,',
  '  and your username and computer name',
  'every answer you gave the CLI',
  'the full AI trace, if this run used AI: each file it read, each',
  '  command it ran, and what it said',
  'the error it ended with',
];
const REDACTION_NOTE = 'API keys, tokens, and passwords are redacted before the log is saved.';

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

function submitCommand(localPath, email, placeholder = '<your email>') {
  return `npx ${CLI_NAME} submit-debug "${localPath}" --email ${email || placeholder}`;
}

/**
 * The "here's what gets sent" block, shared by every surface that uploads.
 * `whose` names the log: this run's, at the end of a failure, or the one
 * `submit-debug` picked.
 */
export function describeReport(localPath, { whose = "this run's", indent = '  ' } = {}) {
  return [
    `${indent}The report is ${whose} log:`,
    ...CONTENTS.map((l) => `${indent}  ${l.startsWith('  ') ? ' ' : '·'} ${l.trim()}`),
    `${indent}${dim(REDACTION_NOTE)}`,
    `${indent}${dim(`Read it first if you like: ${localPath}`)}`,
  ];
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
    console.log(`  ${green('✓')} Bug report sent. Thanks - this is how setup gets fixed.`);
    if (email) console.log(`  ${dim(`We'll email ${email} as soon as someone on the team opens it.`)}`);
  } else {
    console.log(`  ${red('✗')} Couldn't send the bug report. Check your connection and try:`);
    console.log(`    ${cyan(submitCommand(localPath, email))}`);
  }
  console.log('');
}

async function promptHuman(localPath) {
  // The plan is still pinned with the error at its foot; one more redraw
  // would clear the screen out from under this prompt.
  getActivePlan()?.freeze();

  console.log('');
  console.log(`  ${bold('Send this to the Restless team?')} We'll look at what went wrong and email you.`);
  console.log('');
  for (const line of describeReport(localPath)) console.log(line);
  console.log('');

  const yes = await askYesNo(`  ${bold('Send a bug report?')} ${dim('[Y/n]')} `, { defaultValue: true });
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

function instructAgent(localPath) {
  const email = gitEmail();
  const lines = [
    '',
    `  ${bold('Bug report')}`,
    `  For ${agentLabel()}: this run failed. Offer your user a bug report to the`,
    '  Restless team. Do not send one without asking them.',
    '',
    '  1. Tell them what the report contains. It is this run\'s log:',
    ...CONTENTS.map((l) => `       ${l.startsWith('  ') ? ' ' : '·'} ${l.trim()}`),
    `     ${REDACTION_NOTE}`,
    `     The log is at ${localPath} if they want to read it.`,
    email
      ? `  2. Ask which email the team should reply to. Suggest ${email} (their`
      : '  2. Ask which email the team should reply to.',
    ...(email ? ['     git config user.email) and have them confirm it or give another.'] : []),
    '  3. Only if they agree, run this with the email they confirmed:',
    `       ${submitCommand(localPath, '', '<their email>')}`,
    '',
  ];
  console.log(lines.join('\n'));
}

/**
 * The callback `install()` hands to `debug.setReportOffer`. `finalize`
 * calls it once, after a failed run's local log is written.
 */
async function offer({ localPath }) {
  if (isInteractive()) return promptHuman(localPath);
  if (isAgent()) return instructAgent(localPath);
  // CI or a pipe nobody's reading interactively: no one to ask, so leave
  // the one line that sends it.
  console.log(`  ${dim(`To send this run's log to the Restless team: ${submitCommand(localPath, '')}`)}`);
}

export function install() {
  debug.setReportOffer(offer);
}
