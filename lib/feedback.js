import { ask, bold, cyan, dim, green, red } from './ui.js';
import { readFlag, positionalArg } from './args.js';
import { SITE_URL, CLI_NAME } from './config.js';
import { isInteractive, isAgent, agentLabel } from './env.js';
import { stripRequestIdPrefix } from './settings.js';
import { gitEmail, isValidEmail } from './bug-report.js';
import * as debug from './debug.js';

/**
 * `restless feedback <request-id>`: send a note about an API to the people
 * who maintain it, knowing only the id of a request you made to it.
 *
 * The id is the capability, as for `debug`: the server finds the project
 * that logged it and files the note against that project, so there is no
 * sign-in and no project id to supply. Unlike `debug` there is no
 * five-minute window - feedback is usually written after the fact.
 *
 * A human at a terminal is asked for the message and offered a contact
 * email, and the note is sent as soon as both are answered - no summary, no
 * confirm. An agent is never prompted: it passes `--message`, or is told in
 * a few lines what to collect from its user and the command to run. Any
 * other non-interactive run (CI, a pipe) gets the one-line usage.
 */

export const FEEDBACK_FLAGS = [
  ['--message <text>', 'What to tell the maintainers (required under a coding agent)'],
  ['--context <text>', 'What you were doing, if it helps: the call, the docs page'],
  ['--email <addr>', 'Your email, so the maintainers can reply (optional)'],
  ['--json', "Print the server's JSON response instead of a message"],
];

// The server finds the owning project by asking each project's metrics
// store in turn, so this is longer than the debug uploader's 5s.
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Read the command's arguments. `argv` is the full `process.argv`, so the
 * id is at index 3 and flags follow it.
 *
 * Returns `{ error }` for a usage mistake, otherwise the parsed fields. The
 * id has its display prefix (`pets-<uuid>`) stripped; the server strips it
 * too, but a bare uuid is what every message below should show.
 */
export function parseFeedbackArgs(argv) {
  const rawId = positionalArg(argv, 3);
  if (!rawId) return { error: 'Missing request id.' };

  const message = readFlag(argv, '--message');
  if (message.present && message.value === null) return { error: '--message needs a value.' };
  const context = readFlag(argv, '--context');
  if (context.present && context.value === null) return { error: '--context needs a value.' };
  const email = readFlag(argv, '--email');
  if (email.present && email.value === null) return { error: '--email needs a value.' };
  if (email.value && !isValidEmail(email.value)) {
    return { error: `"${email.value}" doesn't look like an email address.` };
  }

  return {
    id: stripRequestIdPrefix(rawId),
    message: message.value ? message.value.trim() : '',
    context: context.value ? context.value.trim() : '',
    email: email.value || '',
    json: argv.includes('--json'),
  };
}

/**
 * POST the note. Resolves to `{ status, body, text, retryAfter }`, or
 * `{ status: 0, error }` when the server was never reached. Never throws:
 * the caller maps every shape to one line.
 *
 * The User-Agent names this CLI and its version so the dashboard can label
 * the row "restless-cli x.y via CLI" rather than "Unknown client".
 */
export async function postFeedback({ id, message, context, email, version, fetchImpl = globalThis.fetch, siteUrl = SITE_URL }) {
  const payload = { message };
  if (context) payload.context = context;
  if (email) payload.email = email;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${siteUrl}/api/logs/${encodeURIComponent(id)}/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `restless-cli/${version}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = JSON.parse(text); } catch {}
    const retryAfter = Number(res.headers?.get?.('retry-after')) || null;
    return { status: res.status, body, text, retryAfter };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return { status: 0, error: timedOut ? 'timed out' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One line per outcome. The server trims every field to its own limits and
 * refuses a body over 32KB, so the size is not checked here, only mapped.
 *
 * `skipReport` names the results that are not the
 * CLI's failure (a wrong id, a limiter, a note that is too long): those
 * should not end on an offer to send us debugging info. A 500, a 400 we
 * never expect to produce, or an unreachable server still should.
 */
export function describeOutcome(result) {
  const { status, body, retryAfter, error } = result;
  const serverSaid = body && typeof body.error === 'string' ? body.error : '';
  switch (status) {
    case 201:
      return { ok: true, line: `${green('✓')} Feedback sent to this API's maintainers.` };
    case 400:
      return { ok: false, line: `${red('✗')} The server rejected the feedback${serverSaid ? `: ${serverSaid}` : '.'}` };
    case 404:
      return {
        ok: false,
        skipReport: 'feedback: request id not found',
        line: `${red('✗')} That id didn't match a logged request. Check it was copied whole, prefix and all.`,
      };
    case 413:
      return {
        ok: false,
        skipReport: 'feedback: note too long',
        line: `${red('✗')} That's too long to send. Keep the message and context under 32KB together.`,
      };
    case 429:
      return {
        ok: false,
        skipReport: 'feedback: rate limited',
        line: `${red('✗')} Too many requests from this machine. Try again in ${retryAfter ? `${retryAfter} seconds` : 'a minute'}.`,
      };
    case 500:
      return { ok: false, line: `${red('✗')} The server couldn't save it, so nothing was sent${serverSaid ? `: ${serverSaid}` : '.'}` };
    case 0:
      return { ok: false, line: `${red('✗')} Couldn't reach Restless (${error}). Check your connection and try again.` };
    default:
      return { ok: false, line: `${red('✗')} Unexpected response from the server (HTTP ${status}).` };
  }
}

