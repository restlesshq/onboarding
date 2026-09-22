/**
 * The CLI's own settings, per USER, in `~/.restless/config.json`.
 *
 * Distinct from `.restless/settings.json` (see `lib/settings.js`), which is
 * per PROJECT and committed with the code. Anything that belongs to the
 * person rather than the repo lives here: today only the telemetry opt-out
 * and the anonymous id that goes with it.
 *
 * `~/.restless/` already holds per-user state - the device-auth tokens in
 * `projects/` (`lib/cli-token.js`) and the run logs in `debug/`
 * (`lib/debug.js`) - so this is a new file in an existing home, not a new
 * home. Note those writes use plain `fs` rather than `lib/pathGuard.js`:
 * the guard's whole job is to refuse writes outside the git root the user
 * invoked us from, and the home directory is deliberately outside it.
 *
 * Every read is best-effort. A missing, unreadable, or corrupt config is
 * indistinguishable from a fresh install and yields defaults - a CLI that
 * dies because it could not parse its own preferences file would be a worse
 * bug than any preference it could have read.
 */

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CONFIG_VERSION = 1;

/**
 * Where the file lives. `RESTLESS_CONFIG_DIR` overrides the directory, the
 * same escape hatch `RESTLESS_DEBUG_DIR` gives `lib/debug.js` - tests need a
 * config they can write without touching the real `~/.restless`.
 *
 * Read at call time, not cached, so a test can point it somewhere else
 * between cases.
 */
export function configDir() {
  return process.env.RESTLESS_CONFIG_DIR || path.join(os.homedir(), '.restless');
}

export function configPath() {
  return path.join(configDir(), 'config.json');
}

/** The defaults a fresh install behaves as. */
function emptyConfig() {
  return { version: CONFIG_VERSION, telemetry: {} };
}

/**
 * The stored config, or defaults. Never throws.
 *
 * A file that parses to something other than an object (`null`, an array, a
 * bare string) is treated as absent: it cannot have come from us, and
 * spreading it would produce a config with numeric keys.
 */
export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyConfig();
    return {
      ...emptyConfig(),
      ...raw,
      telemetry: (raw.telemetry && typeof raw.telemetry === 'object' && !Array.isArray(raw.telemetry))
        ? raw.telemetry
        : {},
    };
  } catch {
    return emptyConfig();
  }
}

/**
 * Merge `patch` into the stored config and write it back.
 *
 * Merge rather than overwrite, for the reason `saveCachedToken` learned in
 * `lib/cli-token.js`: this file will grow more sections than telemetry, and
 * a blind write from one of them would silently drop the others.
 *
 * Returns true when the write landed. A failure is not fatal - the caller's
 * change simply does not persist to the next run - so nothing here reports
 * to the user; the one command that needs to say "that didn't save" checks
 * the return value.
 */
export function updateConfig(patch) {
  try {
    const current = loadConfig();
    const next = { ...current, ...patch, version: CONFIG_VERSION };
    // One level of merge for the nested sections, so a patch that sets
    // `telemetry.enabled` keeps `telemetry.anonymousId`.
    for (const key of Object.keys(patch || {})) {
      const a = current[key];
      const b = patch[key];
      if (a && b && typeof a === 'object' && typeof b === 'object'
          && !Array.isArray(a) && !Array.isArray(b)) {
        next[key] = { ...a, ...b };
      }
    }
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * This machine's anonymous id, minting one on first use.
 *
 * A random UUID and nothing else. NOT derived from hostname, username, MAC
 * address, or working directory: the point of the id is to count machines
 * without being able to name one, and anything derived from the environment
 * can be recomputed by someone holding a guess about who they're looking at.
 *
 * Returns a throwaway id when the config can't be written, so a read-only
 * home directory degrades to "every run looks like a new machine" rather
 * than to a crash.
 */
/** The persisted id, or null. Never mints one. */
export function storedAnonymousId() {
  const stored = loadConfig().telemetry?.anonymousId;
  return typeof stored === 'string' && stored.length === 36 ? stored : null;
}

export function anonymousId() {
  const stored = storedAnonymousId();
  if (stored) return stored;
  const minted = crypto.randomUUID();
  updateConfig({ telemetry: { anonymousId: minted } });
  return minted;
}
