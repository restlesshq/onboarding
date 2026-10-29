import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SITE_URL } from './config.js';
import { detectAgent, invocationSource } from './env.js';
import { apiDirKey, loadSettings, saveSettings } from './settings.js';
import { countOperations, parseOas } from './oas-parse.js';
import { postOas } from './oas-upload.js';
import { readSpecForUpload } from './oas-bundle.js';
import * as timings from './timings.js';
import * as debug from './debug.js';

/**
 * Project registration, split out from the interactive `prepare-account`
 * step so the agent-facing commands (`api key`) and the guided setup mint
 * projects exactly the same way. Everything here is deterministic plumbing -
 * no UI, no AI, no prompts.
 */

/** A fresh write key. Same shape the SDK expects in `RESTLESS_KEY`. */
export function generateWriteKey() {
  return 'rstlss_' + crypto.randomBytes(32).toString('hex');
}

export function hashWriteKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

/**
 * How this setup was driven, recorded on the project at registration so we
 * can tell a human running `init` in a terminal from an agent that was
 * asked to run it, and see which agent did the work either way.
 *
 *   source - 'cli' | 'agent', from the environment (see invocationSource).
 *   agent  - 'claude' | 'codex' | null. In an agent-invoked run that's the
 *            agent driving us. In a terminal run it's the one the user
 *            picked in the setup flow, which only that flow knows, so it
 *            passes it in explicitly; `detectAgent()` is the fallback for
 *            the standalone commands (`api key`) where nothing was picked.
 *
 * Both are diagnostics, so an unrecognized value is never worth failing a
 * registration over - the server drops what it doesn't know.
 */
function setupProvenance({ source, agent } = {}) {
  const which = agent || detectAgent();
  return {
    setup_source: source || invocationSource(),
    ...(which ? { setup_agent: which } : {}),
  };
}

/**
 * Register a project for this write key. The server only ever sees the
 * hash - never the key itself. Retries once on a 5xx: the metrics service
 * cold-starts and the first request often times out at the edge.
 *
 * Returns `{ projectId, setupKey }`. Throws with a readable message.
 */
export async function registerProject({ writeKeyHash, source, agent, fetchImpl = fetch }) {
  const call = () => fetchImpl(`${SITE_URL}/api/projects/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      write_key_hash: writeKeyHash,
      ...setupProvenance({ source, agent }),
    }),
  });

  // One span across both attempts, including the 2s backoff between them:
  // what the caller waited for is the whole thing, and splitting it per
  // attempt would report two fast requests for a slow registration.
  const endSpan = timings.start('POST /api/projects/init', { kind: timings.KINDS.NET });
  let res;
  let retried = false;
  try {
    res = await call();
    if (res.status >= 500) {
      retried = true;
      await new Promise((r) => setTimeout(r, 2000));
      res = await call();
    }
  } finally {
    endSpan({ status: res?.status ?? 0, retried });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to initialize project (HTTP ${res.status}). ${text.slice(0, 200)}`.trim());
  }
  const data = await res.json();
  return { projectId: data.project_id, setupKey: data.setup_key };
}

/**
 * Where per-project credentials live: the user's home dir, never the repo,
 * so they don't travel with the code. Mirrors the device-auth token cache
 * `npx restless update` already keeps here.
 */
export function credsPath(projectId) {
  return path.join(os.homedir(), '.restless', 'projects', `${projectId}.json`);
}

/**
 * Persist the setup key so a LATER command can still prove ownership of a
 * project it didn't mint. Without this the setup key only existed in the
 * memory of the process that created it, which is why claiming had to
 * happen inside the same run - and why a failed setup could never be
 * resumed. Written 0600.
 */