/**
 * Ask for the message until there is one. Three blank answers in a row
 * means they changed their mind, not that the terminal is broken.
 */
async function askMessage(prompts) {
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await prompts.ask(`  ${bold('Your feedback')}: `)).trim();
    if (answer) return answer;
    if (tries < 2) console.log(`  ${dim('A message is the one thing a note needs.')}`);
  }
  return '';
}

/**
 * The user's email, so the maintainers can reply, prefilled from git the
 * way the bug report's is. Enter confirms the suggestion, anything typed
 * replaces it, blank sends none. It is self-reported and the server does
 * not verify it, so it only has to look like an address.
 */
async function askContactEmail(prompts, suggested = gitEmail()) {
  for (let tries = 0; tries < 3; tries++) {
    const answer = (await prompts.ask(`  ${bold('Your email')} ${dim('(optional, Enter to confirm)')}: `, { defaultValue: suggested })).trim();
    if (!answer) return '';
    if (isValidEmail(answer)) return answer;
    console.log(`  ${red("That doesn't look like an email address.")}`);
    suggested = answer;
  }
  return '';
}

/**
 * What an agent reads instead of the prompts. The same shape as `init`'s
 * hand-over, kept to a few lines: it sits in the agent's context and its
 * user's transcript, so it says only what to collect from the user and the
 * command to run with it. The message is the one required field; the email
 * is the user's own, offered from git so the agent can confirm rather than
 * ask from scratch.
 */
function instructAgent(id) {
  const email = gitEmail();
  console.log('');
  console.log(`  For ${agentLabel()}: ask your user what to tell this API's maintainers, and`);
  console.log(`  confirm their email${email ? ` (git has ${email})` : ''} so the maintainers can reply. Then run:`);
  console.log(`    npx ${CLI_NAME} feedback ${id} --message "<their feedback>" --email <their email>`);
  console.log(`  ${dim('--context "<what they were doing>" is optional. So is the email, but without it nobody can reply.')}`);
  console.log('');
}

/**
 * The whole command. Resolves to `{ exitCode, skipReport }` and leaves the
 * exit itself to the caller, which owns the debug log's flush.
 *
 * Everything that varies by environment is injectable so the modes can be
 * tested without a TTY or a network: `interactive` (defaults to
 * `isInteractive()`), `agent` (defaults to `isAgent()`), `prompts` (`ask`)
 * and `fetchImpl`.
 */
export async function runFeedback(argv, { version = 'unknown', fetchImpl, interactive = isInteractive(), agent = isAgent(), prompts = { ask } } = {}) {
  const args = parseFeedbackArgs(argv);
  const json = argv.includes('--json');

  // A usage mistake is one line either way; the JSON form keeps stdout
  // parseable for whoever asked for it.
  const usage = (error) => {
    if (json) console.log(JSON.stringify({ error }));
    else {
      console.log('');
      console.log(`  ${red('✗')} ${error}`);
      console.log(`  Usage: npx ${CLI_NAME} feedback <request-id> --message "<what to tell the maintainers>"`);
      console.log('');
    }
    return { exitCode: 1, skipReport: `feedback: ${error}` };
  };
  if (args.error) return usage(args.error);

  let { id, message, context, email } = args;
  // Prompting is for a human who did not say everything on the command
  // line. `--json` is a request for machine output, so it never prompts.
  const prompting = interactive && !json;

  if (!message) {
    // An agent is told what to collect and the command to run with it; the
    // JSON form stays a one-line error so stdout is still parseable.
    if (agent && !json) {
      instructAgent(id);
      return { exitCode: 1, skipReport: 'feedback: Missing --message (agent instructed)' };
    }
    if (!prompting) return usage('Missing --message: say what to tell the maintainers.');
    console.log('');
    console.log(`  ${bold('Feedback on request')} ${cyan(id)}`);
    console.log(`  ${dim("Goes to the people who maintain this API, with the request attached.")}`);
    console.log('');
    message = await askMessage(prompts);
    if (!message) {
      console.log(`  ${dim('Nothing was sent.')}`);
      console.log('');
      return { exitCode: 0, skipReport: 'feedback: no message given' };
    }
  }

  // The email is the last question; the note goes as soon as it's answered.
  if (prompting) {
    if (!email) email = await askContactEmail(prompts);
    console.log('');
  }

  const result = await postFeedback({ id, message, context, email, version, fetchImpl });
  debug.log('feedback.sent', { status: result.status, error: result.error || null });

  if (json) {
    // The server's JSON as it came. When there is none (unreachable, or a
    // body that was not JSON), say so in the same shape.
    const raw = result.body !== null && result.body !== undefined
      ? result.text
      : JSON.stringify({ error: result.error ? `Couldn't reach Restless (${result.error}).` : `Unexpected response (HTTP ${result.status}).`, status: result.status });
    console.log(raw);
    // Whoever asked for JSON is parsing stdout; an offer to send us
    // debugging info printed after it would corrupt what they read.
    return { exitCode: result.status === 201 ? 0 : 1, skipReport: 'feedback: --json' };
  }

  const outcome = describeOutcome(result);
  console.log(`  ${outcome.line}`);
  if (outcome.ok && email) console.log(`  ${dim(`If they want to follow up, they'll write to ${email}.`)}`);
  console.log('');
  return { exitCode: outcome.ok ? 0 : 1, skipReport: outcome.skipReport };
}
