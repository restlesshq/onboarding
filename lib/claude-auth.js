import { query } from '@anthropic-ai/claude-agent-sdk';
import * as debug from './debug.js';

const PROBE_TIMEOUT_MS = 10_000;

/**
 * True only when Claude Code has no credential at all. Bedrock, Vertex and
 * the other third-party backends authenticate outside it, so they never count.
 */
export function isSignedOut(info) {
  if (!info) return false;
  if (info.apiProvider && info.apiProvider !== 'firstParty') return false;
  return info.tokenSource === 'none' && !info.apiKeySource;
}

async function* idle() {
  await new Promise(() => {});
}

/**
 * Asks Claude Code who it is signed in as, without a model call (~0.3s signed
 * out, ~3s signed in). Fails open: anything but a clear "no credential" is false.
 */
export async function claudeSignedOut({ timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  let q;
  let timer;
  try {
    q = query({ prompt: idle(), options: { settingSources: ['user'] } });
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, null); });
    const info = await Promise.race([q.accountInfo(), timeout]);
    debug.log('claude-auth.probe', {
      timedOut: !info,
      tokenSource: info?.tokenSource,
      apiKeySource: info?.apiKeySource,
      apiProvider: info?.apiProvider,
    });
    return isSignedOut(info);
  } catch (err) {
    debug.log('claude-auth.probe', { error: err?.message || String(err) });
    return false;
  } finally {
    clearTimeout(timer);
    try { q?.close(); } catch {}
  }
}
