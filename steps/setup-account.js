import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, green, red, cyan, celebrationBanner, isAbortKey } from '../lib/ui.js';
import { loadSettings } from '../lib/settings.js';
import { SITE_URL, CLI_NAME } from '../lib/config.js';
import { isInteractive } from '../lib/env.js';
import { hashWriteKey, stageForClaim } from '../lib/project-init.js';
import { claimWithSession } from '../lib/context-auth.js';
import * as debug from '../lib/debug.js';

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execSync(`open "${url}"`);
    // The empty "" is the window title: without it `start` takes the quoted
    // URL as the title and opens a blank console instead of the browser.
    else if (process.platform === 'win32') execSync(`start "" "${url}"`);
    else execSync(`xdg-open "${url}"`);
  } catch {}
}

// Long enough for anyone actually finishing in the browser. The claim link
// itself never expires, so stopping here loses nothing but the terminal's wait.
export const CLAIM_WAIT_MS = 30 * 60 * 1000;

/**
 * Poll the auth-check endpoint until the user finishes logging in. If the
 * AbortSignal fires, or `waitMs` passes, we resolve to `null` so the caller
 * can keep racing other promises without an unhandled rejection.
 */
async function pollForAuth(token, signal, waitMs = CLAIM_WAIT_MS) {
  const pollUrl = `${SITE_URL}/api/auth/check?token=${token}`;
  const deadline = Date.now() + waitMs;
  while (!signal?.aborted && Date.now() < deadline) {
    try {
      const res = await fetch(pollUrl, { signal });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'complete') return data;
      }
    } catch {
      if (signal?.aborted) return null;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/**
 * Wait for the user to press Enter, but stay cancellable so polling can
 * cut us off if they click the URL instead. Uses raw-mode keypress
 * detection rather than readline because readline + rawMode toggling
 * leaves stdin in configurations that interact badly with the rest of
 * the CLI's UI (see the note above `askYesNo` in lib/ui.js).
 */
function waitForEnter() {
  let cancel;
  const promise = new Promise((resolve) => {
    const { stdin } = process;
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    stdin.removeAllListeners('readable');
    try { stdin.setRawMode(true); } catch {}
    stdin.setEncoding('utf8');
    stdin.resume();

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
    };

    const onData = (key) => {
      if (isAbortKey(key)) { cleanup(); process.stdout.write('\n'); debug.abortExit(130); }
      if (key === '\r' || key === '\n') { cleanup(); resolve('enter'); }
      // Ignore everything else - typing in the terminal at this prompt
      // shouldn't do anything except wait for Enter or get pre-empted by
      // the polling success.
    };

    stdin.on('data', onData);

    cancel = () => { cleanup(); resolve(null); };
  });
  return { promise, cancel: () => cancel() };
}

// Find the API entry whose rootDir matches apiRootDir, falling back to the
// first one if there's no match (typical single-API setup).
function pickApiEntry(settings, apiRootDir) {
  const key = apiRootDir || '.';
  return settings.apis.find((a) => (a.rootDir || '.') === key) || settings.apis[0];
}

/** Who has the project now and what to do next: the end of both claim paths. */
function claimedLines({ email, slug }) {
  return [
    `  ${green('✓')} Logged in as ${bold(email)}.`,
    `  ${green('✓')} Project claimed: ${cyan(`${SITE_URL}/api/${slug}`)}`,
    '',
    '',
    `  ${bold('Next steps:')}`,
    '',
    `    Commit your changes and deploy.`,
    // All one dim line - a cyan `.restless/` inside it would render
    // dim-cyan, which is muddier than just leaving it gray.
    `    ${dim('Include the .restless/ folder so your team and CI use the same config.')}`,
    '',
  ];
}

