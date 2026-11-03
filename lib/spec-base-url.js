import fs from 'fs';
import path from 'path';
import { describeOasSource, isManagedSpec, oasSourceFacets } from './oas-source.js';
import { loadOas } from './oas-auth.js';
import { safeWriteFileSync } from './pathGuard.js';
import { bold, dim, green, yellow, cyan } from './ui.js';
import { CLI_NAME } from './config.js';

/**
 * The server URL the generator is told to write. Whatever produced the spec
 * swaps it for the real base URL afterwards; left in, docs and MCP calls would
 * go to example.com.
 */
export const PLACEHOLDER_DOMAIN = 'https://example.com';

/**
 * Carry a base URL change into the spec's `servers[0].url`.
 *
 * The settings `baseUrl` only labels the dashboard's Settings page. Docs,
 * try-it, docs chat and MCP calls all read the uploaded spec's `servers`, so a
 * base URL change that stops at settings.json leaves all of them on the old
 * host while `update` reports success.
 *
 * We only rewrite a spec we wrote (see `ownsServers`). A spec the developer
 * maintains, or one we copy from somewhere, would get the old URL back on its
 * next refresh, so for those we report what it says and leave the edit to
 * them.
 *
 * Outcomes:
 *   no-spec      nothing recorded to update
 *   unchanged    servers[0].url already matches
 *   rewritten    we wrote the new URL
 *   not-ours     it differs, and the spec is not ours to edit
 *   unreadable   we should have rewritten it but could not parse it
 *
 * `push` says the caller should upload `oasFile`. It is true for a spec we own
 * whether or not this call changed it: a rewrite whose upload failed, or a
 * spec someone fixed by hand, reads as `unchanged` locally while the
 * dashboard still has the old host, and the only way to know they agree is
 * to push.
 */
export function syncSpecBaseUrl({ rootDir, apiEntry, baseUrl }) {
  const oasFile = apiEntry?.oasFile;
  if (!oasFile || !baseUrl) return { outcome: 'no-spec', push: false };
  const abs = path.join(rootDir, oasFile);
  const owned = isManagedSpec(oasFile) && oasSourceFacets(apiEntry.oasSource?.kind).ownsServers;

  if (!owned) {
    let doc = null;
    try { doc = loadOas(abs); } catch {}
    const specUrl = doc?.servers?.[0]?.url ?? null;
    if (sameUrl(specUrl, baseUrl)) return { outcome: 'unchanged', oasFile, push: false };
    return { outcome: 'not-ours', oasFile, specUrl, source: describeOasSource(apiEntry.oasSource), push: false };
  }

  const res = writeServerUrl(abs, baseUrl);
  if (res.error) return { outcome: 'unreadable', oasFile, error: res.error, push: false };
  if (!res.changed) return { outcome: 'unchanged', oasFile, push: true };
  return { outcome: 'rewritten', oasFile, from: res.from, push: true };
}

/**
 * Set `servers[0].url` in a JSON spec on disk, keeping any other servers.
 * Returns `{ changed, from }`, or `{ error }` when the file is not a JSON
 * object.
 */
export function writeServerUrl(abs, url) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return { error: err.message };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { error: 'not an OpenAPI document' };

  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const from = servers[0]?.url ?? null;
  if (sameUrl(from, url)) return { changed: false, from };

  // Template variables belonged to the old URL. Left in place they would
  // describe placeholders the new URL does not have.
  const { variables, ...rest } = servers[0] || {};
  doc.servers = [{ ...rest, url }, ...servers.slice(1)];
  safeWriteFileSync(abs, `${JSON.stringify(doc, null, 2)}\n`);
  return { changed: true, from };
}

/**
 * Give a freshly generated spec the project's base URL.
 *
 * Setup does this once, after asking for the URL. A regenerate from `update`
 * has to do it too, or every refresh ships the placeholder. The placeholder
 * becomes the base URL, or "/" when there is none, the same as setup. With
 * `force`, servers[0].url is set to the base URL even if the model wrote
 * something else, because for a spec we own the setting is the answer.
 */
export function settleGeneratedServers(abs, baseUrl, { force = false } = {}) {
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch { return; }
  if (raw.includes(PLACEHOLDER_DOMAIN)) {
    safeWriteFileSync(abs, raw.replaceAll(PLACEHOLDER_DOMAIN, baseUrl || '/'));
  }
  if (force && baseUrl) writeServerUrl(abs, baseUrl);
}

function sameUrl(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return a.trim().replace(/\/+$/, '') === b.trim().replace(/\/+$/, '');
}

/**
 * What happened to the spec, for the terminal. Empty when there is nothing
 * to say. The warnings matter most: without them `update` says "synced" while
 * docs and MCP calls still use the old host.
 */
export function describeSpecBaseUrl(res) {
  const hint = dim(`  Docs, try-it and MCP calls use the spec's servers. Fix it there, then run ${cyan(`npx ${CLI_NAME} update --refresh`)}.`);
  if (res.outcome === 'rewritten') {
    return [`  ${green('✓')} Set servers[0].url in ${bold(res.oasFile)} to the new base URL.`];
  }
  if (res.outcome === 'not-ours') {
    const says = res.specUrl ? `still has servers[0].url ${bold(res.specUrl)}` : 'has no servers[0].url';
    return [`  ${yellow('!')} ${bold(res.oasFile)} ${says}. It's ${res.source}, so we didn't edit it.`, hint];
  }
  if (res.outcome === 'unreadable') {
    return [`  ${yellow('!')} Couldn't update servers[0].url in ${bold(res.oasFile)}: ${res.error}`, hint];
  }
  return [];
}
