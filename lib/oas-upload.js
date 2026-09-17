import { gzipSync } from 'node:zlib';

/**
 * The one way this CLI sends a spec to `POST /api/projects/:id/oas`, used by
 * both the pre-claim staging path and the post-claim re-sync.
 *
 * The spec is the only request in a run whose duration tracks the size of the
 * user's API, and the upload is the slow half of it: a 2.9MB spec is ~3.4MB on
 * the wire once JSON escaping is paid for, which measured 8-16s on an ordinary
 * connection. So it blew a 10s abort before the server could answer, and the
 * server's actionable 413 was replaced by a bare timeout. Both fixes live here
 * rather than in either caller.
 */

/** Compressing a small body costs more than it saves, and small bodies were
 *  never what timed out. A real spec gzips about 8x. */
const GZIP_MIN_BYTES = 128 * 1024;

/** Covers uploading the body, not just waiting on the response - which is why
 *  10s was not enough. Shared, so `login` takes what `update` takes. */
export const OAS_UPLOAD_TIMEOUT_MS = 30000;

export async function postOas({
  url,
  payload,
  timeoutMs = OAS_UPLOAD_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const json = JSON.stringify(payload);
  const send = (compressed) =>
    fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(compressed ? { 'Content-Encoding': 'gzip' } : {}),
      },
      body: compressed ? gzipSync(Buffer.from(json, 'utf8')) : json,
      signal: AbortSignal.timeout(timeoutMs),
    });

  if (Buffer.byteLength(json, 'utf8') < GZIP_MIN_BYTES) return send(false);

  const res = await send(true);
  // Version skew, not flakiness: this CLI pins `@latest` and can land on a
  // deploy that predates gzip, which answers 415 (or 400, reading the bytes
  // as text). A genuine 400 costs one wasted upload and the same answer.
  if (res.status === 415 || res.status === 400) return send(false);
  return res;
}