export default async function setupAccount({
  rootDir,
  apiRootDir,
  update,
  setSpinner,
  apiKey,
  projectId,
  setupKey,
  sessionToken = null,
  claimWaitMs = CLAIM_WAIT_MS,
}) {
  // ── Sub 0: Upload OpenAPI specs ─────────────────────────────────
  // Stage everything the server needs BEFORE the user logs in, so the
  // claim flow has nothing left to do but mark the project as theirs.
  // The OAS lands in `PendingOAS` keyed by setupKeyHash; the claim
  // route picks it up after auth completes. The uploads themselves are
  // shared with `api login` (stageForClaim): the whole
  // settings.json goes up alongside the spec, and a settings failure is
  // non-fatal - the project still claims, just without the blob.
  const settings = loadSettings(rootDir);
  const apiEntry = pickApiEntry(settings, apiRootDir);
  const oasFile = apiEntry?.oasFile;
  const oasPath = oasFile ? path.join(rootDir, oasFile) : null;
  const hasLocalOas = !!(oasPath && fs.existsSync(oasPath));

  update({ status: 'active', activeSub: 0, message: hasLocalOas
    ? [`  Uploading ${bold(oasFile)} to your account.`]
    : [dim('  No local OpenAPI spec found to upload.')],
  });

  setSpinner?.('Uploading OpenAPI spec');
  let artifacts;
  try {
    ({ artifacts, setupKey } = await stageForClaim({
      rootDir, apiRootDir, projectId, setupKey,
      writeKeyHash: apiKey ? hashWriteKey(apiKey) : null,
    }));
  } catch (err) {
    setSpinner?.('');
    update({ status: 'failed', message: [`  ${red('✗')} ${err.message}`] });
    debug.markUnfinished("we couldn't upload your spec to claim the project");
    return { apiKey };
  }
  setSpinner?.('');

  if (artifacts.oas === 'failed') {
    update({ status: 'failed', message: [
      `  ${red('✗')} ${artifacts.error || 'OAS upload failed.'}`,
      dim(`  Endpoint: ${SITE_URL}/api/projects/${projectId}/oas`),
    ]});
    debug.markUnfinished("we couldn't upload your spec to claim the project");
    return { apiKey };
  }
  const endpointCount = artifacts.endpoints;

  // ── Already claimed: nothing left to do here ────────────────────
  // Everything below this point is the claim ceremony, and all of it
  // assumes an unclaimed project: it mints a login token, shows the
  // link, and polls for the claim to complete. On a re-run of a project
  // that already has an owner, that sequence used to run anyway and
  // dead-end - the token was minted (nothing verifies the setup key
  // there), the user was told setup was complete, the claim redirected
  // to `?error=already_claimed`, the SetupToken was never marked done,
  // and the poll waited forever. So stop here instead, and say what
  // actually happened.
  if (artifacts.oas === 'claimed') {
    update({ status: 'done', sub: { 0: 'done', 1: 'done' }, message: [
      `  ${green('✓')} ${bold('This project is already claimed')} - your account has it.`,
      '',
      hasLocalOas
        ? `  ${dim(`Your local ${oasFile} was left alone. To push it to the dashboard:`)}`
        : `  ${dim('To push a spec to the dashboard once you have one:')}`,
      `    ${cyan(`npx ${CLI_NAME} update`)}`,
      '',
      `  ${dim('Everything else in this run (SDK, key, wiring) is applied and ready.')}`,
    ]});
    debug.log('setup-account.already-claimed', { projectId, hasLocalOas });
    return { apiKey };
  }

  if (artifacts.settings === 'failed') {
    update({ message: [`  ${dim('!')} ${artifacts.settingsError || 'Settings upload skipped.'}`] });
  }

  const uploadDoneLine = hasLocalOas
    ? `  ${green('✓')} Uploaded ${bold(oasFile)}.`
    : null;

  // A concrete recap of what the setup actually accomplished. Shown on the
  // completion screen so the final step reads as a payoff with real numbers,
  // not just another identical-looking intermediate step.
  const recap = [
    `  ${bold('Here’s what you set up:')}`,
    `    ${green('✓')} ${endpointCount
      ? `Mapped ${bold(String(endpointCount))} endpoint${endpointCount === 1 ? '' : 's'}`
      : 'Mapped your API'}`,
    `    ${green('✓')} Installed and wired the Restless SDK`,
    hasLocalOas ? `    ${green('✓')} Uploaded ${bold(oasFile)}` : null,
  ].filter(Boolean);

  // ── Sub 1, signed in: claim with the welcome screen's session ──
  // The person already connected their account before setup started, so the
  // claim goes to that account directly, with no second browser trip. Any
  // failure (expired session, server trouble) falls through to the claim link
  // below, which is what every run did before sign-in moved up front.
  setSpinner?.('Claiming your project');
  const direct = await claimWithSession({ projectId, setupKey, token: sessionToken });
  setSpinner?.('');
  debug.log('setup-account.direct-claim', { ok: direct.ok, reason: direct.reason });
  if (direct.ok) {
    update({ sub: { 0: 'done', 1: 'done' }, status: 'done', message: [
      ...celebrationBanner(`🎉  ${bold('Setup complete')}: your API is on Restless`),
      '',
      ...recap,
      '',
      ...claimedLines(direct),
    ] });
    return { apiKey, email: direct.email, slug: direct.slug };
  }

  // ── Sub 1: Log in to claim the project ──────────────────────────
  // Hand the project + setupKey to the server up front, keyed by an
  // opaque token. The login URL we display only needs that token, so
  // the setupKey never lands in browser history, the OAuth referer,
  // the user's terminal scrollback, or screen shares.
  const token = crypto.randomBytes(16).toString('hex');
  setSpinner?.('Preparing login link');
  try {
    const startRes = await fetch(`${SITE_URL}/api/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, projectId, setupKey }),
    });
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => '');
      setSpinner?.('');
      update({ sub: { 0: 'done' }, status: 'failed', message: [
        `  ${red('✗')} Couldn't prepare login link (HTTP ${startRes.status}).`,
        text ? dim(`  ${text.slice(0, 200)}`) : null,
      ].filter(Boolean) });
      debug.markUnfinished("we couldn't make the link to claim your project");
      return { apiKey };
    }
  } catch (err) {
    setSpinner?.('');
    update({ sub: { 0: 'done' }, status: 'failed', message: [
      `  ${red('✗')} Couldn't reach ${SITE_URL} to prepare the login link.`,
      dim(`  ${err.message}`),
    ]});
    debug.markUnfinished("we couldn't make the link to claim your project");
    return { apiKey };
  }
  setSpinner?.('');
  // Short form of `/login?token=<token>`; the site redirects it there.
  // People retype this out of a terminal, so keep it as short as possible.
  const loginUrl = `${SITE_URL}/init/${token}`;

  // Non-interactive (agent / CI): claiming the project is a human action -
  // it needs a browser login that no one is here to complete, and the auth
  // poll below would hold the run for up to CLAIM_WAIT_MS for nothing. The OAS +
  // settings are already uploaded, so the project is fully staged; hand back
  // the claim URL and finish cleanly instead of blocking.
  if (!isInteractive()) {
    update({ status: 'done', sub: { 0: 'done', 1: 'done' }, message: [
      uploadDoneLine,
      uploadDoneLine ? '' : null,
      `  ${green('✓')} SDK is installed and your spec is uploaded.`,
      `  Claim your project on Restless when you're ready (opens a browser login):`,
      '',
      `    ${cyan(loginUrl)}`,
    ].filter((l) => l !== null) });
    debug.log('setup-account.noninteractive', { claimed: false });
    return { apiKey };
  }

  // All the setup work is done - the only thing left is the human action of
  // claiming the project. Mark the step tree complete (all green, no in-progress
  // arrow), celebrate, and frame the login as claiming a reward. The CTA is the
  // hero (bright-green + bold, brightest thing on screen); the URL is demoted to
  // a dim fallback below it.
  update({ status: 'done', sub: { 0: 'done', 1: 'done' }, message: [
    ...celebrationBanner(`🎉  ${bold('Setup complete')}: your API is ready to claim`),
    '',
    ...recap,
    '',
    `  ${green(bold('❯ Press Enter to open your browser and log in'))}`,
    '',
    dim('  Didn’t open? Paste this link instead:'),
    `  ${dim(loginUrl)}`,
  ] });

  // Race the Enter prompt against polling: if the user clicks the link
  // directly (skipping Enter), polling finishes first and we cancel the
  // prompt; if they press Enter, we open the browser and keep polling.
  const pollAbort = new AbortController();
  const pollPromise = pollForAuth(token, pollAbort.signal, claimWaitMs);
  const enter = waitForEnter();

  const winner = await Promise.race([
    enter.promise.then((v) => ({ kind: 'enter', value: v })),
    pollPromise.then((v) => ({ kind: 'poll', value: v })),
  ]);

  let result;
  if (winner.kind === 'enter') {
    openBrowser(loginUrl);
    // Keep the completed step tree (status stays done) so the payoff doesn't
    // snap back to an in-progress look while we wait on the browser login.
    update({ status: 'done', message: [
      ...celebrationBanner(`🎉  ${bold('Setup complete')}: one last step to claim it`),
      '',
      `  ${green(bold('❯ Opening your browser…'))}`,
      // No second glyph: a bare ❯ under the line reads as an input prompt
      // waiting on you, when the only thing left is to finish in the browser.
      `  ${dim('You can finish the setup there!')}`,
      '',
      dim('  Didn’t open? Paste this link instead:'),
      `  ${dim(loginUrl)}`,
    ] });
    process.stdin.resume();
    result = await pollPromise;
    process.stdin.pause();
  } else {
    enter.cancel();
    result = winner.value;
  }
  pollAbort.abort();

  // Gave up waiting. A claim can still land in the browser later; this run
  // just can't confirm it, so it ends unfinished with the way forward.
  if (!result) {
    update({ sub: { 0: 'done' }, status: 'failed', message: [
      `  ${red('✗')} Stopped waiting for the browser after ${Math.round(claimWaitMs / 60000)} minutes.`,
      '',
      `  ${dim('You can still finish there:')} ${dim(loginUrl)}`,
      `  ${dim('Or get a fresh link with')} ${cyan(`npx ${CLI_NAME} login`)}${dim('.')}`,
    ] });
    debug.markUnfinished("we didn't see the project get claimed");
    return { apiKey };
  }

  const { email, slug } = result;

  update({ sub: { 0: 'done', 1: 'done' }, status: 'done', message: [
    uploadDoneLine,
    ...claimedLines({ email, slug }),
    // `uploadDoneLine` is conditionally null, but the blank separators are
    // real content - filtering on truthiness dropped them and jammed this
    // whole block against the checkmarks above it.
  ].filter((l) => l !== null && l !== undefined) });

  return { apiKey, email, slug };
}