export function saveProjectCreds({ projectId, setupKey, apiKey }) {
  try {
    const file = credsPath(projectId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = loadProjectCreds(projectId) || {};
    // Only a HASH of the write key is persisted - enough to prove "this key
    // belongs to this project" (the reuse guard and findCredsByApiKey match
    // by hash) without parking a second plaintext copy of a live credential
    // outside .env. Legacy plaintext from older CLI versions is dropped the
    // next time the file is written.
    const merged = {
      ...existing,
      projectId,
      setupKey,
      ...(apiKey ? { apiKeyHash: hashWriteKey(apiKey) } : {}),
      savedAt: new Date().toISOString(),
    };
    delete merged.apiKey;
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

export function loadProjectCreds(projectId) {
  try {
    return JSON.parse(fs.readFileSync(credsPath(projectId), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Does this creds file belong to this write key? New files hold only the
 * key's hash; files written by older CLI versions hold the plaintext key,
 * so both are accepted (the plaintext copy disappears on next save).
 */
function credsMatchKey(creds, apiKey) {
  if (!creds || !apiKey) return false;
  if (creds.apiKeyHash) return creds.apiKeyHash === hashWriteKey(apiKey);
  return creds.apiKey === apiKey;
}

/**
 * Find the project this write key belongs to, from the creds this machine
 * has saved. This is the recovery path for "key on disk, but settings has
 * no projectId" - a fresh branch, a wiped `.restless/`, a re-init after
 * reset. Without it, that state re-registers the key and orphans it (see
 * ensureProject below).
 *
 * The same key can appear in several creds files precisely because of a
 * past re-registration. Ingress attributes uploads to the FIRST project
 * registered for a key, so the oldest `savedAt` is the one that matches
 * where the logs actually go.
 */
export function findCredsByApiKey(apiKey) {
  if (!apiKey) return null;
  try {
    const dir = path.join(os.homedir(), '.restless', 'projects');
    const matches = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const creds = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (credsMatchKey(creds, apiKey) && creds.projectId && creds.setupKey) matches.push(creds);
      } catch {}
    }
    if (!matches.length) return null;
    matches.sort((a, b) => String(a.savedAt || '').localeCompare(String(b.savedAt || '')));
    return matches[0];
  } catch {
    return null;
  }
}

/**
 * The project this write key belongs to - minting one only when we don't
 * already have it.
 *
 * `/api/projects/init` is not idempotent: it returns a fresh project id on
 * every call. So re-registering an unchanged key on each run silently
 * orphans the previous project - the running server keeps uploading under a
 * key the server maps to the OLD project, while the CLI verifies the new and
 * permanently empty one, and reports "your key is stale". Reuse instead, in
 * two tiers: settings already names a project whose stored creds match this
 * key, or - when settings has no projectId at all - the creds this machine
 * saved when it first registered the key (`findCredsByApiKey`).
 *
 * `registerUnknown: false` makes an unrecognized key return null instead of
 * registering it. Callers holding a key of unknown provenance (found on
 * disk, no local creds) use this to mint a fresh key rather than create the
 * orphaned pairing described above - registering someone's old key is the
 * one move guaranteed to be wrong.
 *
 * `source` / `agent` are the setup-provenance fields described above; they
 * only reach the server on the branch that actually registers, since the
 * reuse branches never call it.
 *
 * Returns `{ projectId, setupKey, reused, recovered }`, or null when
 * `registerUnknown` is false and nothing matched.
 */
export async function ensureProject({ rootDir, apiRootDir, apiKey, source, agent, registerUnknown = true, fetchImpl = fetch }) {
  const settings = loadSettings(rootDir);
  const key = apiDirKey(apiRootDir);
  const entry = (settings.apis || []).find((a) => apiDirKey(a.rootDir) === key) || settings.apis?.[0];
  const stored = entry?.projectId ? loadProjectCreds(entry.projectId) : null;

  if (entry?.projectId && stored?.setupKey && credsMatchKey(stored, apiKey)) {
    const fresh = await refreshSetupKey({ projectId: entry.projectId, stored, apiKey, fetchImpl });
    return { projectId: entry.projectId, reused: true, ...fresh };
  }

  const recovered = findCredsByApiKey(apiKey);
  if (recovered) {
    recordProjectId({ rootDir, apiRootDir, projectId: recovered.projectId });
    const fresh = await refreshSetupKey({ projectId: recovered.projectId, stored: recovered, apiKey, fetchImpl });
    return { projectId: recovered.projectId, reused: true, recovered: true, ...fresh };
  }

  if (!registerUnknown) return null;

  const { projectId, setupKey } = await registerProject({
    writeKeyHash: hashWriteKey(apiKey),
    source,
    agent,
    fetchImpl,
  });
  recordProjectId({ rootDir, apiRootDir, projectId });
  saveProjectCreds({ projectId, setupKey, apiKey });
  return { projectId, setupKey, reused: false };
}

/**
 * Stage the local artifacts (OAS spec + settings) on the server so the
 * claim flow can attach them. The dashboard's claim route consumes
 * PendingOAS / PendingSettings rows keyed by setupKeyHash - anything not
 * uploaded BEFORE the user claims simply never appears on the project.
 * Mirrors the uploads the guided setup-account step performs; `api login`
 * calls this so the agent flow's claim isn't empty.
 *
 * Failures are reported, not thrown - a claim without a spec is degraded,
 * not broken. Returns { oas, settings, endpoints, error?, settingsError? }
 * where settings is 'uploaded' | 'none' | 'failed' and oas is one of those
 * plus 'claimed'.
 *
 * 'claimed' means the project already has an owner, so there is nothing to
 * stage: the spec lives on the project itself now and the server refuses to
 * take a staged one (the setup key is spent - claim deletes the server's copy
 * of it). That is a different situation from a failure, and callers must not
 * treat it as one. Re-syncing a spec after the claim is `npx restless update`.
 *
 * The API entry is picked by projectId first (the project being claimed),
 * then by apiRootDir when given, then the first entry - so both callers
 * (the guided setup-account step and `api login`) resolve the same spec.
 */
export async function uploadPendingArtifacts({ rootDir, apiRootDir, projectId, setupKey, fetchImpl = fetch }) {
  const settings = loadSettings(rootDir);
  const apis = settings.apis || [];
  const entry = apis.find((a) => a.projectId === projectId)
    || (apiRootDir ? apis.find((a) => apiDirKey(a.rootDir) === apiDirKey(apiRootDir)) : null)
    || apis[0];
  const result = { oas: 'none', settings: 'none', endpoints: 0 };

  const oasFile = entry?.oasFile;
  const oasPath = oasFile ? path.join(rootDir, oasFile) : null;
  if (oasPath && fs.existsSync(oasPath)) {
    const spec = readSpecForUpload(oasPath, oasFile);
    const oasRaw = spec.ok ? spec.raw : null;
    const isJson = spec.format === 'json';
    // Count before the request, not after a successful one: callers show
    // "mapped N endpoints" in their recap, and that number is true whether
    // or not the upload was the right operation to attempt.
    if (oasRaw !== null) {
      try {
        const parsed = parseOas(oasRaw, isJson ? 'json' : 'yaml');
        if (parsed.ok) result.endpoints = countOperations(parsed.oas);
      } catch {}
    }
    if (oasRaw === null) {
      result.oas = 'failed';
      result.error = spec.error;
    } else {
      // Spec uploads carry the whole document, so this is the one request
      // in the run whose duration tracks the size of the user's API.
      const endSpan = timings.start('POST /api/projects/:id/oas', {
        kind: timings.KINDS.NET,
        bytes: oasRaw.length,
      });
      try {
        const res = await postOas({
          url: `${SITE_URL}/api/projects/${projectId}/oas`,
          payload: { setup_key: setupKey, oas_raw: oasRaw, format: isJson ? 'json' : 'yaml' },
          fetchImpl,
        });
        endSpan({ status: res.status });
        if (res.ok) {
          result.oas = 'uploaded';
        } else if (res.status === 409 || res.status === 401) {
          // 409 says so outright. A 401 is EITHER a claimed project (claim deletes the server's
          // copy of the key) or one whose key expired; `stageForClaim` asks the server which.
          result.oas = 'claimed';
          if (res.status === 401) result.keyRejected = true;
        } else {
          // Quote the server: "HTTP 413" alone reads as a network fault, while
          // the body names the byte limit and how far over the spec is.
          const detail = await res.text().catch(() => '');
          result.oas = 'failed';
          result.error = `OAS upload failed (HTTP ${res.status}).${detail ? ` ${detail.slice(0, 200)}` : ''}`;
        }
      } catch (err) {
        result.oas = 'failed';
        result.error = `OAS upload error: ${err.message}`;
      } finally {
        endSpan();
      }
    }
  }

  if (apis.length) {
    const endSpan = timings.start('POST /api/projects/:id/settings', { kind: timings.KINDS.NET });
    try {
      const res = await fetchImpl(`${SITE_URL}/api/projects/${projectId}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setup_key: setupKey, settings }),
        signal: AbortSignal.timeout(10000),
      });
      endSpan({ status: res.status });
      if (res.status === 401) result.keyRejected = true;
      if (!res.ok) {
        result.settings = 'failed';
        result.settingsError = `Settings upload skipped (HTTP ${res.status}).`;
      } else {
        result.settings = 'uploaded';
      }
    } catch (err) {
      result.settings = 'failed';
      result.settingsError = `Settings upload skipped: ${err.message}`;
    } finally {
      endSpan();
    }
  }

  return result;
}

/** A setup key lives six hours server-side; past this age a reused one is renewed up front so the
 *  test step's dashboard poll cannot 401 and read as "no log landed". */
export const SETUP_KEY_FRESH_MS = 60 * 60 * 1000;

export function setupKeyIsFresh(stored, now = Date.now()) {
  const savedAt = Date.parse(stored?.savedAt || '');
  return Number.isFinite(savedAt) && now - savedAt < SETUP_KEY_FRESH_MS;
}

/** Stored key when still fresh; otherwise renewed and re-saved. A failed renewal (network, or the
 *  project was claimed meanwhile) falls back to the stored key rather than blocking setup. */
export async function refreshSetupKey({ projectId, stored, apiKey, fetchImpl = fetch }) {
  if (setupKeyIsFresh(stored)) return { setupKey: stored.setupKey, renewed: false };
  try {
    const renewed = await renewSetupKey({ projectId, writeKeyHash: hashWriteKey(apiKey), fetchImpl });
    if (renewed.claimed) return { setupKey: stored.setupKey, renewed: false, claimed: true };
    saveProjectCreds({ projectId, setupKey: renewed.setupKey, apiKey });
    return { setupKey: renewed.setupKey, renewed: true };
  } catch (err) {
    debug.log('project-init.renew-failed', { message: String(err?.message || '').slice(0, 160) });
    return { setupKey: stored.setupKey, renewed: false };
  }
}

/**
 * Link an unclaimed project to the email the user confirmed, so signing in to the dashboard with it
 * finds the project even without the claim link. Best-effort: returns whether the server answered ok.
 */
export async function saveSetupEmail({ projectId, setupKey, email, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl(`${SITE_URL}/api/projects/${projectId}/setup-progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ setup_key: setupKey, step: 'email', status: 'done', email }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch (err) {
    debug.log('project-init.email-failed', { message: String(err?.message || '').slice(0, 160) });
    return false;
  }
}

/**
 * Re-issue the setup key for a project this write key already registered. `/api/projects/init`
 * is idempotent per write key: same project and a fresh key while unclaimed, or 409 once claimed.
 * Returns `{ setupKey }` or `{ claimed: true }`. Throws with a readable message otherwise.
 */
export async function renewSetupKey({ projectId, writeKeyHash, fetchImpl = fetch }) {
  const res = await fetchImpl(`${SITE_URL}/api/projects/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ write_key_hash: writeKeyHash }),
  });
  if (res.status === 409) return { claimed: true };
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Couldn't renew the setup key (HTTP ${res.status}). ${text.slice(0, 200)}`.trim());
  }
  const data = await res.json();
  // One write key maps to one project forever, so a different id means the stored pairing is wrong.
  if (data.project_id !== projectId) {
    throw new Error(`This write key belongs to project ${data.project_id}, not ${projectId}.`);
  }
  return { setupKey: data.setup_key };
}

/**
 * `uploadPendingArtifacts`, but a setup key the server stopped accepting (they last 6 hours) is
 * renewed and the upload retried, so a resumed setup never hands out a claim link that cannot work.
 * Returns `{ artifacts, setupKey }`: the key that is live now, which the caller must claim with.
 */
export async function stageForClaim({ rootDir, apiRootDir, projectId, setupKey, writeKeyHash, fetchImpl = fetch }) {
  const artifacts = await uploadPendingArtifacts({ rootDir, apiRootDir, projectId, setupKey, fetchImpl });
  if (!artifacts.keyRejected || !writeKeyHash) return { artifacts, setupKey };

  const renewed = await renewSetupKey({ projectId, writeKeyHash, fetchImpl });
  if (renewed.claimed) return { artifacts: { ...artifacts, oas: 'claimed' }, setupKey };

  saveProjectCreds({ projectId, setupKey: renewed.setupKey });
  const retried = await uploadPendingArtifacts({ rootDir, apiRootDir, projectId, setupKey: renewed.setupKey, fetchImpl });
  return { artifacts: retried, setupKey: renewed.setupKey };
}

/**
 * Poll the dashboard for a log landing in `projectId` after `since`.
 * A clean SDK response header only proves capture; this is the other half
 * of the verdict - the upload actually arriving under the key's project.
 * Nothing landing after a clean header is the stale-key signature.
 *
 * Same endpoint and shape the guided test step uses. Resolves `{ landed, count }` as soon as a
 * log shows up, `{ landed: false }` when `timeoutMs` runs out, and `{ unauthorized: true }` on a
 * 401 that `renew` could not clear. Network errors are "not landed yet": the server is known up.
 */
export async function pollForLandedLog({
  projectId,
  setupKey,
  since,
  timeoutMs = 8000,
  delayMs = 1000,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  renew = null,
}) {
  const deadline = Date.now() + timeoutMs;
  // WAIT, not NET: the loop is waiting for a request to arrive at the
  // user's server, and its length says nothing about how fast the CLI is.
  const endSpan = timings.start('poll: for landed log', { kind: timings.KINDS.WAIT });
  let key = setupKey;
  let renewTried = false;
  try {
    while (true) {
      try {
        const res = await fetchImpl(`${SITE_URL}/api/logs/poll`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, setupKey: key, since, limit: 5 }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.logs && data.logs.length > 0) return { landed: true, count: data.logs.length, setupKey: key };
        } else if (res.status === 401) {
          // An expired setup key is not "nothing landed": renew once, else report it as its own state.
          if (renew && !renewTried) {
            renewTried = true;
            const next = await renew().catch(() => null);
            if (next) { key = next; continue; }
          }
          return { landed: false, unauthorized: true, setupKey: key };
        }
      } catch {}
      if (Date.now() >= deadline) return { landed: false, setupKey: key };
      await sleep(delayMs);
    }
  } finally {
    endSpan();
  }
}

/**
 * Record the project id on the API entry it belongs to - one Restless project
 * per API, so this lives on the entry, not at the root. Matches by `rootDir`
 * exactly, and creates a stub entry when nothing is registered under it.
 */
export function recordProjectId({ rootDir, apiRootDir, projectId }) {
  const settings = loadSettings(rootDir);
  const key = apiDirKey(apiRootDir);
  if (!Array.isArray(settings.apis)) settings.apis = [];
  // Exact match only. Falling back to apis[0] would stamp this project onto
  // an unrelated API whenever `--dir` named a directory nothing is registered
  // under, orphaning whatever project that entry already held.
  let target = settings.apis.find((a) => apiDirKey(a.rootDir) === key);

  // No entry yet means `key` ran before `register` - a supported order, and
  // the one the README's command table implies. With nowhere to write, this
  // used to drop the project silently and leave `login` dead-ending on "no
  // Restless project yet". Stub the entry; `register` fills in the rest.
  if (!target) {
    target = { id: crypto.randomUUID(), name: path.basename(rootDir) || 'API', rootDir: key };
    settings.apis.push(target);
  }

  target.projectId = projectId;
  saveSettings(rootDir, settings);
  return target;
}
