import fs from 'fs';
import path from 'path';
import { describeOasSource, isManagedSpec, oasSourceFacets } from './oas-source.js';
import { loadOas } from './oas-auth.js';
import { safeWriteFileSync } from './pathGuard.js';
import { bold, dim, green, yellow, cyan } from './ui.js';
import { CLI_NAME } from './config.js';

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
 *   rewritten    we wrote the new URL; push `oasFile` to publish it
 *   not-ours     it differs, and the spec is not ours to edit
 *   unreadable   we should have rewritten it but could not parse it
 */
export function syncSpecBaseUrl({ rootDir, apiEntry, baseUrl }) {
  const oasFile = apiEntry?.oasFile;
  if (!oasFile || !baseUrl) return { outcome: 'no-spec' };
  const abs = path.join(rootDir, oasFile);
  const owned = isManagedSpec(oasFile) && oasSourceFacets(apiEntry.oasSource?.kind).ownsServers;

  if (!owned) {
    let doc = null;
    try { doc = loadOas(abs); } catch {}
    const specUrl = doc?.servers?.[0]?.url ?? null;
    if (sameUrl(specUrl, baseUrl)) return { outcome: 'unchanged', oasFile };
    return { outcome: 'not-ours', oasFile, specUrl, source: describeOasSource(apiEntry.oasSource) };
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return { outcome: 'unreadable', oasFile, error: err.message };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { outcome: 'unreadable', oasFile, error: 'not an OpenAPI document' };
  }

  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const from = servers[0]?.url ?? null;
  if (sameUrl(from, baseUrl)) return { outcome: 'unchanged', oasFile };

  // Template variables belonged to the old URL. Left in place they would
  // describe placeholders the new URL does not have.
  const { variables, ...rest } = servers[0] || {};
  doc.servers = [{ ...rest, url: baseUrl }, ...servers.slice(1)];
  safeWriteFileSync(abs, `${JSON.stringify(doc, null, 2)}\n`);
  return { outcome: 'rewritten', oasFile, from };
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
