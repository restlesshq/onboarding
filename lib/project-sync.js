import path from 'path';
import { loadSettings, saveSettings, findApiEntry } from './settings.js';
import { SITE_URL } from './config.js';
import { clearCachedToken } from './cli-token.js';
import { fingerprintSpec, operationSet } from './oas-source.js';
import { postOas } from './oas-upload.js';
import { readSpecForUpload } from './oas-bundle.js';

/**
 * Talking to the dashboard about one project: pushing the spec, pushing the
 * settings blob, and asking what it currently has.
 *
 * This lives in `lib/` rather than in a step because four places needed it and
 * three of them had written their own copy: the interactive update flow, the
 * flag-driven one, and an inline `fetch` at the bottom of the `update` command.
 * A step is a screen; this is a client.
 */

/**
 * Push the spec. Post-claim this is the device-token path on
 * `POST /api/projects/:id/oas`; the pre-claim `setup_key` staging path is a
 * different mode of the same endpoint and is not what we want here.
 */
export async function pushOas({ rootDir, oasFile, projectId, token }) {
  const spec = readSpecForUpload(path.join(rootDir, oasFile), oasFile);
  if (!spec.ok) return { ok: false, error: spec.error };
  try {
    const res = await postOas({
      url: `${SITE_URL}/api/projects/${projectId}/oas`,
      payload: { token, oas_raw: spec.raw, format: spec.format },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expired: true, error: 'Authorization expired or was revoked.' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Spec upload failed (HTTP ${res.status}).${text ? ` ${text.slice(0, 200)}` : ''}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, endpoints: data.endpoints ?? null };
  } catch (err) {
    return { ok: false, error: `Spec upload failed: ${err.message}` };
  }
}

/** Push the settings blob - what the dashboard reads for the project name. */
export async function pushSettings({ rootDir, projectId, token }) {
  try {
    const res = await fetch(`${SITE_URL}/api/projects/${projectId}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, settings: loadSettings(rootDir) }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expired: true, error: 'Authorization expired or was revoked.' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Settings sync failed (HTTP ${res.status}).${text ? ` ${text.slice(0, 200)}` : ''}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Settings sync failed: ${err.message}` };
  }
}

/**
 * What the dashboard currently has, so we can tell the developer their copy is
 * ahead of it.
 *
 * This is the comparison that actually matters and the one that was missing.
 * Everything else here compares the local file against its own source, which
 * answers "is my file stale" - a genuinely different question, and not the one
 * someone is asking when endpoints are missing from their docs. A local
 * fingerprint also cannot see a push from a teammate or another checkout.
 *
 * Returns `{ ok: false }` on any failure. Never fatal: not knowing what the
 * dashboard has is a reason to say less, not to stop.
 */
export async function fetchDashboardSpec({ projectId, token }) {
  try {
    const res = await fetch(
      // The credential belongs in a header: a query string ends up in access
      // logs, proxy logs and Referer headers, and this one is a 24h device
      // token. The `?token=` below is transitional and only there because the
      // server currently reads `searchParams.get("token")` - once the GET in
      // app's `api/projects/[projectId]/oas/route.ts` reads the Authorization
      // header, delete the query parameter from this URL.
      `${SITE_URL}/api/projects/${projectId}/oas?token=${encodeURIComponent(token)}`,
      {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, expired: true, error: 'Authorization expired or was revoked.' };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      ok: true,
      hasSpec: !!data.hasSpec,
      endpoints: data.endpoints ?? 0,
      operations: Array.isArray(data.operations) ? data.operations : [],
      oasHash: data.oasHash ?? null,
      oasSyncedAt: data.oasSyncedAt ?? null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Compare the local spec against the dashboard's. `remote` is a successful
 * `fetchDashboardSpec` result.
 *
 * Operation sets rather than the documents themselves: the dashboard hands back
 * a normalized list, so this is precise about which endpoints it lacks without
 * downloading a spec. The hash catches drift that isn't endpoint-shaped, which
 * still matters because descriptions and schemas are what the docs serve.
 */
export function compareWithDashboard({ localOas, localHash, remote }) {
  if (!remote?.ok) return null;
  if (!remote.hasSpec) return { status: 'no-remote-spec' };

  if (localHash && remote.oasHash && localHash === remote.oasHash) {
    return { status: 'in-sync', endpoints: remote.endpoints };
  }

  const local = new Set(operationSet(localOas));
  const dashboard = new Set(remote.operations);
  const missing = [...local].filter((op) => !dashboard.has(op)).sort();
  const extra = [...dashboard].filter((op) => !local.has(op)).sort();

  return {
    status: 'behind',
    missing, // in your spec, not on the dashboard
    extra, // on the dashboard, not in your spec
    // Same operations either way, so what differs is inside them.
    contentOnly: missing.length === 0 && extra.length === 0,
    endpoints: remote.endpoints,
    oasSyncedAt: remote.oasSyncedAt,
  };
}

/** Record what we just pushed, so the next run can spot a local edit. */
function recordPushedFingerprint({ rootDir, apiEntry, oasFile }) {
  const fp = fingerprintSpec(path.join(rootDir, oasFile));
  if (!fp) return;
  const settings = loadSettings(rootDir);
  const entry = findApiEntry(settings, apiEntry);
  if (!entry) return;
  Object.assign(entry, fp);
  saveSettings(rootDir, settings);
}

/**
 * Publish a project: the spec (when there is a new one) and then the settings
 * blob, which always goes up because it is what the dashboard reads for the
 * name.
 *
 * One function because both callers had the same four-step sequence written out
 * by hand - push, fingerprint, push, clear the token cache on rejection - and
 * "remember to fingerprint after pushing" is not something two call sites
 * should each have to get right. The flag-driven path had already forgotten it
 * once, which is why a `--status` on a maintained spec could only ever answer
 * "no record of pushing it".
 *
 * Reports which half landed rather than collapsing both into "failed", because
 * a spec that pushed and a settings sync that didn't is not the same situation
 * as neither happening.
 */
export async function syncProject({ rootDir, apiEntry, oasFile = null, token }) {
  const out = { ok: false, specSynced: false, settingsSynced: false, endpoints: null };

  if (oasFile) {
    const push = await pushOas({
      rootDir, oasFile, projectId: apiEntry.projectId, token,
    });
    if (!push.ok) {
      if (push.expired) clearCachedToken(apiEntry.projectId);
      return { ...out, error: push.error, expired: !!push.expired };
    }
    // Fingerprint what actually landed, so the next run can tell a local edit
    // from "nothing has happened since".
    recordPushedFingerprint({ rootDir, apiEntry, oasFile });
    out.specSynced = true;
    out.endpoints = push.endpoints;
  }

  const synced = await pushSettings({ rootDir, projectId: apiEntry.projectId, token });
  if (!synced.ok) {
    if (synced.expired) clearCachedToken(apiEntry.projectId);
    return { ...out, error: synced.error, expired: !!synced.expired };
  }
  out.settingsSynced = true;
  out.ok = true;
  return out;
}
