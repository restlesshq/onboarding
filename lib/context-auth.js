import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { bold, dim, cyan, green, red, startSpinner, singleSelect, waitForKey } from './ui.js';
import { SITE_URL, CLI_NAME } from './config.js';
import { linkableAnonymousId } from './telemetry.js';

/**
 * Signing in as a PERSON rather than as a project.
 *
 * `update` and `oas` can name their project before they authenticate: they run
 * where `init` already ran, so `.restless/settings.json` holds a projectId and
 * the token is bound to it (see `cli-token.js`). `context` cannot. It is meant
 * to run in the repos that project has no record of - the docs repo, the
 * client SDK, the frontend calling the API - so there is nothing local to name
 * a project with, and asking the developer to paste a UUID is not an answer.
 *
 * So the handshake is the same three steps with the projectId left out, and it
 * gains a fourth: once approved, ask the server which projects this person can
 * reach and let them pick. The token that comes back is bound to them, not to
 * a project, and the server re-checks membership on every write.
 *
 * The token is cached under the account, not under a project id, because it is
 * not about a project. One browser trip covers every repo you index today.
 */

const ACCOUNT_TOKEN_FILE = path.join(os.homedir(), '.restless', 'account.json');
// 60s buffer, so we never spend a token that expires mid-request.
const CACHE_BUFFER_MS = 60 * 1000;

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(ACCOUNT_TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** A cached account token that is still comfortably valid, or null. */
export function loadAccountToken() {
  const parsed = readCache();
  const expiresAt = parsed?.expiresAt ? Date.parse(parsed.expiresAt) : 0;
  if (typeof parsed?.token === 'string' && expiresAt - CACHE_BUFFER_MS > Date.now()) {
    return { token: parsed.token, expiresAt, email: parsed.email || '' };
  }
  return null;
}

export function saveAccountToken({ token, expiresAt, email }) {
  try {
    fs.mkdirSync(path.dirname(ACCOUNT_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(
      ACCOUNT_TOKEN_FILE,
      JSON.stringify({ token, expiresAt, email: email || '' }, null, 2) + '\n',
      { mode: 0o600 },
    );
  } catch (err) {
    // Non-fatal: we just re-do the browser dance next time.
    console.log(dim(`  ! Couldn't cache your session at ${ACCOUNT_TOKEN_FILE}: ${err.message}`));
  }
}

/** Drop a token the server has rejected, so the next run signs in again. */
export function clearAccountToken() {
  try { fs.unlinkSync(ACCOUNT_TOKEN_FILE); } catch {}
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execSync(`open "${url}"`, { stdio: 'ignore' });
    else if (process.platform === 'win32') execSync(`start "" "${url}"`, { stdio: 'ignore' });
    else execSync(`xdg-open "${url}"`, { stdio: 'ignore' });
  } catch {
    // Best-effort. The URL is printed either way.
  }
}

/**
 * Get a usable account token, reusing the cached one when possible and
 * otherwise running the browser handshake.
 *
 * Returns `{ ok: true, token, cached }`, or `{ ok: false, reason, error }`
 * with `reason` one of 'start-failed' | 'unreachable' | 'expired' | 'timeout'.
 * Never exits the process - the caller decides what a failure means.
 */
/**
 * Never opens a browser unasked. At a terminal the link waits for Enter; with
 * `linkOnly` (a coding agent, nobody to press a key) it is printed and polled.
 * `pressed` says the caller already got that keypress (the `init` welcome
 * screen's sign-in button), so the browser opens straight away. `note`
 * replaces the lines under the link, which by default describe the session
 * `context` asks for.
 */
export async function signIn({ interactive = true, linkOnly = false, pressed = false, note = null } = {}) {
  const cached = loadAccountToken();
  if (cached) return { ok: true, token: cached.token, cached: true };

  if (!interactive && !linkOnly) {
    return {
      ok: false,
      reason: 'timeout',
      error: 'No signed-in session, and signing in needs a browser.',
    };
  }

  const token = crypto.randomBytes(32).toString('hex');

  // Step 1: stage the token. `scope: 'account'` is what tells the server this
  // one is not bound to a project. The anonymous id lets the server tie this
  // machine's telemetry to whoever approves it; absent when telemetry is off.
  const anonymousId = linkableAnonymousId();
  try {
    const startRes = await fetch(`${SITE_URL}/api/auth/cli/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, scope: 'account', ...(anonymousId ? { anonymousId } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!startRes.ok) {
      const text = await startRes.text().catch(() => '');
      return {
        ok: false,
        reason: 'start-failed',
        error: `Couldn't start sign-in (HTTP ${startRes.status}).${text ? ` ${text.slice(0, 200)}` : ''}`,
      };
    }
  } catch (err) {
    return { ok: false, reason: 'unreachable', error: `Couldn't reach ${SITE_URL}: ${err.message}` };
  }

  // Step 2: browser. The URL is always printed, for SSH sessions and dev
  // containers where opening one does nothing, and for anyone who'd rather paste it.
  const authUrl = `${SITE_URL}/api/auth/cli?token=${token}`;
  console.log('');
  console.log(`  ${bold('Sign in to Restless in your browser.')}`);
  console.log('');
  console.log(`    ${cyan(authUrl)}`);
  console.log('');
  for (const line of note || ['This session can read and write context for your projects,', 'and lasts 24 hours.']) {
    console.log(dim(`  ${line}`));
  }
  console.log('');
  if (interactive && pressed) {
    openBrowser(authUrl);
  } else if (interactive) {
    process.stdout.write(`  ${dim('Press')} ${bold('Enter')} ${dim('to open it in your browser.')}`);
    await waitForKey();
    process.stdout.write('\n');
    openBrowser(authUrl);
  } else {
    console.log(dim('  Open the link above to continue. Waiting up to 10 minutes.'));
  }

  // Step 3: poll until approved.
  const pollSpinner = startSpinner('Waiting for sign-in');
  const POLL_INTERVAL_MS = 2000;
  const POLL_DEADLINE = Date.now() + 10 * 60 * 1000; // the server's pending TTL
  let approvedExpiresAt = null;
  while (Date.now() < POLL_DEADLINE) {
    try {
      const checkRes = await fetch(`${SITE_URL}/api/auth/cli/check?token=${token}`, {
        cache: 'no-store',
      });
      if (checkRes.status === 410) {
        pollSpinner.stop();
        return { ok: false, reason: 'expired', error: 'The sign-in link expired before you used it.' };
      }
      if (checkRes.ok) {
        const data = await checkRes.json();
        if (data.status === 'authorized') {
          approvedExpiresAt = Date.parse(data.expiresAt);
          break;
        }
      }
    } catch {
      // Network blip. Keep polling inside the deadline.
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  pollSpinner.stop();

  if (!approvedExpiresAt) {
    return { ok: false, reason: 'timeout', error: 'Timed out waiting for you to sign in.' };
  }

  saveAccountToken({ token, expiresAt: new Date(approvedExpiresAt).toISOString() });
  console.log(green('  ✓ Signed in.'));
  return { ok: true, token, cached: false };
}

/**
 * The projects this session can write to.
 *
 * Returns `{ ok: true, projects, email }` or `{ ok: false, expired?, error }`.
 * `expired` tells the caller the cached token is dead and signing in again is
 * the fix, rather than something being wrong with the request.
 */
export async function listProjects(token) {
  try {
    const res = await fetch(`${SITE_URL}/api/auth/cli/projects?token=${token}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expired: true, error: 'Your session expired or was revoked.' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Couldn't list your projects (HTTP ${res.status}).${text ? ` ${text.slice(0, 200)}` : ''}` };
    }
    const data = await res.json();
    return { ok: true, projects: data.projects || [], email: data.email || '' };
  } catch (err) {
    return { ok: false, error: `Couldn't list your projects: ${err.message}` };
  }
}

/**
 * Which project this repo's context belongs to.
 *
 * `preferredId` short-circuits the question when the answer is already known:
 * `--project`, or the projectId sitting in this repo's own
 * `.restless/settings.json`. Either way it is checked against the list, so a
 * stale id in a committed file cannot silently send context to a project the
 * person running it cannot even see.
 *
 * `requirePreferred` says what to do when it does not match, and the two
 * callers want opposite things. A `--project` that names an unreachable
 * project is a mistake worth stopping for: the user asked for something
 * specific and did not get it. A projectId picked up from settings is a guess
 * on our part, so failing the whole run over it would be us turning our own
 * inference into the user's problem - it falls back to asking instead.
 */
export async function pickProject({
  token,
  preferredId = '',
  requirePreferred = true,
  interactive = true,
  message = 'Which project should this repo\'s context go to?',
}) {
  const listed = await listProjects(token);
  if (!listed.ok) return listed;

  const { projects } = listed;
  if (projects.length === 0) {
    return {
      ok: false,
      error: `No projects on your account yet. Run ${`npx ${CLI_NAME} init`} in your API's repo first.`,
    };
  }

  if (preferredId) {
    // A slug is accepted too: it is what people see in their dashboard URL.
    const match = projects.find((p) => p.projectId === preferredId || (p.slug && p.slug === preferredId));
    if (match) return { ok: true, project: match, remembered: true };
    if (requirePreferred) {
      return {
        ok: false,
        error: `You don't have access to project ${preferredId}, or it no longer exists.`,
      };
    }
    // Our guess was wrong. Say so quietly and ask properly.
    console.log('');
    console.log(dim(`  This repo names project ${preferredId}, which isn't on your account.`));
  }

  if (projects.length === 1) return { ok: true, project: projects[0] };

  if (!interactive) {
    return {
      ok: false,
      error: `Your account has ${projects.length} projects and there's no TTY to pick one. Pass --project <id>.`,
      projects,
    };
  }

  // The projectId means nothing to a person; the slug (the dashboard URL) only tells same-named projects apart.
  const label = (p) => p.name || p.slug || p.projectId;
  const shared = (p) => projects.filter((q) => label(q) === label(p)).length > 1;
  const idx = await singleSelect(
    projects.map((p) => ({ label: label(p), hint: shared(p) && p.slug ? dim(p.slug) : '' })),
    { message, defaultIndex: 0 },
  );
  return { ok: true, project: projects[idx] };
}

/**
 * Claim this run's project for the signed-in account, with no browser trip.
 *
 * `init` signs in at its welcome screen, so by the claim step the cached
 * account session already says who this is. Returns `{ ok: true, email, slug }`,
 * or `{ ok: false, reason }` and the caller falls back to the claim link. A
 * session the server no longer accepts is dropped, so the next sign-in is fresh.
 * Never signs in itself: with no session it reports 'no-session'.
 *
 * `token` is the session the caller signed in with; without one, the cache.
 * Passing it matters when two runs sign in as different people at once: the
 * cache holds whichever finished last.
 */
export async function claimWithSession({ projectId, setupKey, token = null }) {
  const sessionToken = token || loadAccountToken()?.token;
  if (!sessionToken) return { ok: false, reason: 'no-session' };
  const attempt = async () => {
    try {
      const res = await fetch(`${SITE_URL}/api/auth/cli/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: sessionToken, project_id: projectId, setup_key: setupKey }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.claimed && data.project_slug) {
        return { ok: true, email: data.user_email || '', slug: data.project_slug };
      }
      return { ok: false, reason: data.error || `http-${res.status}`, retryable: res.status >= 500 };
    } catch (err) {
      return { ok: false, reason: 'unreachable', error: err.message, retryable: true };
    }
  };
  // A lost response may still have claimed, and the fallback claim link can't
  // finish once the setup key is spent. Retrying is safe: the server answers a
  // project already claimed to this account with success.
  let result = await attempt();
  if (!result.ok && result.retryable) result = await attempt();
  // Drop it only if the cache still holds this token, not another run's.
  if (result.reason === 'session_invalid' && loadAccountToken()?.token === sessionToken) clearAccountToken();
  const { retryable, ...rest } = result;
  return rest;
}

/** The standard phrasing for a session we couldn't get, so every caller says
 *  the same thing. */
export function reportSignInFailure(res, { retry = 'context' } = {}) {
  console.log('');
  console.log(red(`  ✗ ${res.error}`));
  if (res.reason === 'expired' || res.reason === 'timeout') {
    console.log(dim(`  Re-run ${cyan(`npx ${CLI_NAME} ${retry}`)} when you're ready.`));
  }
  console.log('');
}
