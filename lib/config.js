import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Override for local dev with `RESTLESS_SITE_URL=http://localhost:4099 npx restless init`.
export const SITE_URL = process.env.RESTLESS_SITE_URL || 'https://app.restless.ai';
export const CALENDLY_URL = 'https://calendly.com/restlessai/30min';

// How the user invoked us (e.g. "restless", or "api" when ReadMe's api package
// dispatches to us), derived from argv[1] so output matches whatever bin name
// shipped - no hardcoding the package name in user-facing strings. The bin file
// is named restless.js to match the bin entry, because Windows shims put the
// real file path in argv[1] rather than the .bin/ shim path.
export const CLI_NAME = path.basename(process.argv[1] || '', '.js') || 'restless';

// The CLI's own install root, resolved from this file (not cwd) so it reflects
// where the running CLI actually lives, wherever the user invoked it from.
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * True when the CLI is running from a local checkout or an `npm link`ed copy
 * rather than a published, installed package.
 *
 * Published installs - an `npx` cache, a global `npm i -g`, or a project
 * dependency - all live under a `node_modules` directory. A checkout run
 * directly (`node bin/restless.js`) or symlinked in via `npm link` does not, and
 * ships the repo's `.git` alongside it (which `npm link`'s symlink target
 * still exposes even under `--preserve-symlinks`). Either signal marks a
 * local, linked run.
 *
 * `RESTLESS_LINKED=1|0` forces the answer, for tests and manual overrides.
 */
function detectLinkedInstall() {
  const forced = process.env.RESTLESS_LINKED;
  if (forced === '1') return true;
  if (forced === '0') return false;
  const underNodeModules = /[\\/]node_modules[\\/]/.test(PKG_ROOT);
  let hasGit = false;
  try {
    hasGit = fs.existsSync(path.join(PKG_ROOT, '.git'));
  } catch {}
  return !underNodeModules || hasGit;
}

export const IS_LINKED_INSTALL = detectLinkedInstall();

// The demo repo behind the welcome screen's [d] key: a small API we clone and
// run setup on, for someone who wants to watch the whole flow before pointing
// it at their own code. SSH first, HTTPS as the fallback for a machine with no
// key loaded - see `lib/demo-repo.js`.
export const DEMO_REPO = 'restlesshq/demo';
export const DEMO_REPO_SSH_URL = `git@github.com:${DEMO_REPO}.git`;
export const DEMO_REPO_HTTPS_URL = `https://github.com/${DEMO_REPO}.git`;
